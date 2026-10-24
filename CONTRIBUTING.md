# Contributing to Vera

See [README.md](README.md) for running Vera and configuring Discord, analysis and GitHub. Run development commands from the repository root with Node.js 24+ and Python 3.11.

## Setup and tests

The offline tests need Node dependencies but no ML runtime, model downloads, API credentials or running services:

```bash
npm ci
npm test
npm run test:python
```

JavaScript uses Node's built-in test runner; Python uses `unittest`. Tests mock Discord, GitHub, Claude, Ollama and ML libraries, reject unmocked network access, and keep audio and databases in temporary directories.

For the same coverage checks as CI, use a virtual environment:

```bash
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r src/python/requirements-dev.txt
npm run test:coverage
npm run test:coverage:python
```

The JavaScript check requires 95% lines, 85% branches and 90% functions. Python requires 95% combined statement/branch coverage. Reports go in `coverage/`. [.github/workflows/tests.yml](.github/workflows/tests.yml) runs these checks and uploads the reports. Production Python dependencies are only needed to run actual transcription; install them as shown in the README.

## Code map

| File | Responsibility |
| --- | --- |
| `src/js/start.mjs` | Launch the STT worker, wait for readiness, start the bot and coordinate shutdown |
| `src/js/capture.mjs` | Discord login, voice reception and recording commands |
| `src/js/audio.mjs` | Per-speaker PCM buffering, WAV files and atomic job writes |
| `src/python/transcribe.py` | Speech detection, local Whisper inference, checkpoints, transcripts and replay |
| `src/js/analysis.mjs` | Claude/Ollama requests, transcript watching and topic analysis |
| `src/js/workflow.mjs` | SQLite state, access grants, evidence, approvals and GitHub publishing |
| `src/js/review.mjs` | Discord draft cards, commands, modals and review history |
| `src/js/runtime.mjs` | Wire the workflow, startup checks, publishers and Discord previews together |

JavaScript tests mirror the application filenames in `tests/js/`; shared fixtures and network guards are in `tests/js/support/`. Python tests are in `tests/python/test_transcribe.py`. Branding lives in `assets/branding/`; Docker packaging is in `Dockerfile`, `compose.yaml` and `.dockerignore`.

## Working on changes

- Reuse the existing modules and helpers; keep changes focused on the requested behavior.
- Add behavior tests for changed logic, mocking external boundaries with the existing fixtures. Run the relevant language's tests and coverage checks before submitting. For documentation-only edits, check commands, links and `git diff --check`.
- Keep README instructions aimed at users. Update `.env.example` and the guides when configuration or commands change.
- Keep secrets, recordings, transcripts, databases and downloaded models out of commits and logs. Never use real discussion data as a test fixture.
- Preserve original transcript evidence, authorization and approval of the exact revision. An uncertain GitHub creation must only be reconciled by lookup, never retried automatically.

## Transcription and replay

Capture writes 12-second per-speaker WAV files and publishes each job only after its audio is complete. The worker combines adjacent files until a one-second speech pause. Long passages use 30-second windows with overlap; word timestamps prevent duplicate output. Results and checkpoints are written atomically so unfinished work can resume. Run one Vera instance per storage directory and one worker per transcript run.

Replay retained audio into a separate run using the production Python environment:

```bash
.venv/bin/python src/python/transcribe.py replay --session data/SESSION_ID \
  --model KBLab/kb-whisper-small --language sv --run small-pauses
```

Replace `SESSION_ID` with a saved session directory. Replay preserves source audio. A run refuses different model/settings; choose a new `--run` name instead. To have the bot analyze that run, set `STT_RUN` and restart. Use `--help` for worker options. Both watch and replay accept any compatible faster-whisper model and its supported spoken-language code through `--model` and `--language`; the standard launcher forwards `STT_MODEL` and `STT_LANGUAGE`. Defaults remain `KBLab/kb-whisper-small` and `sv`. For example, replay English speech with `--model small --language en --run english-small`. Issue output language is configured separately through `ISSUE_LANGUAGE`.

Failed transcription writes `*.error.json` in the run's `chunks/` directory; fix the cause and remove the affected error file to retry. Analysis failures write `analysis-error.json` in the session and retry after a minute. Back up recordings and the workflow database together, including SQLite WAL/SHM state; restoring an old database can lose publication history.

## Integration limits

- Tests do not validate real Discord voice capture, model quality or live API compatibility. Check packet counts and real recordings when changing audio handling; voice receive is unofficial and timestamps are approximate.
- Analysis uses batches of up to 12 new and 12 preceding transcript segments, a summary, topics and existing issue titles. Context over 25 KB fails explicitly; models can miss or misinterpret discussion.
- Startup checks speech inference, optional GitHub access and a synthetic analysis request before Discord login. The GitHub write check sends an invalid blank title and creates no issue; the Claude check costs a small API request.
- SQLite uses Node's experimental built-in API. Publication state must be committed before the single permitted GitHub creation attempt; GitHub offers no creation idempotency key.
