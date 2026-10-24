import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../../src/js/runtime.mjs';
import { settings, policy, rows, analysis, seedDraft, commandFor, githubAccessResponse, startupResponse } from './support/fixtures.mjs';
import { digest } from '../../src/js/workflow.mjs';
import { writeJson } from '../../src/js/audio.mjs';

test('runtime wires Discord review to mocked GitHub HTTP and updates existing preview messages', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vera-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fetcher = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'http://localhost:11434/api/chat') return startupResponse(url, options);
    if (options.method !== 'POST' || options.body === '{"title":""}') return githubAccessResponse(url, options);
    return Response.json({ ...JSON.parse(options.body), number: 42, html_url: `https://github.com/${settings.repo}/issues/42` });
  });
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
  const runtime = await createWorkflow({ root, client, guildId: policy.guild, textId: policy.channel, env: {
    LLM_PROVIDER: 'ollama', GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'mock-token',
  } });
  assert.equal(runtime.publishingEnabled, true);
  assert.equal(fetcher.mock.callCount(), 4);
  fetcher.mock.resetCalls();
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

test('configured labels flow from new transcripts through Discord approval to GitHub', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vera-labeled-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'session'), run = join(directory, 'recognitions', 'live');
  mkdirSync(run, { recursive: true });
  writeJson(join(directory, 'session.json'), { session_id: 'session', status: 'stopped' });
  writeJson(join(run, 'transcript.json'), rows);
  const fetcher = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/labels/vera%3Araw')) return Response.json({ name: 'vera:raw' });
    if (url === `https://api.github.com/repos/${settings.repo}/issues?state=all&per_page=100&page=1`) return Response.json([]);
    if (url === 'http://localhost:11434/api/chat' && JSON.parse(JSON.parse(options.body).messages.at(-1).content).conversation[0].text !== 'Hello.') {
      return Response.json({ done: true, message: { content: JSON.stringify(analysis()) } });
    }
    if (url === `https://api.github.com/repos/${settings.repo}/issues` && options.body !== '{"title":""}') {
      const payload = JSON.parse(options.body);
      return Response.json({ ...payload, labels: payload.labels.map(name => ({ name })), html_url: `https://github.com/${settings.repo}/issues/42` });
    }
    return startupResponse(url, options);
  });
  let announced;
  const firstPreview = new Promise(resolve => { announced = resolve; });
  const message = { id: 'preview', guildId: policy.guild, channelId: policy.channel, author: { id: 'bot', bot: true }, edit: async () => message };
  const channel = { send: async payload => { announced(payload); return message; }, messages: { fetch: async () => message } };
  const runtime = await createWorkflow({ root, client: { channels: { fetch: async () => channel } }, guildId: policy.guild, textId: policy.channel,
    env: { LLM_PROVIDER: 'ollama', GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'test-token', GITHUB_ISSUE_LABEL: ' vera:raw ' } });
  t.after(() => { runtime.stop(); runtime.workflow.close(); });
  runtime.start();
  const preview = await firstPreview;
  await new Promise(setImmediate);
  assert.match(preview.content, /GitHub label: vera:raw/);
  assert.equal(runtime.workflow.session('session').label, 'vera:raw');
  const user = '123456789012345678';
  runtime.workflow.setAccess({ user, human: true, guild: policy.guild, channel: policy.channel, manageGuild: true }, user, 'publisher');
  const draft = runtime.workflow.list()[0];
  await runtime.review.handle({ ...commandFor('', {}, { user, human: true, guild: policy.guild, channel: policy.channel }),
    isChatInputCommand: () => false, isButton: () => true, customId: `approve:${draft.id}:${draft.revision}:${digest(draft).slice(0, 20)}` });
  assert.equal(runtime.workflow.get(draft.id).state, 'published');
  const creations = fetcher.mock.calls.filter(call => call.arguments[0].endsWith('/issues') && call.arguments[1].body !== '{"title":""}');
  assert.equal(creations.length, 1);
  assert.deepEqual(JSON.parse(creations[0].arguments[1].body).labels, ['vera:raw']);
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
    t.mock.method(globalThis, 'fetch', startupResponse);
    const runtime = await createWorkflow({ root, client: { channels: { fetch: async () => channel } }, guildId: policy.guild, textId: policy.channel,
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

for (const env of [{}, { GITHUB_REPO: ' ', GITHUB_TOKEN: '' }, { GITHUB_ISSUE_LABEL: 'vera:raw' }]) {
  test(`missing GitHub settings warn and refresh saved controls without publishing (${JSON.stringify(env)})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'vera-local-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const warning = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const fetcher = t.mock.method(globalThis, 'fetch', startupResponse);
    let edited;
    const refreshed = new Promise(resolve => { edited = resolve; });
    const message = { id: 'old-preview', guildId: policy.guild, channelId: policy.channel, author: { bot: true, id: 'bot' },
      edit: mock.fn(async payload => { edited(payload); return message; }) };
    const channel = { messages: { fetch: async () => message } };
    const user = '123456789012345678';
    const runtime = await createWorkflow({ root, client: { channels: { fetch: async () => channel } },
      guildId: policy.guild, textId: policy.channel, env: { ...env, DISCORD_CONTROLLER_IDS: user, ISSUE_APPROVER_IDS: user } });
    t.after(() => { runtime.stop(); runtime.workflow.close(); });
    assert.equal(runtime.publishingEnabled, false);
    assert.match(warning.mock.calls[0].arguments[0], /!{72}\nWARNING: GITHUB PUBLISHING IS DISABLED/);
    runtime.workflow.openSession('session', settings);
    const draft = seedDraft(runtime.workflow);
    runtime.workflow.registerPreview(message, draft);
    runtime.workflow.approve({ user, human: true, guild: policy.guild, channel: policy.channel }, draft.id, draft.revision, digest(draft));
    runtime.start();
    const payload = await refreshed;
    await new Promise(setImmediate);
    assert.ok(!payload.components[0].toJSON().components.some(button => ['approve', 'reconcile'].includes(button.custom_id.split(':')[0])));
    assert.equal(runtime.workflow.get(draft.id).state, 'approved');
    assert.equal(fetcher.mock.callCount(), 1);
    assert.equal(fetcher.mock.calls[0].arguments[0], 'http://localhost:11434/api/chat');
  });
}

for (const env of [
  { GITHUB_REPO: settings.repo }, { GITHUB_TOKEN: 'test-token' },
  { GITHUB_REPO: 'invalid-repo', GITHUB_TOKEN: 'test-token' },
]) {
  test(`incomplete or malformed GitHub configuration refuses startup (${Object.keys(env).join(',')})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'vera-invalid-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fetcher = t.mock.method(globalThis, 'fetch', mock.fn());
    await assert.rejects(createWorkflow({ root, client: {}, guildId: policy.guild, textId: policy.channel, env }), /GitHub startup check failed/);
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(existsSync(join(root, 'workflow.sqlite')), false);
  });
}

test('configured GitHub connection failure refuses startup before creating workflow state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vera-unreachable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret-token'); });
  await assert.rejects(createWorkflow({ root, client: {}, guildId: policy.guild, textId: policy.channel,
    env: { GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'secret-token' } }), error => {
    assert.match(error.message, /GitHub startup check failed.*Cannot connect/);
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
  assert.equal(existsSync(join(root, 'workflow.sqlite')), false);
});

test('invalid or missing configured labels refuse startup before analysis or database creation', async t => {
  for (const label of ['x'.repeat(51), 'missing']) {
    const root = mkdtempSync(join(tmpdir(), 'vera-invalid-label-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fetcher = t.mock.method(globalThis, 'fetch', async (url, options) => url.includes('/labels/')
      ? new Response('', { status: 404 }) : githubAccessResponse(url, options));
    await assert.rejects(createWorkflow({ root, client: {}, guildId: policy.guild, textId: policy.channel,
      env: { GITHUB_REPO: settings.repo, GITHUB_TOKEN: 'test-token', GITHUB_ISSUE_LABEL: label } }), /GITHUB_ISSUE_LABEL/);
    assert.equal(fetcher.mock.callCount(), label === 'missing' ? 2 : 0);
    assert.equal(existsSync(join(root, 'workflow.sqlite')), false);
    fetcher.mock.restore();
  }
});

for (const provider of ['ollama', 'claude']) {
  test(`${provider} startup performs one synthetic analysis without recording or creating drafts`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'vera-llm-check-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const fetcher = t.mock.method(globalThis, 'fetch', startupResponse);
    const runtime = await createWorkflow({ root, client: {}, guildId: policy.guild, textId: policy.channel,
      env: { LLM_PROVIDER: provider, ANTHROPIC_API_KEY: 'test-key' } });
    t.after(() => { runtime.stop(); runtime.workflow.close(); });
    assert.equal(fetcher.mock.callCount(), 1);
    const [url, options] = fetcher.mock.calls[0].arguments;
    assert.equal(url, provider === 'claude' ? 'https://api.anthropic.com/v1/messages' : 'http://localhost:11434/api/chat');
    const body = JSON.parse(options.body);
    const request = JSON.parse(body.messages.at(-1).content);
    assert.equal(request.conversation[0].text, 'Hello.');
    assert.equal(request.existing_issues, undefined);
    assert.deepEqual(runtime.workflow.list(), []);
    assert.ok(options.signal instanceof AbortSignal);
  });

  test(`${provider} startup refuses connection, authentication, model, quota and output failures`, async t => {
    for (const failure of ['network', 'timeout', 401, 403, 404, 429, 503, 'unfinished', 'invalid JSON', 'invalid analysis']) {
      await t.test(String(failure), async st => {
        const root = mkdtempSync(join(tmpdir(), 'vera-llm-failure-'));
        st.after(() => rmSync(root, { recursive: true, force: true }));
        st.mock.method(console, 'warn', () => {});
        st.mock.method(console, 'log', () => {});
        let requestSignal;
        st.mock.method(globalThis, 'fetch', async (_url, options) => {
          requestSignal = options.signal;
          if (failure === 'network') throw new TypeError('Cannot connect');
          if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
          if (typeof failure === 'number') return new Response('SECRET provider details', { status: failure });
          const content = failure === 'invalid JSON' ? '{' : '{}';
          return Response.json(provider === 'claude'
            ? { stop_reason: failure === 'unfinished' ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: content }] }
            : { done: failure !== 'unfinished', message: { content } });
        });
        await assert.rejects(createWorkflow({ root, client: {}, guildId: policy.guild, textId: policy.channel,
          env: { LLM_PROVIDER: provider, ANTHROPIC_API_KEY: 'test-key' } }), error => {
          assert.match(error.message, /LLM startup check failed/);
          assert.ok(!error.message.includes('SECRET'));
          return true;
        });
        assert.equal(requestSignal.aborted, true);
        assert.equal(existsSync(join(root, 'workflow.sqlite')), false);
      });
    }
  });
}
