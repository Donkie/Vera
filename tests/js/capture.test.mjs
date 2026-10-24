import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GatewayIntentBits, Routes, SlashCommandBuilder } from 'discord.js';
import { createWorkflow } from '../../src/js/runtime.mjs';
import { commandFor } from './support/fixtures.mjs';

async function botFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'vera-discord-'));
  const context = { user: '123456789012345678', human: true, guild: '111111111111111111', channel: '222222222222222222' };
  const env = { DISCORD_TOKEN: 'mock-discord-token', DISCORD_GUILD_ID: context.guild, DISCORD_TEXT_CHANNEL_ID: context.channel,
    DISCORD_VOICE_CHANNEL_ID: '333333333333333333', DISCORD_CONTROLLER_IDS: context.user, ISSUE_APPROVER_IDS: context.user,
    RECORDINGS_DIR: root, GITHUB_REPO: 'example/project', GITHUB_TOKEN: 'mock-token', LLM_PROVIDER: 'ollama' };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const exitCode = process.exitCode;
  const signals = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  let runtime;
  t.after(async () => {
    const shutdown = process.listeners('SIGTERM').find(fn => !signals.SIGTERM.includes(fn));
    if (shutdown) await shutdown();
    for (const [signal, previous] of Object.entries(signals)) {
      for (const fn of process.listeners(signal)) if (!previous.includes(fn)) process.removeListener(signal, fn);
    }
    runtime?.workflow.close();
    process.exitCode = exitCode;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const text = { isTextBased: () => true, send: mock.fn(async () => ({})) };
  const voice = { isVoiceBased: () => true };
  const guild = { channels: { fetch: mock.fn(async id => id === env.DISCORD_VOICE_CHANNEL_ID ? voice : text) },
    members: { cache: new Map([[context.user, { displayName: 'Ada' }]]) }, voiceAdapterCreator: {} };
  const client = new EventEmitter();
  Object.assign(client, { guilds: { fetch: mock.fn(async () => guild) }, channels: { fetch: mock.fn(async () => text) },
    users: { cache: new Map() }, user: { id: '444444444444444444' }, login: mock.fn(async () => {}), destroy: mock.fn() });
  const put = mock.fn(async () => {}), connections = [], decoders = [];
  const ready = mock.fn(async connection => connection);
  t.mock.module('discord.js', { namedExports: { GatewayIntentBits, Routes, SlashCommandBuilder,
    Client: function () { return client; }, REST: class { setToken() { return this; } put = put; } } });
  t.mock.module('@discordjs/voice', { namedExports: {
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' }, EndBehaviorType: { Manual: 'manual' },
    generateDependencyReport: () => 'mock voice', entersState: ready,
    joinVoiceChannel: () => {
      const connection = new EventEmitter(), subscriptions = new Map();
      connection.receiver = { speaking: new EventEmitter(), subscriptions, subscribe: mock.fn(id => {
        const stream = new EventEmitter(); subscriptions.set(id, stream); return stream;
      }) };
      connection.destroy = mock.fn(() => { for (const stream of subscriptions.values()) stream.emit('close'); });
      connections.push(connection); return connection;
    },
  } });
  t.mock.module('opusscript', { defaultExport: class {
    static Application = { AUDIO: 2049 };
    constructor() { decoders.push(this); }
    decode(packet) { if (!Buffer.isBuffer(packet)) throw new Error('bad packet'); return packet; }
    delete = mock.fn();
  } });
  t.mock.module(new URL('../../src/js/runtime.mjs', import.meta.url), { namedExports: {
    createWorkflow: options => { runtime = createWorkflow(options); return runtime; },
  } });
  await import('../../src/js/capture.mjs');
  const command = async (action, overrides = {}) => {
    const interaction = { ...commandFor(action, {}, context), ...overrides };
    await client.listeners('interactionCreate')[0](interaction);
    return interaction;
  };
  const session = () => {
    const directory = readdirSync(root, { withFileTypes: true }).find(entry => entry.isDirectory());
    const path = join(root, directory.name);
    return { path, info: JSON.parse(readFileSync(join(path, 'session.json'), 'utf8')),
      events: readFileSync(join(path, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
  };
  return { root, context, client, guild, text, voice, put, connections, decoders, ready, command, session };
}

test('Discord bot interface', async t => {
  const bot = await botFor(t);
  const scenario = (name, check) => t.test(name, async st => {
    const exitCode = process.exitCode;
    st.after(async () => {
      await bot.command('stop');
      bot.ready.mock.mockImplementation(async connection => connection);
      bot.put.mock.mockImplementation(async () => {});
      for (const entry of readdirSync(bot.root, { withFileTypes: true })) {
        if (entry.isDirectory()) rmSync(join(bot.root, entry.name), { recursive: true, force: true });
      }
      bot.connections.length = 0; bot.decoders.length = 0;
      for (const spy of [bot.text.send, bot.client.destroy, bot.put, console.error]) spy.mock.resetCalls();
      process.exitCode = exitCode;
    });
    await check(bot, st);
  });

  await scenario('bot registers the complete /vera command interface without starting recording', async bot => {
    await bot.client.listeners('clientReady')[0]();
    const commands = bot.put.mock.calls[0].arguments[1].body[0];
    assert.deepEqual(commands.options.map(option => option.name),
      ['start', 'stop', 'status', 'access', 'drafts', 'draft', 'edit', 'note', 'merge', 'reject', 'reconcile', 'summary']);
    assert.equal(bot.connections.length, 0);
    assert.equal(bot.client.login.mock.callCount(), 1);
  });

  await scenario('start/status/stop commands save speaker audio and final jobs, and permit a fresh recording', async bot => {
    assert.equal((await bot.command('status')).editReply.mock.calls[0].arguments[0], 'No recording active.');
    await bot.command('start');
    assert.match(bot.text.send.mock.calls[0].arguments[0], /Everyone in the voice channel will be recorded/);
    const connection = bot.connections[0];
    connection.receiver.speaking.emit('start', bot.context.user);
    const stream = connection.receiver.subscriptions.get(bot.context.user);
    stream.emit('data', Buffer.alloc(1920));
    stream.emit('data', 'invalid opus');
    connection.emit('debug', 'failed to decrypt SECRET voice credentials');
    const status = await bot.command('status');
    assert.match(status.editReply.mock.calls[0].arguments[0], /1 decoded packets, 1 decode errors, 1 DAVE failures/);
    await bot.command('stop');
    const { path, info, events } = bot.session();
    assert.equal(info.status, 'stopped');
    assert.equal(info.packets, 1);
    assert.equal(info.decode_errors, 1);
    assert.ok(readdirSync(path).some(name => name.endsWith('.wav')));
    assert.ok(readdirSync(path).some(name => name.endsWith('.job.json')));
    assert.ok(events.some(event => event.type === 'decode_error'));
    assert.ok(!JSON.stringify(events).includes('SECRET'));
    assert.equal(bot.decoders[0].delete.mock.callCount(), 1);
    await bot.command('start');
    assert.equal(bot.connections.length, 2);
  });

  await scenario('recording flushes complete audio windows before the stop command', async (bot, st) => {
    let milliseconds = 0;
    st.mock.method(performance, 'now', () => milliseconds);
    st.mock.timers.enable({ apis: ['setInterval'] });
    await bot.command('start');
    milliseconds = 1000;
    const connection = bot.connections[0];
    connection.receiver.speaking.emit('start', bot.context.user);
    connection.receiver.subscriptions.get(bot.context.user).emit('data', Buffer.alloc(1920));
    milliseconds = 13_000;
    st.mock.timers.tick(1000);
    const { path, info } = bot.session();
    assert.equal(info.status, 'recording');
    const job = readdirSync(path).find(name => name.endsWith('.job.json'));
    assert.equal(JSON.parse(readFileSync(join(path, job), 'utf8')).duration, 12);
    assert.match((await bot.command('status')).editReply.mock.calls[0].arguments[0], /1 queued chunks/);
  });

  await scenario('unauthorized recording commands are private and never join voice', async bot => {
    for (const overrides of [{ user: { id: 'untrusted', bot: false } }, { channelId: 'elsewhere' }, { user: { id: bot.context.user, bot: true } }]) {
      const interaction = await bot.command('start', overrides);
      assert.equal(interaction.reply.mock.calls[0].arguments[0].flags, 64);
      assert.equal(interaction.deferReply.mock.callCount(), 0);
    }
    assert.equal(bot.connections.length, 0);
  });

  await scenario('duplicate start and stop during connection cannot create overlapping recordings', async bot => {
    let connect;
    bot.ready.mock.mockImplementation(() => new Promise(resolve => { connect = resolve; }));
    const pending = bot.command('start');
    await new Promise(setImmediate);
    assert.match((await bot.command('start')).editReply.mock.calls[0].arguments[0], /already active or starting/);
    assert.match((await bot.command('stop')).editReply.mock.calls[0].arguments[0], /Still connecting/);
    connect(bot.connections[0]); await pending;
    assert.equal(bot.connections.length, 1);
  });

  await scenario('failed voice connection is cleaned up and SDK details are kept out of replies', async bot => {
    bot.ready.mock.mockImplementation(async () => { throw new TypeError('SECRET request details'); });
    const failed = await bot.command('start');
    assert.match(failed.editReply.mock.calls[0].arguments[0], /Discord operation failed/);
    assert.ok(!failed.editReply.mock.calls[0].arguments[0].includes('SECRET'));
    assert.equal(bot.connections[0].destroy.mock.callCount(), 1);
    bot.ready.mock.mockImplementation(async connection => connection);
    assert.match((await bot.command('start')).editReply.mock.calls[0].arguments[0], /Recording started/);
  });

  for (const failure of ['connection', 'receive', 'disconnect']) {
    await scenario(`${failure} failure saves and stops the active recording`, async bot => {
      await bot.command('start');
      const connection = bot.connections[0];
      if (failure === 'receive') {
        connection.receiver.speaking.emit('start', bot.context.user);
        connection.receiver.subscriptions.get(bot.context.user).emit('error', new Error('receive failed'));
      } else connection.emit(failure === 'connection' ? 'error' : 'disconnected', new Error('connection lost'));
      await new Promise(setImmediate);
      assert.equal(bot.session().info.status, 'stopped');
      assert.equal((await bot.command('status')).editReply.mock.calls[0].arguments[0], 'No recording active.');
    });
  }

  await scenario('failed Discord registration exits with an error instead of pretending to be ready', async bot => {
    bot.put.mock.mockImplementation(async () => { throw new Error('SECRET API details'); });
    await bot.client.listeners('clientReady')[0]();
    assert.equal(process.exitCode, 1);
    assert.equal(bot.client.destroy.mock.callCount(), 1);
    assert.ok(!console.error.mock.calls[0].arguments[0].includes('SECRET'));
  });
});
