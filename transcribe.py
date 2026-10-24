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
                       'vad_filter': True, 'min_silence_duration_ms': 500, 'condition_on_previous_text': False}
        self.model = WhisperModel(model_path, device=args.device, compute_type=self.config['compute_type'],
                                  cpu_threads=args.cpu_threads, num_workers=1, download_root=str(args.models))

    def transcribe(self, audio):
        start = time.perf_counter()
        segments, _ = self.model.transcribe(str(audio), language=self.config['language'], beam_size=1,
                                            condition_on_previous_text=False, vad_filter=True,
                                            vad_parameters={'min_silence_duration_ms': 500})
        rows = [{'start': segment.start, 'end': segment.end, 'text': segment.text.strip()}
                for segment in segments if segment.text.strip()]
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


def process_job(path, run, recognizer):
    import psutil
    result = run / 'chunks' / path.name.replace('.job.json', '.result.json')
    error = result.with_name(result.name.replace('.result.json', '.error.json'))
    if result.exists() or error.exists():
        return
    try:
        job, audio = load_job(path)
        rows, elapsed = recognizer.transcribe(audio)
        for row in rows:
            row['start'] = round(job['start'] + row['start'], 3)
            row['end'] = round(job['start'] + row['end'], 3)
            row['user_id'], row['speaker'] = job['user_id'], job['speaker']
        metrics = {'audio_seconds': job['duration'], 'inference_seconds': round(elapsed, 3),
                   'real_time_factor': round(elapsed / job['duration'], 3),
                   'rss_mib': round(psutil.Process().memory_info().rss / 1024**2, 1)}
        write_json(result, {'source_job': path.name, 'metrics': metrics, 'segments': rows})
        render(run)
        print(f'{path.parent.name}/{path.name}: {len(rows)} segments, {elapsed:.2f}s inference / {job["duration"]:.2f}s audio', flush=True)
    except Exception as exc:
        write_json(error, {'error': str(exc), 'source_job': path.name})
        print(f'FAILED {path}: {exc}', flush=True)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['watch', 'replay'])
    parser.add_argument('--root', type=Path, default=Path('data'))
    parser.add_argument('--session', type=Path, help='Saved session directory for replay')
    parser.add_argument('--run', default='live', help='Separate transcript/metrics label; never mixes settings')
    parser.add_argument('--model', default='KBLab/kb-whisper-base')
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
    recognizer = Recognizer(args)
    prepared = {}
    while True:
        sessions = [args.session] if args.command == 'replay' else sorted(args.root.glob('*/session.json'))
        for entry in sessions:
            session = entry if args.command == 'replay' else entry.parent
            if session not in prepared:
                prepared[session] = prepare_run(session, args.run, recognizer.config)
                render(prepared[session])
            for path in sorted(session.glob('*.job.json'), key=lambda p: (int(p.name.split('-')[0]), p.name)):
                process_job(path, prepared[session], recognizer)
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
