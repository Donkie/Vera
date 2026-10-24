import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../../src/js/runtime.mjs';
import { settings, policy, seedDraft, commandFor } from './support/fixtures.mjs';
import { digest } from '../../src/js/workflow.mjs';

test('runtime wires Discord review to mocked GitHub HTTP and updates existing preview messages', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vera-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fetcher = t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ ...JSON.parse(options.body),
    number: 42, html_url: `https://github.com/${settings.repo}/issues/42` }));
  const message = { id: 'message', guildId: policy.guild, channelId: policy.channel, author: { id: 'bot', bot: true },
    edit: mock.fn(async () => message) };
  const remove = mock.fn(async () => { throw new Error('Missing reaction permissions'); });
  const leave = mock.fn();
  message.reactions = { cache: new Map([
    ['own', { me: true, emoji: { name: '✅' }, users: { remove } }],
    ['human', { me: false, emoji: { name: '❌' }, users: { remove: leave } }],
    ['other', { me: true, emoji: { name: '👍' }, users: { remove: leave } }],
  ]) };
  const channel = { send: mock.fn(async () => message), messages: { fetch: mock.fn(async () => message) } };
  const client = { channels: { fetch: mock.fn(async () => channel) } };
  const runtime = createWorkflow({ root, client, guildId: policy.guild, textId: policy.channel, env: {
    LLM_PROVIDER: 'ollama', GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'mock-token',
  } });
  t.after(() => { runtime.stop(); runtime.workflow.close(); });
  const user = '123456789012345678';
  runtime.workflow.setAccess({ user, human: true, guild: policy.guild, channel: policy.channel, manageGuild: true }, user, 'publisher');
  runtime.workflow.openSession('session', settings);
  const draft = seedDraft(runtime.workflow);
  const base = { user: { id: user, bot: false }, guildId: policy.guild, channelId: policy.channel,
    isButton: () => true, isModalSubmit: () => false, isChatInputCommand: () => false,
    deferReply: mock.fn(async () => {}), editReply: mock.fn(async () => {}), reply: mock.fn(async () => {}) };
  await runtime.review.handle({ ...base, customId: `approve:${draft.id}:${draft.revision}:${digest(draft).slice(0, 20)}` });
  assert.equal(runtime.workflow.get(draft.id).state, 'published');
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(fetcher.mock.calls[0].arguments[1].method, 'POST');
  assert.equal(channel.send.mock.callCount(), 1);
  assert.equal(runtime.workflow.previewForDraft(draft.id).messageId, message.id);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(leave.mock.callCount(), 0);

  await runtime.review.handle({ ...base, isButton: () => false, isChatInputCommand: () => true, commandName: 'vera',
    options: { getSubcommand: () => 'note', getString: key => key === 'id' ? draft.id : 'Reviewed with the team.' } });
  assert.equal(message.edit.mock.callCount(), 1);
  assert.equal(channel.send.mock.callCount(), 1);
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(runtime.workflow.history(draft.id).at(-1).action, 'comment');
});

for (const code of [10008, 50013]) {
  test(`preview recovery ${code === 10008 ? 'recreates a deleted message' : 'preserves identity on a permission failure'}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'vera-preview-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const user = '123456789012345678';
    const message = { id: 'replacement', guildId: policy.guild, channelId: policy.channel, author: { id: 'bot', bot: true } };
    const channel = { send: mock.fn(async () => message), messages: { fetch: mock.fn(async () => {
      throw Object.assign(new Error('Discord request failed'), { code });
    }) } };
    const runtime = createWorkflow({ root, client: { channels: { fetch: async () => channel } }, guildId: policy.guild, textId: policy.channel,
      env: { GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'mock-token', DISCORD_CONTROLLER_IDS: user } });
    t.after(() => { runtime.stop(); runtime.workflow.close(); });
    runtime.workflow.openSession('session', settings);
    const draft = seedDraft(runtime.workflow);
    runtime.workflow.registerPreview({ ...message, id: 'original' }, draft);
    const interaction = commandFor('note', { id: draft.id, text: 'Check the screenshot.' }, { user, human: true, guild: policy.guild, channel: policy.channel });
    await runtime.review.handle(interaction);
    assert.equal(runtime.workflow.history(draft.id).at(-1).action, 'comment');
    assert.equal(channel.send.mock.callCount(), code === 10008 ? 1 : 0);
    assert.equal(runtime.workflow.previewForDraft(draft.id).messageId, code === 10008 ? 'replacement' : 'original');
    if (code !== 10008) assert.match(interaction.editReply.mock.calls.at(-1).arguments[0].content, /Discord request failed/);
  });
}
