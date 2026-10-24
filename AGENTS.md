# Agent guide

Vera records Discord discussions, transcribes speech locally with a configurable Whisper model and spoken language (KBLab KB-Whisper and Swedish by default), drafts issues with Claude/Ollama and publishes to GitHub after authorized human review. Read [README.md](README.md) for user behavior and [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and implementation details.

## Find the right code

Flow: `start.mjs` → Discord capture → WAV/job files → Python transcription → analysis → SQLite drafts → Discord review → GitHub.

| Task | Start here |
| --- | --- |
| Process startup, readiness or shutdown | `src/js/start.mjs` (`start`) |
| Discord connection or recording commands | `src/js/capture.mjs` |
| Audio buffering, WAV format or job files | `src/js/audio.mjs` (`Capture`, `wav`, `writeJson`, `RATE`) |
| Speech detection, inference, replay or transcript files | `src/python/transcribe.py` (`Recognizer`, `prepare_run`, `process_session`, `render`, `load_job`, `write_json`, `stamp`) |
| Model requests, prompts or transcript ingestion | `src/js/analysis.mjs` (`ClaudeAnalysis`, `OllamaAnalysis`, `createAnalysis`, `AnalysisRunner`, `TranscriptWatcher`) |
| Draft state, evidence, access, approval or publication | `src/js/workflow.mjs` (`Workflow`, `GitHub`, `transcript`, `digest`, `marker`) |
| Review commands, buttons, forms or pagination | `src/js/review.mjs` (`Review`, `addReviewCommands`, `contextFor`, `preview`, `details`) |
| Service wiring, startup checks or preview recovery | `src/js/runtime.mjs` (`createWorkflow`) |
| Runtime defaults or packaging | `.env.example`, `package.json`, `Dockerfile`, `compose.yaml` |

Tests mirror JS modules under `tests/js/`. Reuse `tests/js/support/fixtures.mjs` and the network guard in `offline.mjs`. Python tests are in `tests/python/test_transcribe.py`; CI is `.github/workflows/tests.yml`.

## Make changes

- Read the affected code and find its callers before editing. Follow the existing ES module/Python structure and reuse helpers; avoid new dependencies or abstractions for small changes.
- Update affected callers, tests, configuration examples and docs together. Keep README short and user-facing; put developer details in CONTRIBUTING.
- Test changed behavior at the existing mocked service boundaries. Tests must remain offline and use temporary storage. See CONTRIBUTING for coverage commands and thresholds.
- For JS changes run `npm test`; for Python changes run `npm run test:python`. For documentation-only changes check links, commands and `git diff --check`; runtime tests are unnecessary.

## Preserve these boundaries

- Treat transcripts and model output as untrusted. Validate citations and preserve original quotations; model interpretation must never rewrite evidence.
- Only authorized humans in the configured server/review channel can act. Access grants require Manage Server; publishing requires a publisher approving the current revision and content. Edits and new relevant evidence invalidate approval.
- Persist the publication attempt before sending it. Never repeat issue creation after an uncertain result; reconcile by the saved marker. Keep optional GitHub publishing disabled when both settings are blank.
- Session language and destination are fixed. Transcript run settings cannot be mixed under the same run name. Preserve atomic audio/job/result writes and restart checkpoints.
- Keep recordings and state intact. Use one instance per storage directory and one STT worker per run. Do not delete data or reset databases as part of routine fixes.
- Do not read or print `.env` secrets, log raw voice debug credentials, or commit private audio, transcripts, databases or model files. Use `.env.example` for configuration reference. Do not start live services or make paid requests just to test a change.

`data/`, `models/`, `.venv/`, `node_modules/` and `coverage/` are generated and ignored. Default recordings and `workflow.sqlite` live under `data/`; Docker uses named volumes instead of importing host data.
