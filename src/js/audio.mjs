import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const RATE = 48_000;
const FRAME_BYTES = 4; // Discord PCM: signed 16-bit stereo.

export function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * FRAME_BYTES, 28);
  header.writeUInt16LE(FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// One shared receive clock keeps simultaneous speakers on separate, aligned tracks.
export class Capture {
  constructor(directory, chunkSeconds = 12) {
    this.directory = directory;
    this.chunkFrames = chunkSeconds * RATE;
    this.buffers = new Map();
    this.cursors = new Map();
    this.flushedThrough = 0;
    this.packets = 0;
    this.latePackets = 0;
  }

  add(userId, name, pcm, receivedSeconds) {
    if (!/^\d+$/.test(userId) || pcm.length % FRAME_BYTES || !Number.isFinite(receivedSeconds)) {
      throw new Error('Invalid PCM packet or speaker');
    }
    const frames = pcm.length / FRAME_BYTES;
    const arrival = Math.max(0, Math.round(receivedSeconds * RATE) - frames);
    let start = this.cursors.get(userId) ?? arrival;
    // shortcut: receive time approximates RTP time; validate jitter/overlap in the live test before production.
    if (Math.abs(start - arrival) > RATE / 10) start = Math.max(start, arrival);
    this.cursors.set(userId, start + frames);
    this.packets++;
    let used = 0;
    while (used < frames) {
      const absolute = start + used;
      const index = Math.floor(absolute / this.chunkFrames);
      const offset = absolute % this.chunkFrames;
      const count = Math.min(frames - used, this.chunkFrames - offset);
      if (absolute < this.flushedThrough) {
        this.latePackets++;
      } else {
        const key = `${index}-${userId}`;
        if (!this.buffers.has(key)) {
          this.buffers.set(key, { index, userId, name, pcm: Buffer.alloc(this.chunkFrames * FRAME_BYTES), packets: 0 });
        }
        const buffer = this.buffers.get(key);
        pcm.copy(buffer.pcm, offset * FRAME_BYTES, used * FRAME_BYTES, (used + count) * FRAME_BYTES);
        buffer.packets++;
      }
      used += count;
    }
  }

  flush(seconds, final = false) {
    const cutoff = final
      ? Math.max(Math.ceil(seconds * RATE), ...this.cursors.values())
      : Math.floor((seconds - 0.5) * RATE / this.chunkFrames) * this.chunkFrames;
    for (const [key, buffer] of this.buffers) {
      if (!final && (buffer.index + 1) * this.chunkFrames > cutoff) continue;
      const start = buffer.index * this.chunkFrames;
      const frames = Math.min(this.chunkFrames, Math.max(0, cutoff - start));
      if (frames > 0) {
        writeFileSync(join(this.directory, `${key}.wav`), wav(buffer.pcm.subarray(0, frames * FRAME_BYTES)), { mode: 0o600 });
        // Publish the job only after the WAV is complete; the worker never sees a partial chunk.
        writeJson(join(this.directory, `${key}.job.json`), {
          audio: `${key}.wav`, user_id: buffer.userId, speaker: buffer.name,
          start: start / RATE, duration: frames / RATE, packets: buffer.packets,
        });
      }
      this.buffers.delete(key);
    }
    this.flushedThrough = Math.max(this.flushedThrough, cutoff);
  }
}
