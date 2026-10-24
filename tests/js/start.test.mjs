import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { start } from '../../src/js/start.mjs';

function launch(t, env = {}) {
  t.mock.method(console, 'error', () => {});
  const worker = new EventEmitter(), bot = new EventEmitter(), signals = new EventEmitter();
  worker.kill = mock.fn(); bot.kill = mock.fn();
  const children = [worker, bot];
  const spawnChild = mock.fn(() => children.shift());
  const result = start({ env, spawnChild, signals });
  return { worker, bot, signals, spawnChild, result };
}

test('one launcher starts Python and the bot with shared environment and matching STT settings', async t => {
  const env = { RECORDINGS_DIR: './custom recordings', STT_RUN: 'small-cpu', STT_MODEL: 'KBLab/kb-whisper-base' };
  const { worker, bot, signals, spawnChild, result } = launch(t, env);
  const [python, args, options] = spawnChild.mock.calls[0].arguments;
  assert.equal(python, resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  assert.deepEqual(args, ['src/python/transcribe.py', 'watch', '--root', resolve(env.RECORDINGS_DIR), '--run', 'small-cpu', '--model', env.STT_MODEL]);
  assert.equal(options.env, env);
  assert.equal(options.stdio, 'inherit');
  assert.equal(options.detached, process.platform !== 'win32');
  assert.deepEqual(spawnChild.mock.calls[1].arguments, [process.execPath, ['src/js/capture.mjs'], options]);
  signals.emit('SIGINT');
  bot.emit('close', 0, null); worker.emit('close', 0, null);
  assert.equal(await result, 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops the bot before the worker and removes signal handlers`, async t => {
    const { worker, bot, signals, result } = launch(t);
    signals.emit(signal);
    assert.deepEqual(bot.kill.mock.calls[0].arguments, ['SIGTERM']);
    assert.equal(worker.kill.mock.callCount(), 0);
    signals.emit(signal);
    assert.equal(bot.kill.mock.callCount(), 1);
    bot.emit('close', 0, null);
    assert.deepEqual(worker.kill.mock.calls[0].arguments, ['SIGINT']);
    worker.emit('close', 0, null);
    assert.equal(await result, 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });
}

test('default startup uses the same data directory and live run as the bot', async t => {
  const { worker, bot, signals, spawnChild, result } = launch(t);
  assert.deepEqual(spawnChild.mock.calls[0].arguments[1], ['src/python/transcribe.py', 'watch', '--root', resolve('data'), '--run', 'live']);
  signals.emit('SIGTERM'); bot.emit('close', 0, null); worker.emit('close', 0, null);
  await result;
});

for (const name of ['worker', 'bot']) {
  test(`${name} failure stops its sibling and preserves the failure exit code`, async t => {
    const { worker, bot, result } = launch(t);
    const failed = name === 'worker' ? worker : bot, sibling = name === 'worker' ? bot : worker;
    failed.emit('close', 7, null);
    assert.equal(sibling.kill.mock.callCount(), 1);
    sibling.emit('close', 0, null);
    assert.equal(await result, 7);
  });
}

test('missing Python reports setup instructions and stops the bot', async t => {
  const { worker, bot, result } = launch(t);
  worker.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  assert.match(console.error.mock.calls[0].arguments[0], /install Python dependencies in .venv/);
  worker.emit('close', -2, null); bot.emit('close', 0, null);
  assert.equal(bot.kill.mock.callCount(), 1);
  assert.equal(await result, 1);
});

test('an unexpected successful exit or signal still fails the combined service', async t => {
  const { worker, bot, result } = launch(t);
  bot.emit('close', 0, null); worker.emit('close', null, 'SIGINT');
  assert.equal(await result, 1);
});

test('hung children are killed after the shutdown deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { worker, bot, signals, result } = launch(t);
  signals.emit('SIGTERM');
  t.mock.timers.tick(10_000);
  assert.deepEqual(bot.kill.mock.calls.at(-1).arguments, ['SIGKILL']);
  assert.deepEqual(worker.kill.mock.calls.at(-1).arguments, ['SIGKILL']);
  bot.emit('close', null, 'SIGKILL'); worker.emit('close', null, 'SIGKILL');
  assert.equal(await result, 1);
});
