import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export function start({ env = process.env, spawnChild = spawn, signals = process } = {}) {
  return new Promise(done => {
    const children = new Map();
    let stopping = false, exitCode = 0, deadline;
    const finish = () => {
      if (children.size) return;
      clearTimeout(deadline);
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', interrupt);
      done(exitCode);
    };
    const stop = code => {
      if (stopping) return;
      stopping = true; exitCode = code;
      console.log(`[${new Date().toISOString()}] Stopping Vera (exit code ${code}).`);
      // Let the bot save its final WAV/jobs before stopping transcription.
      if (children.has('bot')) children.get('bot').kill('SIGTERM');
      else children.get('worker')?.kill('SIGINT');
      deadline = setTimeout(() => {
        exitCode ||= 1;
        for (const child of children.values()) child.kill('SIGKILL');
      }, 10_000);
      deadline.unref();
      finish();
    };
    const interrupt = () => stop(0);
    signals.on('SIGINT', interrupt);
    signals.on('SIGTERM', interrupt);

    const workerArgs = ['src/python/transcribe.py', 'watch', '--root', resolve(env.RECORDINGS_DIR || 'data'), '--run', env.STT_RUN || 'live'];
    if (env.STT_MODEL) workerArgs.push('--model', env.STT_MODEL);
    if (env.STT_LANGUAGE) workerArgs.push('--language', env.STT_LANGUAGE);
    const python = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const launch = (name, executable, args) => {
      const child = spawnChild(executable, args, { env,
        stdio: name === 'worker' ? ['inherit', 'pipe', 'inherit'] : 'inherit', detached: process.platform !== 'win32' });
      children.set(name, child);
      child.on('error', error => {
        console.error(name === 'worker'
          ? `Cannot start transcription worker (${error.code}); install Python dependencies in .venv as described in README.md.`
          : `Cannot start Discord bot (${error.code}).`);
        stop(1);
      });
      child.on('close', (code, signal) => {
        children.delete(name);
        if (!stopping) {
          console.error(`${name === 'worker' ? 'Transcription worker' : 'Discord bot'} exited unexpectedly (${signal || code}); stopping Vera.`);
          stop(code || 1);
        } else {
          if (name === 'bot') children.get('worker')?.kill('SIGINT');
          finish();
        }
      });
      return child;
    };
    const worker = launch('worker', python, workerArgs);
    const output = createInterface({ input: worker.stdout });
    let botStarted = false;
    output.on('line', line => {
      console.log(line);
      if (line === 'STT startup check passed.' && !stopping && !botStarted) {
        botStarted = true;
        launch('bot', process.execPath, ['src/js/capture.mjs']);
      }
    });
    worker.on('close', () => output.close());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await start();
