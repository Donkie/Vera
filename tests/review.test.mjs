import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { Review, preview, details, contextFor } from '../review.mjs';
import { digest } from '../workflow.mjs';
import { publisher, reviewer, workflowFor, seedDraft, mockGitHub } from './support/fixtures.mjs';

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
