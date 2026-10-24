import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { digest, text } from './workflow.mjs';

export const contextFor = interaction => ({ user: interaction.user.id, human: !interaction.user.bot, guild: interaction.guildId, channel: interaction.channelId,
  manageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true });
const mutable = ['settling', 'ready', 'rejected', 'withdrawn', 'approved'];
const token = draft => `${draft.id}:${draft.revision}:${digest(draft).slice(0, 20)}`;
const button = (action, draft, label, style = ButtonStyle.Secondary, suffix = '') => new ButtonBuilder()
  .setCustomId(`${action}:${token(draft)}${suffix}`).setLabel(label).setStyle(style);
const approveButton = (draft, reviewed = false) => button('approve', draft, 'Post issue', ButtonStyle.Success, reviewed ? ':reviewed' : '')
  .setDisabled(!reviewed && draft.body.length > 3500);
const heading = draft => `Draft \`${draft.id}\` · **${draft.state}** · r${draft.revision} · ${draft.repo || 'No repository'} · ${draft.language} · **${draft.mode.toUpperCase()}**${draft.mode === 'github' && draft.label ? `\nGitHub label: ${escapeMarkdown(draft.label)}` : ''}${draft.url ? `\n<${draft.url}>` : ''}`;

export function preview(draft, history = [], publishingEnabled = true) {
  const buttons = [];
  if (publishingEnabled && draft.mode === 'github' && draft.state === 'ready') buttons.push(approveButton(draft));
  if (mutable.includes(draft.state)) buttons.push(button('edit', draft, 'Edit'));
  buttons.push(button('note', draft, 'Comment'));
  if (['ready', 'settling', 'approved'].includes(draft.state)) buttons.push(button('reject', draft, 'Reject', ButtonStyle.Danger));
  if (publishingEnabled && draft.mode === 'github' && ['publishing', 'uncertain'].includes(draft.state)) buttons.push(button('reconcile', draft, 'Check publication'));
  buttons.push(button('details', draft, 'Details & history', ButtonStyle.Secondary, ':0'));
  return {
    content: heading(draft) + (draft.body.length > 3500 ? '\nOpen Details to read the full issue.' : ''),
    embeds: [{ title: draft.title, description: draft.body.slice(0, 3500), footer: { text: `Revision ${draft.revision} · ${history.filter(e => e.action === 'comment').length} comments` } }],
    components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { parse: [] },
  };
}

function pages(value) {
  const result = [];
  while (value.length > 3500) {
    let end = value.lastIndexOf('\n', 3500);
    if (end < 1750) end = 3500;
    if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    result.push(value.slice(0, end)); value = value.slice(end);
  }
  result.push(value || 'No content.');
  return result;
}
export function details(draft, history = [], page = 0, publishingEnabled = true) {
  const bodyPages = pages(draft.body);
  const entries = history.map(e => `${e.at} · ${e.user} · ${e.action}${typeof e.detail === 'string' ? `\n${e.detail}` : e.detail?.revision ? ` · revision ${e.detail.revision}${e.detail.request ? `\n${e.detail.request}` : ''}` : ''}`);
  const all = [...bodyPages.map(text => ({ text, section: 'Full issue' })), ...pages(entries.join('\n\n') || 'No review history yet.').map(text => ({ text, section: 'Review history' }))];
  if (!Number.isSafeInteger(page) || page < 0 || page >= all.length) throw new Error('Invalid detail page');
  const buttons = [button('details', draft, 'Previous', ButtonStyle.Secondary, `:${page - 1}`).setDisabled(page === 0),
    button('details', draft, 'Next', ButtonStyle.Secondary, `:${page + 1}`).setDisabled(page === all.length - 1)];
  if (publishingEnabled && draft.mode === 'github' && draft.state === 'ready' && page === bodyPages.length - 1) buttons.push(approveButton(draft, true));
  return { content: heading(draft), embeds: [{ title: draft.title, description: all[page].text,
    footer: { text: `${all[page].section} · page ${page + 1}/${all.length} · revision ${draft.revision}` } }],
    components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { parse: [] } };
}

export function addReviewCommands(command, publishingEnabled = true) {
  command.addSubcommand(s => s.setName('access').setDescription('Check your access; Manage Server members can grant or revoke it')
    .addUserOption(o => o.setName('user').setDescription('Person whose Vera access to check or change'))
    .addStringOption(o => o.setName('role').setDescription('Access to grant; none revokes access').addChoices(
      { name: 'Reviewer — record, edit, comment, reject', value: 'reviewer' },
      { name: 'Publisher — reviewer plus issue publishing', value: 'publisher' }, { name: 'None — revoke access', value: 'none' })));
  command.addSubcommand(s => s.setName('drafts').setDescription('List issue drafts'));
  command.addSubcommand(s => s.setName('draft').setDescription('Read a draft and its action buttons').addStringOption(o => o.setName('id').setDescription('Draft ID').setRequired(true)));
  command.addSubcommand(s => s.setName('edit').setDescription('Ask the AI to revise a draft; approval will be invalidated').addStringOption(o => o.setName('id').setDescription('Draft ID').setRequired(true)));
  command.addSubcommand(s => s.setName('note').setDescription('Comment on a draft (not automatically published)').addStringOption(o => o.setName('id').setDescription('Draft ID').setRequired(true)).addStringOption(o => o.setName('text').setDescription('Developer comment').setMaxLength(2000).setRequired(true)));
  command.addSubcommand(s => s.setName('merge').setDescription('Combine two drafts and require a fresh approval').addStringOption(o => o.setName('keep').setDescription('Draft ID to keep').setRequired(true)).addStringOption(o => o.setName('remove').setDescription('Draft ID to merge into it').setRequired(true)));
  command.addSubcommand(s => s.setName('reject').setDescription('Reject a draft without creating an issue').addStringOption(o => o.setName('id').setDescription('Draft ID').setRequired(true)));
  if (publishingEnabled) command.addSubcommand(s => s.setName('reconcile').setDescription('Look up an uncertain publication; never retries issue creation').addStringOption(o => o.setName('id').setDescription('Draft ID').setRequired(true)));
  command.addSubcommand(s => s.setName('summary').setDescription('Read a session summary').addStringOption(o => o.setName('session').setDescription('Session ID').setRequired(true)));
  return command;
}

export class Review {
  constructor(workflow, publisherFor, announce, publishingEnabled = true, rewriter) { Object.assign(this, { workflow, publisherFor, announce, publishingEnabled, rewriter }); }
  async handle(interaction) {
    const buttonAction = interaction.isButton() ? interaction.customId.split(':')[0] : null;
    const modalAction = interaction.isModalSubmit() ? interaction.customId.split(':')[0] : null;
    const buttonHandled = ['approve', 'edit', 'note', 'reject', 'details', 'reconcile', 'drafts'].includes(buttonAction);
    const modalHandled = ['edit', 'note'].includes(modalAction);
    const action = interaction.isChatInputCommand() && interaction.commandName === 'vera' ? interaction.options.getSubcommand() : null;
    if (!buttonHandled && !modalHandled && !['access', 'drafts', 'draft', 'edit', 'note', 'merge', 'reject', 'reconcile', 'summary'].includes(action)) return false;
    let deferred = false;
    try {
      const context = contextFor(interaction);
      if (!this.publishingEnabled && (['approve', 'reconcile'].includes(buttonAction) || action === 'reconcile')) throw new Error('GitHub publishing is disabled; configure GITHUB_REPO and GITHUB_TOKEN and restart Vera');
      if (action === 'access') {
        this.workflow.authorizeChannel(context);
        const target = interaction.options.getUser('user') || interaction.user;
        const role = interaction.options.getString('role');
        if (target.bot) throw new Error('Vera access can only be granted to a human');
        if (role) this.workflow.setAccess(context, target.id, role);
        await interaction.reply({ content: `Vera access for <@${target.id}>: **${this.workflow.role(target.id)}**.\nReviewers can record and review. Publishers can also post issues. Members with Manage Server can change access using /vera access user:@person role:publisher (or reviewer / none).`, flags: 64, allowedMentions: { parse: [] } });
        return true;
      }
      this.workflow.authorize(context, buttonAction === 'approve' || buttonAction === 'reconcile' || action === 'reconcile');
      let draft;
      if ((buttonHandled && buttonAction !== 'drafts') || modalHandled) {
        const [, id, revision, prefix] = interaction.customId.split(':');
        draft = this.workflow.get(id);
        if (draft.revision !== Number(revision) || (prefix && digest(draft).slice(0, 20) !== prefix)) throw new Error('That preview is stale; reopen the current draft');
      }
      if (action === 'edit' || buttonAction === 'edit') {
        draft ||= this.workflow.get(interaction.options.getString('id', true));
        if (!mutable.includes(draft.state)) throw new Error('Publication has started or this draft is closed');
        const form = new ModalBuilder().setCustomId(`edit:${token(draft)}`).setTitle('Revise issue draft with AI').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prompt').setLabel('What should the AI change?').setStyle(TextInputStyle.Paragraph).setMaxLength(2000)
            .setPlaceholder('e.g. "crash" was misheard as "cache"; mention it only happens on Windows')));
        await interaction.showModal(form); return true;
      }
      if (buttonAction === 'note') {
        const form = new ModalBuilder().setCustomId(`note:${token(draft)}`).setTitle('Comment on draft').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Developer comment (kept in review history)').setStyle(TextInputStyle.Paragraph).setMaxLength(2000)));
        await interaction.showModal(form); return true;
      }
      if (['details', 'drafts'].includes(buttonAction) && interaction.message?.flags.has(64)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: 64 });
      deferred = true;
      if (buttonAction === 'details') {
        const page = Number(interaction.customId.split(':')[4] || 0);
        await interaction.editReply(details(draft, this.workflow.history(draft.id), page, this.publishingEnabled));
      } else if (buttonAction === 'approve') {
        if (draft.body.length > 3500 && interaction.customId.split(':')[4] !== 'reviewed') throw new Error('Read the full issue in Details before approving');
        this.workflow.approve(context, draft.id, draft.revision, digest(draft));
        const url = await this.workflow.publish(draft.id, this.publisherFor(draft.mode, draft.repo));
        await interaction.editReply({ content: `GitHub issue: <${url}>`, components: [], embeds: [] });
        await this.announce(this.workflow.get(draft.id));
      } else if (modalAction === 'edit') {
        if (!mutable.includes(draft.state)) throw new Error('Publication has started or this draft is closed');
        const prompt = text(interaction.fields.getTextInputValue('prompt'), 'edit request', 2000);
        const { title, description } = await this.rewriter.rewrite({ language: draft.language, prompt, title: draft.title, description: draft.description, evidence: draft.evidence });
        // workflow.edit rechecks the revision, so a draft changed during the model call is not overwritten.
        const updated = this.workflow.edit(context, draft.id, draft.revision, title, description, prompt);
        await interaction.editReply({ content: 'Draft updated. Review the new version in the channel.' });
        await this.announce(updated);
      } else if (modalAction === 'note') {
        this.workflow.note(context, draft.id, interaction.fields.getTextInputValue('text'));
        await interaction.editReply({ content: 'Comment saved in review history.' });
        await this.announce(this.workflow.get(draft.id));
      } else if (buttonAction === 'reject') {
        const rejected = this.workflow.reject(context, draft.id);
        await interaction.editReply({ content: 'Draft rejected.', components: [], embeds: [] }); await this.announce(rejected);
      } else if (action === 'drafts' || buttonAction === 'drafts') {
        const lines = this.workflow.list().map(d => `\`${d.id}\` r${d.revision} · ${d.state} · ${d.title}`);
        const list = pages(lines.join('\n') || 'No drafts yet.');
        const page = Number(interaction.customId?.split(':')[1] || 0);
        if (!Number.isSafeInteger(page) || page < 0 || page >= list.length) throw new Error('Invalid draft list page');
        await interaction.editReply({ content: 'Open a draft with /vera draft.', embeds: [{ title: 'Drafts', description: list[page], footer: { text: `Page ${page + 1}/${list.length}` } }],
          components: list.length > 1 ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`drafts:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`drafts:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === list.length - 1))] : [] });
      } else if (action === 'summary') {
        const session = this.workflow.session(interaction.options.getString('session', true));
        if (!session) throw new Error('Session not found');
        await interaction.editReply({ content: `Summary · ${session.language}`, embeds: pages(session.summary || 'No analysis yet.').map(description => ({ description })) });
      } else {
        const id = draft?.id || interaction.options.getString(action === 'merge' ? 'keep' : 'id', true);
        if (action === 'note') this.workflow.note(context, id, interaction.options.getString('text', true));
        if (action === 'reject') this.workflow.reject(context, id);
        if (action === 'merge') this.workflow.merge(context, id, interaction.options.getString('remove', true));
        if (action === 'reconcile' || buttonAction === 'reconcile') {
          const current = this.workflow.get(id);
          if (!['uncertain', 'publishing', 'published'].includes(current.state)) throw new Error('There is no uncertain publication to reconcile');
          await this.workflow.publish(id, this.publisherFor(current.mode, current.repo));
        }
        const current = this.workflow.get(id);
        await interaction.editReply(action === 'draft' ? preview(current, this.workflow.history(id), this.publishingEnabled) : { content: `Draft ${current.state}.`, components: [], embeds: [] });
        if (action !== 'draft') await this.announce(current);
      }
    } catch (error) {
      const payload = { content: `Vera: ${error.message}`, components: [], embeds: [], allowedMentions: { parse: [] } };
      if (deferred) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: 64 });
    }
    return true;
  }
}
