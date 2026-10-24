#!/usr/bin/env python3
"""Local live worker and repeatable STT replay; capture remains independent of inference."""
import argparse
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import re
import time

RATE = 16_000
PAUSE = RATE
PADDING = RATE // 5
MAX_WINDOW = 30 * RATE
OVERLAP = 2 * RATE


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def stamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, ms = divmod(remainder, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02}.{ms:03}'


def load_job(path):
    job = json.loads(path.read_text(encoding='utf-8'))
    audio = (path.parent / job['audio']).resolve()
    if audio.parent != path.parent.resolve() or audio.suffix != '.wav':
        raise ValueError('Audio must be a WAV in the session directory')
    if not re.fullmatch(r'\d+', job['user_id']) or not isinstance(job['speaker'], str):
        raise ValueError('Invalid speaker identity')
    for key in ('start', 'duration'):
        if not isinstance(job[key], (int, float)) or not math.isfinite(job[key]) or job[key] < 0:
            raise ValueError(f'Invalid {key}')
    if not 0 < job['duration'] <= 12.1:
        raise ValueError('Expected a chunk of at most 12 seconds')
    return job, audio


def render(run):
    segments = []
    for result in (run / 'chunks').glob('*.result.json'):
        segments.extend(json.loads(result.read_text(encoding='utf-8'))['segments'])
    segments.sort(key=lambda row: (row['start'], row['user_id'], row['end']))
    write_json(run / 'transcript.json', segments)
    lines = ['# Discussion transcript', '',
             'Times are relative to session start. Speakers have separate audio tracks; overlapping times are intentional.', '']
    for row in segments:
        speaker = row['speaker'].replace('\n', ' ').replace('\r', ' ')
        lines.append(f"[{stamp(row['start'])}–{stamp(row['end'])}] {speaker} ({row['user_id']}): {row['text']}")
    temporary = run / 'transcript.md.tmp'
    temporary.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    temporary.replace(run / 'transcript.md')


class Recognizer:
    def __init__(self, args):
        import onnxruntime
        from faster_whisper import WhisperModel
        from faster_whisper.utils import download_model
        onnxruntime.disable_telemetry_events()
        model_path = args.model if Path(args.model).is_dir() else download_model(args.model, cache_dir=str(args.models))
        self.config = {'model': args.model, 'device': args.device,
                       'compute_type': args.compute_type or ('int8' if args.device == 'cpu' else 'int8_float16'),
                       'cpu_threads': args.cpu_threads, 'language': args.language, 'beam_size': 1,
                       'model_snapshot': Path(model_path).name,
                       'faster_whisper': version('faster-whisper'), 'ctranslate2': version('ctranslate2'),
                       'vad_filter': False, 'min_silence_duration_ms': 1000, 'condition_on_previous_text': False,
                       'word_timestamps': True, 'segmentation_version': 1,
                       'max_window_seconds': MAX_WINDOW / RATE, 'overlap_seconds': OVERLAP / RATE,
                       'speech_pad_ms': 200}
        self.model = WhisperModel(model_path, device=args.device, compute_type=self.config['compute_type'],
                                  cpu_threads=args.cpu_threads, num_workers=1, download_root=str(args.models))

    def check(self):
        import numpy as np
        silence = np.zeros(16_000, dtype=np.float32)
        # Silence exercises VAD; disabling it also forces the Whisper decoder to run.
        for vad in (True, False):
            segments, _ = self.model.transcribe(silence, language=self.config['language'], beam_size=1,
                                                condition_on_previous_text=False, vad_filter=vad,
                                                vad_parameters={'min_silence_duration_ms': 1000}, word_timestamps=True)
            list(segments)

    def speech(self, audio):
        from faster_whisper.vad import get_speech_timestamps
        return get_speech_timestamps(audio, min_silence_duration_ms=1000, speech_pad_ms=0)

    def transcribe(self, audio, after=0, before=math.inf):
        start = time.perf_counter()
        segments, _ = self.model.transcribe(audio, language=self.config['language'], beam_size=1,
                                            condition_on_previous_text=False, vad_filter=False, word_timestamps=True)
        rows = []
        for segment in segments:
            if not segment.text.strip():
                continue
            if not segment.words:
                raise ValueError('Word timestamps are required to reconcile overlapping speech')
            # shortcut: overlap uses estimated word times; add alignment if live speech shows boundary repeats or omissions.
            words = [word for word in segment.words if after <= (word.start + word.end) / 2 < before]
            if words:
                rows.append({'start': words[0].start, 'end': words[-1].end,
                             'text': ''.join(word.word for word in words).strip()})
        return rows, time.perf_counter() - start


def prepare_run(session, name, config):
    # shortcut: one process per run; add a cross-process lock before multiworker deployment.
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', name):
        raise ValueError('Run name must be 1–64 letters, digits, underscores or hyphens')
    run = session / 'recognitions' / name
    (run / 'chunks').mkdir(parents=True, exist_ok=True)
    metadata = run / 'run.json'
    if metadata.exists():
        if json.loads(metadata.read_text(encoding='utf-8')) != config:
            raise ValueError('This run uses another model/settings. Choose a new --run name.')
    else:
        write_json(metadata, config)
    return run


def process_session(session, run, recognizer, final=False):
    import numpy as np
    import psutil
    from faster_whisper.audio import decode_audio

    progress = session / 'capture-progress.json'
    through = round(json.loads(progress.read_text())['through'] * RATE) if progress.exists() else 0
    sources = sorted(session.glob('*.job.json'), key=lambda path: (int(path.name.split('-')[0]), path.name))
    speakers = {}
    for path in sources:
        error = run / 'chunks' / path.name.replace('.job.json', '.error.json')
        if error.exists():
            return
        try:
            job, audio_path = load_job(path)
            speakers.setdefault(job['user_id'], []).append((path, job, audio_path))
        except Exception as exc:
            write_json(error, {'error': str(exc), 'source_job': path.name})
            print(f'FAILED {path}: {exc}', flush=True)
            return
    if final:
        through = max(through, *(round((job['start'] + job['duration']) * RATE)
                                for jobs in speakers.values() for _, job, _ in jobs), 0)

    checkpoints = {}
    for path in (run / 'chunks').glob('speech-*.result.json'):
        saved = json.loads(path.read_text())
        previous = checkpoints.get(saved['user_id'])
        if previous is None or saved['next_sample'] > previous['next_sample']:
            checkpoints[saved['user_id']] = saved

    finished = True
    for user_id, jobs in speakers.items():
        saved = checkpoints.get(user_id, {})
        cursor = saved.get('next_sample', round(jobs[0][1]['start'] * RATE))
        committed = saved.get('committed_sample', cursor)
        while cursor < through:
            size = min(MAX_WINDOW, through - cursor)
            if not final and size < PAUSE:
                break
            result = run / 'chunks' / f'speech-{user_id}-{cursor}.result.json'
            error = result.with_name(result.name.replace('.result.json', '.error.json'))
            if error.exists():
                break
            try:
                audio = np.zeros(size, dtype=np.float32)
                for path, job, audio_path in jobs:
                    start = round(job['start'] * RATE)
                    end = round((job['start'] + job['duration']) * RATE)
                    left, right = max(cursor, start), min(cursor + size, end)
                    if left >= right:
                        continue
                    decoded = decode_audio(str(audio_path), sampling_rate=RATE)
                    if abs(len(decoded) - (end - start)) > 1:
                        raise ValueError(f'Audio duration does not match {path.name}')
                    right = min(right, start + len(decoded))
                    audio[left - cursor:right - cursor] = decoded[left - start:right - start]

                speech = [span for span in recognizer.speech(audio) if span['end'] > committed - cursor]
                closed = [span['end'] + PADDING for span in speech
                          if span['end'] <= size - PAUSE and span['end'] + PADDING > committed - cursor]
                forced = False
                if speech and speech[0]['start'] - PADDING > committed - cursor:
                    end = speech[0]['start'] - PADDING
                    speech = []  # Skip leading silence so it cannot force a premature speech split.
                elif closed:
                    end = closed[-1]
                elif not speech:
                    end = size if final else size - PADDING
                elif final and cursor + size == through:
                    end = size
                elif size == MAX_WINDOW:
                    end, forced = size, True
                else:
                    break

                boundary = cursor + end - (OVERLAP if forced else 0)
                rows, elapsed = recognizer.transcribe(audio[:end], after=(committed - cursor) / RATE,
                                                      before=(boundary - cursor) / RATE) if speech else ([], 0)
                for row in rows:
                    row['start'] = round(cursor / RATE + row['start'], 3)
                    row['end'] = round(cursor / RATE + row['end'], 3)
                    row['user_id'], row['speaker'] = user_id, jobs[0][1]['speaker']
                duration = end / RATE
                metrics = {'audio_seconds': duration, 'inference_seconds': round(elapsed, 3),
                           'real_time_factor': round(elapsed / duration, 3),
                           'rss_mib': round(psutil.Process().memory_info().rss / 1024**2, 1)}
                # Keep two seconds of context before the uncommitted two-second tail on a forced split.
                next_sample = cursor + end - (2 * OVERLAP if forced else 0)
                write_json(result, {'user_id': user_id, 'next_sample': next_sample,
                                    'committed_sample': boundary, 'metrics': metrics, 'segments': rows})
                print(f'{session.name}/{result.name}: {len(rows)} segments, {elapsed:.2f}s inference / {duration:.2f}s audio', flush=True)
                cursor, committed = next_sample, boundary
            except Exception as exc:
                write_json(error, {'error': str(exc), 'user_id': user_id, 'start': cursor / RATE})
                print(f'FAILED {session}/{result.name}: {exc}', flush=True)
                break
        finished = finished and cursor >= through
    render(run)
    if final and finished and not any((run / 'chunks').glob('*.error.json')):
        write_json(run / 'complete.json', {'source_jobs': sorted(path.name for path in sources)})



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['watch', 'replay'])
    parser.add_argument('--root', type=Path, default=Path('data'))
    parser.add_argument('--session', type=Path, help='Saved session directory for replay')
    parser.add_argument('--run', default='live', help='Separate transcript/metrics label; never mixes settings')
    parser.add_argument('--model', default='KBLab/kb-whisper-small')
    parser.add_argument('--language', default='sv', help='Whisper language code; use a multilingual model for other languages')
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--compute-type')
    parser.add_argument('--cpu-threads', type=int, default=2)
    parser.add_argument('--models', type=Path, default=Path('models'))
    args = parser.parse_args()
    if args.cpu_threads < 1:
        parser.error('Thread count must be positive')
    if args.command == 'replay' and (not args.session or not (args.session / 'session.json').is_file()):
        parser.error('Replay needs --session pointing to a saved session')
    if hasattr(os, 'nice'):
        os.nice(10)
    os.umask(0o077)
    print('Loading local STT model (first run may download weights)...', flush=True)
    try:
        recognizer = Recognizer(args)
        recognizer.check()
    except Exception as exc:
        raise SystemExit(f'STT startup check failed: {exc}') from None
    print('STT startup check passed.', flush=True)
    prepared, seen = {}, {}
    while True:
        sessions = [args.session] if args.command == 'replay' else sorted(args.root.glob('*/session.json'))
        for entry in sessions:
            session = entry if args.command == 'replay' else entry.parent
            if session not in prepared:
                prepared[session] = prepare_run(session, args.run, recognizer.config)
                render(prepared[session])
            info = json.loads((session / 'session.json').read_text())
            progress = session / 'capture-progress.json'
            inputs = (info.get('status'), progress.stat().st_mtime_ns if progress.exists() else None,
                      tuple(sorted(path.name for path in session.glob('*.job.json'))))
            chunks = prepared[session] / 'chunks'
            errors = tuple(sorted(path.name for path in chunks.glob('*.error.json')))
            if seen.get(session) != (inputs, errors):
                process_session(session, prepared[session], recognizer,
                                final=args.command == 'replay' or info.get('status') == 'stopped')
                seen[session] = (inputs, tuple(sorted(path.name for path in chunks.glob('*.error.json'))))
        if args.command == 'replay':
            if any((prepared[args.session] / 'chunks').glob('*.error.json')):
                raise SystemExit('Replay has failed chunks; inspect *.error.json before relying on its transcript.')
            return
        time.sleep(1)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
