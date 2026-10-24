import contextlib
from array import array
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

from src.python import transcribe


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
        whisper, utils, onnx, psutil, audio, vad = [ModuleType(name) for name in
            ('faster_whisper', 'faster_whisper.utils', 'onnxruntime', 'psutil',
             'faster_whisper.audio', 'faster_whisper.vad')]
        self.model = Mock()
        self.model.transcribe.side_effect = lambda *args, **kwargs: (iter([
            SimpleNamespace(start=0.1, end=1.5, text='  Spara-knappen fungerar inte.  ', words=[
                SimpleNamespace(start=0.1, end=1.5, word=' Spara-knappen fungerar inte.')]),
            SimpleNamespace(start=1.5, end=2, text=' '),
        ]), SimpleNamespace(language='sv'))
        whisper.WhisperModel = Mock(return_value=self.model)
        utils.download_model = Mock(return_value=str(self.session / 'mock-snapshot'))
        onnx.disable_telemetry_events = Mock()
        psutil.Process = Mock(return_value=SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=64 * 1024**2)))
        self.whisper, self.utils, self.onnx = whisper, utils, onnx
        audio.decode_audio = Mock(side_effect=lambda path, sampling_rate: array('f', [1]) * round(
            json.loads(Path(path).with_suffix('.job.json').read_text())['duration'] * sampling_rate))
        vad.get_speech_timestamps = Mock(side_effect=lambda samples, **options: [{'start': 0, 'end': len(samples)}])
        self.decode, self.vad = audio.decode_audio, vad.get_speech_timestamps
        numpy = ModuleType('numpy')
        numpy.zeros = Mock(side_effect=lambda size, dtype: array('f', [0]) * size)
        numpy.float32 = 'mock-float32'
        self.numpy = numpy
        self.enterContext(patch.dict(sys.modules, {'faster_whisper': whisper, 'faster_whisper.utils': utils,
                                                 'faster_whisper.audio': audio, 'faster_whisper.vad': vad,
                                                 'onnxruntime': onnx, 'psutil': psutil, 'numpy': numpy}))
        self.enterContext(patch('src.python.transcribe.version', return_value='mock-version'))
        self.enterContext(patch.object(socket.socket, 'connect', side_effect=AssertionError('Network disabled in tests')))
        self.enterContext(patch.object(socket, 'create_connection', side_effect=AssertionError('Network disabled in tests')))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def recognizer(self):
        return transcribe.Recognizer(self.args)

    def write_job(self, index, start, duration=12, user_id='123', speaker='Ada'):
        name = f'{index}-{user_id}'
        transcribe.write_json(self.session / f'{name}.job.json', {
            'audio': f'{name}.wav', 'user_id': user_id, 'speaker': speaker, 'start': start, 'duration': duration})
        (self.session / f'{name}.wav').write_bytes(b'original recording')

    def progress(self, through):
        transcribe.write_json(self.session / 'capture-progress.json', {'through': through})

    def output(self, run):
        return json.loads((run / 'transcript.json').read_text())

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
        with patch('src.python.transcribe.time.perf_counter', side_effect=[10, 10.25]):
            rows, elapsed = recognizer.transcribe(self.audio)
        self.assertEqual(rows, [{'start': 0.1, 'end': 1.5, 'text': 'Spara-knappen fungerar inte.'}])
        self.assertEqual(elapsed, 0.25)
        self.model.transcribe.assert_called_once_with(self.audio, language='sv', beam_size=1,
                                                     condition_on_previous_text=False, vad_filter=False,
                                                     word_timestamps=True)

    def test_startup_check_exercises_vad_and_consumes_decoder_output(self):
        recognizer = self.recognizer()
        consumed = []

        def inference(audio, **options):
            def segments():
                consumed.append(options['vad_filter'])
                yield SimpleNamespace(text='ignored startup output')
            self.assertEqual(len(audio), 16_000)
            self.assertEqual(options['language'], 'sv')
            self.assertEqual(options['beam_size'], 1)
            self.assertTrue(options['word_timestamps'])
            return segments(), None

        self.model.transcribe.side_effect = inference
        recognizer.check()
        self.numpy.zeros.assert_called_once_with(16_000, dtype='mock-float32')
        self.assertEqual(consumed, [True, False])

    def test_startup_failure_stops_before_ready_or_processing_sessions(self):
        for failure in ('download', 'load', 'vad', 'decode'):
            with self.subTest(failure=failure):
                self.utils.download_model.side_effect = RuntimeError('download failed') if failure == 'download' else None
                self.whisper.WhisperModel.side_effect = RuntimeError('load failed') if failure == 'load' else None

                def inference(audio, **options):
                    def segments():
                        if failure == ('vad' if options['vad_filter'] else 'decode'):
                            raise RuntimeError(f'{failure} failed')
                        yield SimpleNamespace(text='ignored startup output')
                    return segments(), None

                self.model.transcribe.side_effect = inference
                output = io.StringIO()
                with patch.object(sys, 'argv', ['transcribe.py', 'watch', '--root', str(self.session)]), \
                        patch('src.python.transcribe.os.nice', create=True), patch('src.python.transcribe.os.umask'), \
                        patch('src.python.transcribe.prepare_run') as prepare, contextlib.redirect_stdout(output):
                    with self.assertRaisesRegex(SystemExit, f'STT startup check failed: {failure} failed'):
                        transcribe.main()
                self.assertNotIn('STT startup check passed.', output.getvalue())
                prepare.assert_not_called()

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
        for key, value in [('model', 'small'), ('language', 'en')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'another model/settings'):
                transcribe.prepare_run(self.session, 'live', {**config, key: value})
        self.assertEqual(json.loads((run / 'run.json').read_text()), config)
        for name in ['../escape', '', 'x' * 65]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                transcribe.prepare_run(self.session, name, config)

    def test_session_writes_absolute_timestamps_metrics_and_transcripts_once(self):
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer, final=True)
        result = json.loads((run / 'chunks' / 'speech-123-192000.result.json').read_text())
        expected = [{'start': 12.1, 'end': 13.5, 'text': 'Spara-knappen fungerar inte.',
                     'user_id': '123', 'speaker': 'Ada'}]
        self.assertEqual(result['segments'], expected)
        self.assertEqual(result['metrics']['audio_seconds'], 2)
        self.assertEqual(result['metrics']['rss_mib'], 64)
        self.assertEqual(json.loads((run / 'transcript.json').read_text()), expected)
        self.assertIn('[00:00:12.100–00:00:13.500] Ada (123)', (run / 'transcript.md').read_text())
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.model.transcribe.assert_called_once()
        self.assertEqual(self.audio.read_bytes(), b'mocked audio; never decoded by ML')
        self.assertEqual(list(run.rglob('*.tmp')), [])

    def test_failed_chunks_record_error_and_are_not_retried_automatically(self):
        recognizer = self.recognizer()
        self.model.transcribe.side_effect = RuntimeError('Mock inference failed')
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer, final=True)
        error = json.loads((run / 'chunks' / 'speech-123-192000.error.json').read_text())
        self.assertEqual(error, {'error': 'Mock inference failed', 'user_id': '123', 'start': 12})
        self.assertFalse((run / 'chunks' / 'speech-123-192000.result.json').exists())
        self.assertFalse((run / 'complete.json').exists())
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.model.transcribe.assert_called_once()

    def test_speech_crossing_file_boundary_waits_for_a_pause_and_is_transcribed_together(self):
        self.write_job(0, 0)
        self.progress(12)
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        self.vad.side_effect = [[{'start': 8 * transcribe.RATE, 'end': 12 * transcribe.RATE}],
                                [{'start': round(0.2 * transcribe.RATE), 'end': round(4.2 * transcribe.RATE)}],
                                [{'start': round(0.2 * transcribe.RATE), 'end': round(10.2 * transcribe.RATE)}], []]
        self.model.transcribe.side_effect = lambda *args, **kwargs: (iter([
            SimpleNamespace(text='A complete sentence', words=[
                SimpleNamespace(start=0.2, end=10.2, word='A complete sentence')])]), None)
        transcribe.process_session(self.session, run, recognizer)
        self.model.transcribe.assert_not_called()
        self.assertEqual(self.output(run), [])
        self.assertFalse((run / 'complete.json').exists())

        self.write_job(1, 12)
        self.progress(24)
        transcribe.process_session(self.session, run, recognizer)
        self.assertEqual(len(self.model.transcribe.call_args.args[0]), round(10.4 * transcribe.RATE))
        self.model.transcribe.assert_called_once()
        self.assertEqual(len(self.output(run)), 1)
        self.assertEqual((self.output(run)[0]['start'], self.output(run)[0]['end']), (8, 18))
        self.assertEqual(self.decode.call_count, 5)
        self.vad.assert_called_with(self.vad.call_args.args[0], min_silence_duration_ms=1000, speech_pad_ms=0)

    def test_speaker_going_quiet_finishes_without_another_audio_file(self):
        self.write_job(0, 0)
        self.progress(12)
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        self.vad.side_effect = [[{'start': 0, 'end': 12 * transcribe.RATE}],
                                [{'start': 0, 'end': 12 * transcribe.RATE}], []]
        transcribe.process_session(self.session, run, recognizer)
        self.model.transcribe.assert_not_called()
        self.progress(24)
        transcribe.process_session(self.session, run, recognizer)
        samples = self.model.transcribe.call_args.args[0]
        self.assertEqual(len(samples), round(12.2 * transcribe.RATE))
        self.assertTrue(all(value == 0 for value in samples[12 * transcribe.RATE:]))
        self.model.transcribe.assert_called_once()

    def test_simultaneous_speakers_have_independent_audio_and_pause_detection(self):
        self.write_job(0, 0)
        self.write_job(0, 0, user_id='456', speaker='Bo')
        self.progress(12)
        self.decode.side_effect = lambda path, sampling_rate: array('f', [1 if '123' in path else 2]) * (12 * sampling_rate)
        self.vad.side_effect = [[{'start': 0, 'end': 5 * transcribe.RATE}], [],
                                [{'start': 0, 'end': 12 * transcribe.RATE}]]
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer)
        self.assertEqual([row['user_id'] for row in self.output(run)], ['123'])
        self.assertTrue(all(value == 1 for value in self.model.transcribe.call_args.args[0]))
        self.vad.side_effect = lambda audio, **options: [{'start': 0, 'end': len(audio)}]
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.assertEqual({row['user_id'] for row in self.output(run)}, {'123', '456'})
        self.assertTrue(all(value == 2 for value in self.model.transcribe.call_args.args[0]))

    def test_long_speech_carries_context_and_emits_overlap_words_once_after_restart(self):
        for index in range(4):
            self.write_job(index, index * 12)
        self.progress(48)

        def inference(audio, **options):
            words = ([SimpleNamespace(start=1, end=2, word='Start'),
                      SimpleNamespace(start=27, end=27.5, word=' shared'),
                      SimpleNamespace(start=27.8, end=28.2, word=' boundary')]
                     if len(audio) == 30 * transcribe.RATE else
                     [SimpleNamespace(start=1, end=1.5, word=' shared'),
                      SimpleNamespace(start=1.8, end=2.2, word=' boundary'),
                      SimpleNamespace(start=5, end=5.5, word=' shared')])
            return iter([SimpleNamespace(text='speech', words=words)]), None

        self.model.transcribe.side_effect = inference
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer)
        self.assertEqual([row['text'] for row in self.output(run)], ['Start shared'])
        self.model.transcribe.assert_called_once()
        self.assertFalse((run / 'complete.json').exists())
        # A fresh recognizer resumes solely from atomic result files, including the uncommitted tail.
        transcribe.process_session(self.session, run, self.recognizer(), final=True)
        self.assertEqual([row['text'] for row in self.output(run)], ['Start shared', 'boundary shared'])
        self.assertEqual(self.output(run)[1]['start'], 27.8)
        self.assertEqual([len(call.args[0]) / transcribe.RATE for call in self.model.transcribe.call_args_list], [30, 22])
        self.assertEqual(json.loads((run / 'complete.json').read_text())['source_jobs'],
                         [f'{index}-123.job.json' for index in range(4)])
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.assertEqual(self.model.transcribe.call_count, 2)

    def test_stop_flushes_a_short_unfinished_passage_and_silence_does_not_hallucinate(self):
        self.write_job(0, 0, duration=0.5)
        self.progress(0.5)
        self.model.transcribe.side_effect = lambda *args, **kwargs: (iter([
            SimpleNamespace(text='Hello', words=[SimpleNamespace(start=0.1, end=0.4, word='Hello')])]), None)
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer)
        self.model.transcribe.assert_not_called()
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.assertEqual(len(self.output(run)), 1)
        self.assertTrue((run / 'complete.json').exists())

        silent = transcribe.prepare_run(self.session, 'silent', recognizer.config)
        self.vad.side_effect = lambda audio, **options: []
        transcribe.process_session(self.session, silent, recognizer, final=True)
        self.assertEqual(self.output(silent), [])
        self.model.transcribe.assert_called_once()
        self.assertTrue((silent / 'complete.json').exists())

    def test_corrupt_audio_records_an_error_and_can_be_retried_without_losing_the_tail(self):
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        self.decode.side_effect = lambda path, sampling_rate: array('f', [0])
        transcribe.process_session(self.session, run, recognizer, final=True)
        error = run / 'chunks' / 'speech-123-192000.error.json'
        self.assertIn('duration does not match', json.loads(error.read_text())['error'])
        self.assertFalse((run / 'complete.json').exists())
        error.unlink()
        self.decode.side_effect = lambda path, sampling_rate: array('f', [1]) * (2 * sampling_rate)
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.assertEqual(len(self.output(run)), 1)
        self.assertTrue((run / 'complete.json').exists())

    def test_resampling_rounding_keeps_the_window_length_and_pads_one_missing_sample(self):
        self.decode.side_effect = lambda path, sampling_rate: array('f', [1]) * (2 * sampling_rate - 1)
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer, final=True)
        samples = self.model.transcribe.call_args.args[0]
        self.assertEqual(len(samples), 2 * transcribe.RATE)
        self.assertEqual(samples[-1], 0)
        self.assertTrue((run / 'complete.json').exists())

    def test_long_leading_silence_does_not_count_toward_the_speech_limit(self):
        for index in range(3):
            self.write_job(index, index * 12)
        self.progress(36)
        self.vad.side_effect = [[{'start': 24 * transcribe.RATE, 'end': 30 * transcribe.RATE}],
                                [{'start': transcribe.PADDING, 'end': round(12.2 * transcribe.RATE)}]]
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer)
        self.model.transcribe.assert_not_called()
        self.assertEqual(self.output(run), [])
        checkpoint = json.loads(next((run / 'chunks').glob('*.result.json')).read_text())
        self.assertEqual(checkpoint['next_sample'], round(23.8 * transcribe.RATE))

    def test_invalid_source_metadata_blocks_completion_until_its_error_is_cleared(self):
        transcribe.write_json(self.path, {**self.job, 'audio': '../escape.wav'})
        recognizer = self.recognizer()
        run = transcribe.prepare_run(self.session, 'live', recognizer.config)
        transcribe.process_session(self.session, run, recognizer, final=True)
        error = run / 'chunks' / '0-123.error.json'
        self.assertIn('WAV in the session directory', json.loads(error.read_text())['error'])
        transcribe.write_json(self.path, self.job)
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.model.transcribe.assert_not_called()
        self.assertFalse((run / 'complete.json').exists())
        error.unlink()
        transcribe.process_session(self.session, run, recognizer, final=True)
        self.assertTrue((run / 'complete.json').exists())

    def test_missing_word_timestamps_fail_instead_of_duplicating_uncertain_overlap(self):
        self.model.transcribe.side_effect = lambda *args, **kwargs: (iter([
            SimpleNamespace(text='speech', words=None)]), None)
        with self.assertRaisesRegex(ValueError, 'Word timestamps are required'):
            self.recognizer().transcribe(object())

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
                patch('src.python.transcribe.os.nice', create=True), patch('src.python.transcribe.os.umask'):
            transcribe.main()
        transcript = self.session / 'recognitions' / 'live' / 'transcript.json'
        self.assertEqual(json.loads(transcript.read_text())[0]['text'], 'Spara-knappen fungerar inte.')
        self.whisper.WhisperModel.assert_called_once()
        self.utils.download_model.assert_called_once_with('KBLab/kb-whisper-small', cache_dir='models')
        config = json.loads((transcript.parent / 'run.json').read_text())
        self.assertEqual(config['model'], 'KBLab/kb-whisper-small')
        self.assertEqual(config['language'], 'sv')
        self.assertEqual(config['device'], 'cpu')
        self.assertEqual(config['compute_type'], 'int8')

    def test_replay_cli_fails_if_any_chunks_fail(self):
        transcribe.write_json(self.session / 'session.json', {})
        self.model.transcribe.side_effect = RuntimeError('Mock inference failed')
        with patch.object(sys, 'argv', ['transcribe.py', 'replay', '--session', str(self.session)]), \
                patch('src.python.transcribe.os.nice', create=True), patch('src.python.transcribe.os.umask'), \
                patch.object(transcribe.Recognizer, 'check'):
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

    def test_watch_uses_alternative_model_and_language_and_skips_completed_chunks(self):
        saved = self.session / 'saved-session'
        saved.mkdir()
        self.path.rename(saved / self.path.name)
        self.audio.rename(saved / self.audio.name)
        transcribe.write_json(saved / 'session.json', {'status': 'stopped'})
        self.model.transcribe.side_effect = lambda *args, **kwargs: (iter([
            SimpleNamespace(text='The save button is broken.', words=[
                SimpleNamespace(start=0.1, end=1.5, word=' The save button is broken.')])]), SimpleNamespace(language='en'))
        arguments = ['transcribe.py', 'watch', '--root', str(self.session), '--run', 'english-small',
                     '--model', 'small', '--language', 'en']
        with patch.object(sys, 'argv', arguments), patch('src.python.transcribe.os.nice', create=True), \
                patch('src.python.transcribe.os.umask'), patch('src.python.transcribe.time.sleep', side_effect=[None, KeyboardInterrupt]):
            with self.assertRaises(KeyboardInterrupt):
                transcribe.main()
        run = saved / 'recognitions' / 'english-small'
        config = json.loads((run / 'run.json').read_text())
        self.assertEqual(config['model'], 'small')
        self.assertEqual(config['language'], 'en')
        self.utils.download_model.assert_called_once_with('small', cache_dir='models')
        self.assertEqual(json.loads((run / 'transcript.json').read_text())[0], {
            'start': 12.1, 'end': 13.5, 'text': 'The save button is broken.', 'user_id': '123', 'speaker': 'Ada'})
        self.assertEqual(self.model.transcribe.call_count, 3)
        for call in self.model.transcribe.call_args_list:
            self.assertEqual(call.kwargs['language'], 'en')

    def test_watch_leaves_pending_audio_idle_until_stop_even_when_progress_does_not_change(self):
        saved = self.session / 'saved-session'
        saved.mkdir()
        self.path.rename(saved / self.path.name)
        self.audio.rename(saved / self.audio.name)
        transcribe.write_json(saved / 'session.json', {'status': 'recording'})
        transcribe.write_json(saved / 'capture-progress.json', {'through': 14})
        polls = 0

        def poll(_):
            nonlocal polls
            polls += 1
            if polls == 2:
                transcribe.write_json(saved / 'session.json', {'status': 'stopped'})
            if polls == 3:
                raise KeyboardInterrupt

        with patch.object(sys, 'argv', ['transcribe.py', 'watch', '--root', str(self.session)]), \
                patch('src.python.transcribe.os.nice', create=True), patch('src.python.transcribe.os.umask'), \
                patch('src.python.transcribe.time.sleep', side_effect=poll):
            with self.assertRaises(KeyboardInterrupt):
                transcribe.main()
        self.assertEqual(self.vad.call_count, 2)
        self.assertEqual(self.model.transcribe.call_count, 3)
        self.assertTrue((saved / 'recognitions' / 'live' / 'complete.json').exists())

    def test_script_entry_point_handles_ctrl_c_without_a_traceback(self):
        with patch.object(sys, 'argv', ['transcribe.py', 'watch', '--root', str(self.session)]), \
                patch('src.python.transcribe.os.nice', create=True), patch('src.python.transcribe.os.umask'), \
                patch('src.python.transcribe.time.sleep', side_effect=KeyboardInterrupt), \
                patch('importlib.metadata.version', return_value='mock-version'):
            runpy.run_path(str(Path(transcribe.__file__)), run_name='__main__')
        self.assertEqual(self.model.transcribe.call_count, 2)


if __name__ == '__main__':
    unittest.main()
