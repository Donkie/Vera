import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capture, RATE, wav } from '../../src/js/audio.mjs';

function captureFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vera-audio-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, capture: new Capture(directory) };
}

test('WAV headers describe 48 kHz signed 16-bit stereo PCM', () => {
  const pcm = Buffer.from([1, 2, 3, 4]), result = wav(pcm);
  assert.equal(result.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(result.readUInt32LE(4), pcm.length + 36);
  assert.equal(result.readUInt16LE(22), 2);
  assert.equal(result.readUInt32LE(24), RATE);
  assert.equal(result.readUInt16LE(34), 16);
  assert.equal(result.readUInt32LE(40), pcm.length);
  assert.deepEqual(result.subarray(44), pcm);
});

test('capture separates simultaneous speakers and flushes partial audio on stop', t => {
  const { capture, directory } = captureFor(t);
  const first = Buffer.alloc(RATE * 4, 1), second = Buffer.alloc(RATE * 4, 2);
  capture.add('123', 'Ada', first, 1);
  capture.add('456', 'Bo', second, 1);
  capture.flush(1);
  assert.deepEqual(readdirSync(directory), []);
  capture.flush(1, true);
  for (const [id, pcm, speaker] of [['123', first, 'Ada'], ['456', second, 'Bo']]) {
    assert.deepEqual(readFileSync(join(directory, `0-${id}.wav`)).subarray(44), pcm);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, `0-${id}.job.json`), 'utf8')), {
      audio: `0-${id}.wav`, user_id: id, speaker, start: 0, duration: 1, packets: 1,
    });
  }
  assert.equal(capture.buffers.size, 0);
  assert.equal(capture.packets, 2);
  assert.ok(readdirSync(directory).every(name => !name.endsWith('.tmp')));
});

test('capture splits packets across 12-second windows with a half-second flush grace', t => {
  const { capture, directory } = captureFor(t), pcm = Buffer.alloc(RATE * 4, 7);
  capture.add('123', 'Ada', pcm, 12.5);
  capture.flush(12.49);
  assert.deepEqual(readdirSync(directory), []);
  capture.flush(12.5);
  assert.equal(JSON.parse(readFileSync(join(directory, 'capture-progress.json'), 'utf8')).through, 12);
  const first = readFileSync(join(directory, '0-123.wav')).subarray(44);
  assert.equal(first.length, 12 * RATE * 4);
  assert.ok(first.subarray(0, 11.5 * RATE * 4).every(byte => byte === 0));
  assert.deepEqual(first.subarray(11.5 * RATE * 4), pcm.subarray(0, RATE * 2));
  capture.flush(12.5, true);
  assert.equal(JSON.parse(readFileSync(join(directory, 'capture-progress.json'), 'utf8')).through, 12.5);
  assert.deepEqual(readFileSync(join(directory, '1-123.wav')).subarray(44), pcm.subarray(RATE * 2));
  assert.equal(JSON.parse(readFileSync(join(directory, '1-123.job.json'), 'utf8')).duration, 0.5);
});

test('capture rejects malformed input and never rewrites already flushed windows', t => {
  const { capture, directory } = captureFor(t);
  for (const args of [['../123', Buffer.alloc(4), 1], ['123', Buffer.alloc(3), 1], ['123', Buffer.alloc(4), NaN]]) {
    assert.throws(() => capture.add(...args), /Invalid PCM/);
  }
  capture.flush(12.5);
  capture.add('456', 'Late speaker', Buffer.alloc(4), 1);
  capture.flush(13, true);
  assert.equal(capture.latePackets, 1);
  assert.deepEqual(readdirSync(directory), ['capture-progress.json']);
  assert.equal(JSON.parse(readFileSync(join(directory, 'capture-progress.json'), 'utf8')).through, 13);
});

test('capture publishes progress through silent windows without creating audio jobs', t => {
  const { capture, directory } = captureFor(t);
  capture.flush(24.5);
  assert.deepEqual(readdirSync(directory), ['capture-progress.json']);
  assert.equal(JSON.parse(readFileSync(join(directory, 'capture-progress.json'), 'utf8')).through, 24);
});
