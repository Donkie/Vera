import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Review, preview, details, contextFor, addReviewCommands } from '../../src/js/review.mjs';
import { digest, transcript, publication } from '../../src/js/workflow.mjs';
import { publisher, reviewer, rows, analysis, candidate, commandFor, workflowFor, seedDraft, mockGitHub } from './support/fixtures.mjs';

function interactionFor(draft, { context = publisher, action = 'approve', suffix = '' } = {}) {
  return { user: { id: context.user, bot: !context.human }, guildId: context.guild, channelId: context.channel,
    customId: `${action}:${draft.id}:${draft.revision}:${digest(draft).slice(0, 20)}${suffix}`,
    isButton: () => true, isModalSubmit: () => false, isChatInputCommand: () => false,
    deferReply: mock.fn(async () => {}), editReply: mock.fn(async () => {}), reply: mock.fn(async () => {}) };
}

test('Discord interaction context distinguishes humans and Manage Server permission', () => {
  const permissions = { has: bit => bit === PermissionFlagsBits.ManageGuild };
  assert.deepEqual(contextFor({ user: { id: 'human', bot: false }, guildId: 'guild', channelId: 'review', memberPermissions: permissions }),
    { user: 'human', human: true, guild: 'guild', channel: 'review', manageGuild: true });
  assert.equal(contextFor({ user: { id: 'bot', bot: true } }).human, false);
});

test('preview suppresses mentions and requires full details for long issue approval', t => {
  const draft = seedDraft(workflowFor(t));
  draft.body = 'x'.repeat(7001);
  const card = preview(draft);
  assert.deepEqual(card.allowedMentions, { parse: [] });
  assert.equal(card.embeds[0].description.length, 3500);
  assert.equal(card.components[0].toJSON().components.find(b => b.label === 'Post issue').disabled, true);
  const body = [0, 1, 2].map(page => details(draft, [], page));
  assert.equal(body.map(page => page.embeds[0].description).join(''), draft.body);
  assert.ok(body[2].components[0].toJSON().components.some(b => b.custom_id.endsWith(':reviewed')));
  assert.throws(() => details(draft, [], -1), /Invalid detail page/);
});

test('approval button runs the real workflow against a mocked GitHub publisher', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  const announce = mock.fn(async () => {}), review = new Review(workflow, () => github, announce);
  const interaction = interactionFor(draft);
  assert.equal(await review.handle(interaction), true);
  assert.equal(workflow.get(draft.id).state, 'published');
  assert.equal(github.create.mock.callCount(), 1);
  assert.match(interaction.editReply.mock.calls[0].arguments[0].content, /GitHub issue:/);
  assert.equal(announce.mock.callCount(), 1);
});

test('disabled GitHub hides posting controls on cards and details, and rejects old controls', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  const review = new Review(workflow, () => github, async () => {}, false);
  const actions = payload => payload.components.flatMap(row => row.toJSON().components).map(b => b.custom_id.split(':')[0]);
  for (const state of ['ready', 'uncertain']) {
    assert.ok(!actions(preview({ ...draft, state }, [], false)).some(action => ['approve', 'reconcile'].includes(action)));
  }
  assert.ok(!actions(details(draft, [], 0, false)).includes('approve'));
  assert.ok(!actions(preview({ ...draft, repo: null, mode: 'local' })).includes('approve'));
  assert.ok(!actions(details({ ...draft, repo: null, mode: 'local' })).includes('approve'));
  const commands = addReviewCommands(new SlashCommandBuilder(), false).options.map(option => option.name);
  assert.ok(!commands.includes('reconcile'));
  for (const action of ['approve', 'reconcile']) {
    const old = interactionFor(draft, { action });
    await review.handle(old);
    assert.match(old.reply.mock.calls[0].arguments[0].content, /GitHub publishing is disabled/);
  }
  const reconcile = commandFor('reconcile', { id: draft.id }, publisher);
  await review.handle(reconcile);
  assert.match(reconcile.reply.mock.calls[0].arguments[0].content, /GitHub publishing is disabled/);
  const open = commandFor('draft', { id: draft.id });
  await review.handle(open);
  assert.ok(!actions(open.editReply.mock.calls[0].arguments[0]).includes('approve'));
  const full = { ...interactionFor(draft, { context: reviewer, action: 'details' }), message: { flags: { has: () => false } } };
  await review.handle(full);
  assert.ok(!actions(full.editReply.mock.calls[0].arguments[0]).includes('approve'));
  assert.equal(github.create.mock.callCount(), 0);
  assert.equal(github.list.mock.callCount(), 0);
  assert.equal(workflow.get(draft.id).state, 'ready');
});

test('review refuses unauthorized and stale approval buttons before posting', async t => {
  const workflow = workflowFor(t), draft = seedDraft(workflow), github = mockGitHub();
  const review = new Review(workflow, () => github, async () => {});
  const denied = interactionFor(draft, { context: reviewer });
  await review.handle(denied);
  assert.match(denied.reply.mock.calls[0].arguments[0].content, /publisher access/);
  workflow.edit(reviewer, draft.id, draft.revision, 'New title', draft.description);
  const stale = interactionFor(draft);
  await review.handle(stale);
  assert.match(stale.reply.mock.calls[0].arguments[0].content, /stale/);
  assert.equal(github.create.mock.callCount(), 0);
});

test('long issue cannot publish until its full preview has been opened', async t => {
  const workflow = workflowFor(t), original = seedDraft(workflow), github = mockGitHub();
  const draft = workflow.edit(reviewer, original.id, original.revision, original.title, 'x'.repeat(3450));
  assert.ok(draft.body.length > 3500);
  const review = new Review(workflow, () => github, async () => {}), interaction = interactionFor(draft);
  await review.handle(interaction);
  assert.match(interaction.editReply.mock.calls[0].arguments[0].content, /Read the full issue/);
  assert.equal(github.create.mock.callCount(), 0);
  await review.handle(interactionFor(draft, { suffix: ':reviewed' }));
  assert.equal(github.create.mock.callCount(), 1);
});

function reviewFor(t) {
  const workflow = workflowFor(t), github = mockGitHub(), announce = mock.fn(async () => {});
  return { workflow, github, announce, review: new Review(workflow, () => github, announce) };
}

function modalFor(form, values) {
  return { ...commandFor(''), isChatInputCommand: () => false, isModalSubmit: () => true,
    customId: form.toJSON().custom_id, fields: { getTextInputValue: key => values[key] } };
}

test('/vera edit opens current content and its modal saves a corrected revision with original quotes', async t => {
  const { workflow, github, review, announce } = reviewFor(t), draft = seedDraft(workflow);
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  const edit = commandFor('edit', { id: draft.id });
  await review.handle(edit);
  const form = edit.showModal.mock.calls[0].arguments[0];
  const fields = form.toJSON().components.map(row => row.components[0]);
  assert.equal(fields.find(field => field.custom_id === 'description').value, draft.description);
  assert.equal(fields.find(field => field.custom_id === 'evidence').value, draft.evidence[0].id);
  const submit = modalFor(form, { title: 'Corrected title', description: 'Confirmed by a developer.',
    evidence: '', duplicates: '17, 17, 18', heading: 'Original quotations' });
  await review.handle(submit);
  const updated = workflow.get(draft.id);
  assert.equal(updated.title, 'Corrected title');
  assert.equal(updated.description, 'Confirmed by a developer.');
  assert.equal(updated.approval, null);
  assert.equal(updated.state, 'ready');
  assert.deepEqual(updated.duplicates, [17, 18]);
  assert.deepEqual(updated.evidence, draft.evidence);
  assert.match(updated.body, /### Original quotations/);
  assert.equal(announce.mock.callCount(), 1);
  assert.equal(github.create.mock.callCount(), 0);
});

test('comment button/modal adds review history without changing the issue or approving it', async t => {
  const { workflow, github, review } = reviewFor(t), draft = seedDraft(workflow);
  const button = { ...interactionFor(draft, { action: 'note' }), showModal: mock.fn(async () => {}) };
  await review.handle(button);
  const modal = modalFor(button.showModal.mock.calls[0].arguments[0], { text: 'Please verify this on Windows.' });
  await review.handle(modal);
  assert.equal(workflow.history(draft.id).at(-1).detail, 'Please verify this on Windows.');
  assert.equal(workflow.get(draft.id).body, draft.body);
  assert.equal(workflow.get(draft.id).state, 'ready');
  assert.equal(github.create.mock.callCount(), 0);
});

test('/vera access grants and revokes publishing only for a human with Manage Server', async t => {
  const { workflow, review } = reviewFor(t), target = { id: 'new-publisher', bot: false };
  const denied = commandFor('access', { user: target, role: 'publisher' });
  await review.handle(denied);
  assert.match(denied.reply.mock.calls[0].arguments[0].content, /Manage Server/);
  assert.equal(workflow.role(target.id), 'none');
  for (const role of ['publisher', 'reviewer', 'none']) {
    const interaction = commandFor('access', { user: target, role }, { ...reviewer, manageGuild: true });
    await review.handle(interaction);
    assert.equal(workflow.role(target.id), role);
    assert.match(interaction.reply.mock.calls[0].arguments[0].content, new RegExp(`\\*\\*${role}\\*\\*`));
    assert.deepEqual(interaction.reply.mock.calls[0].arguments[0].allowedMentions, { parse: [] });
  }
  const self = commandFor('access'); await review.handle(self);
  assert.match(self.reply.mock.calls[0].arguments[0].content, /\*\*reviewer\*\*/);
  const bot = commandFor('access', { user: { id: 'robot', bot: true }, role: 'publisher' }, { ...reviewer, manageGuild: true });
  await review.handle(bot);
  assert.match(bot.reply.mock.calls[0].arguments[0].content, /only be granted to a human/);
  assert.equal(workflow.role('robot'), 'none');
});

test('/vera merge combines two drafts and invalidates approval on both', async t => {
  const { workflow, review, github } = reviewFor(t), first = seedDraft(workflow);
  const segments = transcript([{ ...rows[0], start: 3, end: 4, text: 'The save shortcut also fails.' }]);
  const result = analysis(segments.map(row => row.id));
  result.candidates[0].key = 'save-shortcut'; result.candidates[0].description = 'The shortcut fails too.';
  workflow.applyAnalysis('session', segments, segments.map(row => row.id), result, [], 0);
  workflow.settle(60_000);
  const second = workflow.list().find(draft => draft.id !== first.id);
  for (const draft of [first, second]) workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  await review.handle(commandFor('merge', { keep: first.id, remove: second.id }));
  const merged = workflow.get(first.id), removed = workflow.get(second.id);
  assert.match(merged.description, /The save button does not work\.[\s\S]*The shortcut fails too\./);
  assert.equal(merged.evidence.length, 2);
  assert.equal(merged.approval, null);
  assert.equal(merged.state, 'ready');
  assert.equal(removed.state, 'merged');
  assert.equal(removed.merged_into, first.id);
  assert.equal(removed.approval, null);
  assert.equal(github.create.mock.callCount(), 0);
});

for (const source of ['command', 'button']) {
  test(`reject ${source} cancels approval and removes the publishing action`, async t => {
    const { workflow, review, github } = reviewFor(t), draft = seedDraft(workflow);
    workflow.approve(publisher, draft.id, draft.revision, digest(draft));
    await review.handle(source === 'command' ? commandFor('reject', { id: draft.id }) : interactionFor(draft, { action: 'reject' }));
    const rejected = workflow.get(draft.id);
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.approval, null);
    assert.ok(!preview(rejected).components[0].toJSON().components.some(button => button.label === 'Post issue'));
    assert.equal(github.create.mock.callCount(), 0);
  });
}

test('/vera drafts paginates all results and private buttons update the existing reply', async t => {
  const { workflow, review } = reviewFor(t), segments = transcript(rows), evidence = segments.map(row => row.id);
  const candidates = Array.from({ length: 25 }, (_, index) => ({ ...candidate(evidence), key: `topic-${index}`, title: `${index}: ${'x'.repeat(170)}` }));
  workflow.applyAnalysis('session', segments, evidence, { ...analysis(), candidates }, [], 0);
  workflow.settle(60_000);
  const first = commandFor('drafts'); await review.handle(first);
  const page = first.editReply.mock.calls[0].arguments[0];
  assert.match(page.embeds[0].footer.text, /Page 1\/2/);
  const next = { ...commandFor(''), isChatInputCommand: () => false, isButton: () => true,
    customId: page.components[0].toJSON().components[1].custom_id, message: { flags: { has: () => true } } };
  await review.handle(next);
  assert.equal(next.deferUpdate.mock.callCount(), 1);
  assert.equal(next.deferReply.mock.callCount(), 0);
  const contents = page.embeds[0].description + next.editReply.mock.calls[0].arguments[0].embeds[0].description;
  for (const draft of workflow.list()) assert.equal(contents.split(draft.id).length - 1, 1);
});

test('/vera draft, details and summary expose the saved review content privately', async t => {
  const { workflow, review } = reviewFor(t), draft = seedDraft(workflow);
  const open = commandFor('draft', { id: draft.id }); await review.handle(open);
  assert.equal(open.deferReply.mock.calls[0].arguments[0].flags, 64);
  assert.equal(open.editReply.mock.calls[0].arguments[0].embeds[0].description, draft.body);
  const detail = { ...interactionFor(draft, { action: 'details', suffix: ':0' }), message: { flags: { has: () => true } },
    deferUpdate: mock.fn(async () => {}) };
  await review.handle(detail);
  assert.equal(detail.deferUpdate.mock.callCount(), 1);
  assert.equal(detail.editReply.mock.calls[0].arguments[0].embeds[0].description, draft.body);
  const summary = commandFor('summary', { session: 'session' }); await review.handle(summary);
  assert.equal(summary.editReply.mock.calls[0].arguments[0].embeds[0].description, workflow.session('session').summary);
  const missing = commandFor('summary', { session: 'missing' }); await review.handle(missing);
  assert.match(missing.editReply.mock.calls[0].arguments[0].content, /Session not found/);
});

test('/vera reconcile recovers an uncertain publication without another GitHub POST', async t => {
  const { workflow, review, github } = reviewFor(t), draft = seedDraft(workflow);
  workflow.approve(publisher, draft.id, draft.revision, digest(draft));
  github.create.mock.mockImplementation(async () => { throw new Error('Connection lost'); });
  await assert.rejects(workflow.publish(draft.id, github));
  github.list.mock.mockImplementation(async () => [{ ...publication(draft), html_url: `https://github.com/${draft.repo}/issues/42` }]);
  await review.handle(commandFor('reconcile', { id: draft.id }, publisher));
  assert.equal(workflow.get(draft.id).state, 'published');
  assert.equal(github.create.mock.callCount(), 1);
  assert.equal(github.list.mock.callCount(), 1);
});
