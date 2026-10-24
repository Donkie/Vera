import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../runtime.mjs';
import { settings, policy, seedDraft } from './support/fixtures.mjs';
import { digest } from '../workflow.mjs';

test('runtime wires Discord review to mocked GitHub HTTP and updates existing preview messages', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vera-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fetcher = t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ ...JSON.parse(options.body),
    number: 42, html_url: `https://github.com/${settings.repo}/issues/42` }));
  const message = { id: 'message', guildId: policy.guild, channelId: policy.channel, author: { id: 'bot', bot: true },
    edit: mock.fn(async () => message) };
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

  await runtime.review.handle({ ...base, isButton: () => false, isChatInputCommand: () => true, commandName: 'vera',
    options: { getSubcommand: () => 'note', getString: key => key === 'id' ? draft.id : 'Reviewed with the team.' } });
  assert.equal(message.edit.mock.callCount(), 1);
  assert.equal(channel.send.mock.callCount(), 1);
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(runtime.workflow.history(draft.id).at(-1).action, 'comment');
});
