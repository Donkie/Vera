import contextlib
import io
import json
import runpy
from pathlib import Path
import socket
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import transcribe


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='vera-stt-')
        self.addCleanup(temporary.cleanup)
        self.session = Path(temporary.name)
        self.job = {'audio': '0-123.wav', 'user_id': '123', 'speaker': 'Ada', 'start': 12, 'duration': 2}
        self.path = self.session / '0-123.job.json'
        transcribe.write_json(self.path, self.job)
        self.audio = self.session / self.job['audio']
        self.audio.write_bytes(b'mocked audio; never decoded by ML')
        self.args = SimpleNamespace(model='KBLab/kb-whisper-small', models=self.session / 'models',
                                    device='cpu', compute_type=None, cpu_threads=2, language='sv')

        # Replace ML imports even when those packages are absent; no weights or pip install needed.
        whisper, utils, onnx, psutil = [ModuleType(name) for name in
                                       ('faster_whisper', 'faster_whisper.utils', 'onnxruntime', 'psutil')]
        self.model = Mock()
        self.model.transcribe.return_value = (iter([
            SimpleNamespace(start=0.1, end=1.5, text='  Spara-knappen fungerar inte.  '),
            SimpleNamespace(start=1.5, end=2, text=' '),
        ]), SimpleNamespace(language='sv'))
        whisper.WhisperModel = Mock(return_value=self.model)
        utils.download_model = Mock(return_value=str(self.session / 'mock-snapshot'))
        onnx.disable_telemetry_events = Mock()
        psutil.Process = Mock(return_value=SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=64 * 1024**2)))
        self.whisper, self.utils, self.onnx = whisper, utils, onnx
        self.enterContext(patch.dict(sys.modules, {'faster_whisper': whisper, 'faster_whisper.utils': utils,
                                                 'onnxruntime': onnx, 'psutil': psutil}))
        self.enterContext(patch('transcribe.version', return_value='mock-version'))
        self.enterContext(patch.object(socket.socket, 'connect', side_effect=AssertionError('Network disabled in tests')))
        self.enterContext(patch.object(socket, 'create_connection', side_effect=AssertionError('Network disabled in tests')))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def recognizer(self):
        return transcribe.Recognizer(self.args)

    def test_recognizer_mocks_model_download_and_cpu_initialization(self):
        recognizer = self.recognizer()
        self.utils.download_model.assert_called_once_with(self.args.model, cache_dir=str(self.args.models))
        self.whisper.WhisperModel.assert_called_once_with(
            str(self.session / 'mock-snapshot'), device='cpu', compute_type='int8',
            cpu_threads=2, num_workers=1, download_root=str(self.args.models))
        self.onnx.disable_telemetry_events.assert_called_once_with()
        self.assertEqual(recognizer.config['faster_whisper'], 'mock-version')
        self.assertEqual(recognizer.config['model_snapshot'], 'mock-snapshot')
        self.assertFalse(self.args.models.exists())

    def test_local_model_directory_skips_downloader(self):
        self.args.model = str(self.session)
        self.recognizer()
        self.utils.download_model.assert_not_called()

    def test_transcription_strips_empty_segments_and_sets_inference_options(self):
        recognizer = self.recognizer()
        with patch('transcribe.time.perf_counter', side_effect=[10, 10.25]):
            rows, elapsed = recognizer.transcribe(self.audio)
        self.assertEqual(rows, [{'start': 0.1, 'end': 1.5, 'text': 'Spara-knappen fungerar inte.'}])
        self.assertEqual(elapsed, 0.25)
        self.model.transcribe.assert_called_once_with(str(self.audio), language='sv', beam_size=1,
                                                     condition_on_previous_text=False, vad_filter=True,
                                                     vad_parameters={'min_silence_duration_ms': 500})

    def test_job_validation_rejects_unsafe_paths_and_bad_metadata(self):
        for key, value in [('audio', '../outside.wav'), ('audio', 'audio.mp3'), ('user_id', '../123'),
                           ('speaker', None), ('start', -1), ('start', float('nan')),
                           ('duration', 0), ('duration', 13), ('duration', float('inf'))]:
            with self.subTest(key=key, value=value):
                transcribe.write_json(self.path, {**self.job, key: value})
                with self.assertRaises(ValueError):
                    transcribe.load_job(self.path)

    def test_prepare_run_preserves_settings_and_rejects_unsafe_names(self):
        config = self.recognizer().config
        run = transcribe.prepare_run(self.session, 'live', config)
        self.assertEqual(transcribe.prepare_run(self.session, 'live', config), run)
        with self.assertRaisesRegex(ValueError, 'another model/settings'):
            transcribe.prepare_run(self.session, 'live', {**config, 'language': 'en'})
        for name in ['../escape', '', 'x' * 65]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                transcribe.prepare_run(self.session, name, config)

    def test_process_job_writes_absolute_timestamps_metrics_and_transcripts_once(self):
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_job(self.path, run, recognizer)
        result = json.loads((run / 'chunks' / '0-123.result.json').read_text())
        expected = [{'start': 12.1, 'end': 13.5, 'text': 'Spara-knappen fungerar inte.',
                     'user_id': '123', 'speaker': 'Ada'}]
        self.assertEqual(result['segments'], expected)
        self.assertEqual(result['metrics']['audio_seconds'], 2)
        self.assertEqual(result['metrics']['rss_mib'], 64)
        self.assertEqual(json.loads((run / 'transcript.json').read_text()), expected)
        self.assertIn('[00:00:12.100–00:00:13.500] Ada (123)', (run / 'transcript.md').read_text())
        transcribe.process_job(self.path, run, recognizer)
        self.model.transcribe.assert_called_once()
        self.assertEqual(self.audio.read_bytes(), b'mocked audio; never decoded by ML')
        self.assertEqual(list(run.rglob('*.tmp')), [])

    def test_failed_chunks_record_error_and_are_not_retried_automatically(self):
        recognizer = self.recognizer()
        self.model.transcribe.side_effect = RuntimeError('Mock inference failed')
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_job(self.path, run, recognizer)
        error = json.loads((run / 'chunks' / '0-123.error.json').read_text())
        self.assertEqual(error, {'error': 'Mock inference failed', 'source_job': self.path.name})
        self.assertFalse((run / 'chunks' / '0-123.result.json').exists())
        transcribe.process_job(self.path, run, recognizer)
        self.model.transcribe.assert_called_once()

    def test_render_sorts_overlapping_speakers_and_sanitizes_speaker_newlines(self):
        run = transcribe.prepare_run(self.session, 'live', {})
        rows = [{'start': 2, 'end': 3, 'user_id': '456', 'speaker': 'Bo\nInjected', 'text': 'Later'},
                {'start': 1, 'end': 2.5, 'user_id': '123', 'speaker': 'Ada', 'text': 'Earlier'}]
        for index, row in enumerate(rows):
            transcribe.write_json(run / 'chunks' / f'{index}.result.json', {'segments': [row]})
        transcribe.render(run)
        self.assertEqual(json.loads((run / 'transcript.json').read_text()), list(reversed(rows)))
        self.assertIn('Bo Injected', (run / 'transcript.md').read_text())

    def test_replay_cli_processes_saved_jobs_using_mocked_ml(self):
        transcribe.write_json(self.session / 'session.json', {'session_id': 'session'})
        with patch.object(sys, 'argv', ['transcribe.py', 'replay', '--session', str(self.session)]), \
                patch('transcribe.os.nice', create=True), patch('transcribe.os.umask'):
            transcribe.main()
        transcript = self.session / 'recognitions' / 'live' / 'transcript.json'
        self.assertEqual(json.loads(transcript.read_text())[0]['text'], 'Spara-knappen fungerar inte.')
        self.whisper.WhisperModel.assert_called_once()
        self.utils.download_model.assert_called_once_with('KBLab/kb-whisper-small', cache_dir='models')
        config = json.loads((transcript.parent / 'run.json').read_text())
        self.assertEqual(config['model'], 'KBLab/kb-whisper-small')
        self.assertEqual(config['device'], 'cpu')
        self.assertEqual(config['compute_type'], 'int8')

    def test_replay_cli_fails_if_any_chunks_fail(self):
        transcribe.write_json(self.session / 'session.json', {})
        self.model.transcribe.side_effect = RuntimeError('Mock inference failed')
        with patch.object(sys, 'argv', ['transcribe.py', 'replay', '--session', str(self.session)]), \
                patch('transcribe.os.nice', create=True), patch('transcribe.os.umask'):
            with self.assertRaisesRegex(SystemExit, 'failed chunks'):
                transcribe.main()

    def test_cli_rejects_invalid_inputs_before_loading_any_model(self):
        for arguments in [['watch', '--cpu-threads', '0'], ['replay'],
                          ['replay', '--session', str(self.session / 'missing')]]:
            with self.subTest(arguments=arguments), patch.object(sys, 'argv', ['transcribe.py', *arguments]), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    transcribe.main()
                self.assertEqual(result.exception.code, 2)
        self.utils.download_model.assert_not_called()
        self.whisper.WhisperModel.assert_not_called()

    def test_watch_discovers_sessions_and_skips_completed_chunks_on_later_polls(self):
        saved = self.session / 'saved-session'
        saved.mkdir()
        self.path.rename(saved / self.path.name)
        self.audio.rename(saved / self.audio.name)
        transcribe.write_json(saved / 'session.json', {})
        arguments = ['transcribe.py', 'watch', '--root', str(self.session), '--run', 'base-comparison',
                     '--model', 'KBLab/kb-whisper-base']
        with patch.object(sys, 'argv', arguments), patch('transcribe.os.nice', create=True), \
                patch('transcribe.os.umask'), patch('transcribe.time.sleep', side_effect=[None, KeyboardInterrupt]):
            with self.assertRaises(KeyboardInterrupt):
                transcribe.main()
        run = saved / 'recognitions' / 'base-comparison'
        self.assertEqual(json.loads((run / 'run.json').read_text())['model'], 'KBLab/kb-whisper-base')
        self.assertEqual(json.loads((run / 'transcript.json').read_text())[0]['speaker'], 'Ada')
        self.model.transcribe.assert_called_once()

    def test_script_entry_point_handles_ctrl_c_without_a_traceback(self):
        with patch.object(sys, 'argv', ['transcribe.py', 'watch', '--root', str(self.session)]), \
                patch('transcribe.os.nice', create=True), patch('transcribe.os.umask'), \
                patch('transcribe.time.sleep', side_effect=KeyboardInterrupt), \
                patch('importlib.metadata.version', return_value='mock-version'):
            runpy.run_path(str(Path(transcribe.__file__)), run_name='__main__')
        self.model.transcribe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
