# Vera

<p align="center">
  <img src="assets/branding/vera-readme-v2.png" alt="Vera — a female android assistant in charcoal, ivory and copper wearing a headset" width="640">
</p>

Vera turns project discussions into GitHub issue drafts that people can review and approve in Discord.

It records voice separately for each speaker, transcribes locally, and uses Claude or Ollama to summarize the discussion and draft issues in your chosen language. Original transcript quotations remain attached to the proposed issue as evidence. Publishing always requires an authorized person's approval of the current revision.

## Repository layout

- `src/js/` — Discord bot, workflow, analysis, and launcher.
- `src/python/` — transcription worker and Python dependency requirements.
- `tests/js/` and `tests/python/` — tests separated by language, with offline fixtures.
- `assets/` — branding images and prompts.
- `coverage/` — generated test reports (ignored by Git).
- `data/` and `models/` — local recordings, review state, and model weights (ignored by Git).

Run commands from the repository root. The npm manifest and environment settings
live there; Python requirements live beside the worker in `src/python/`.

## Requirements

- Node.js 24 or newer and Python 3.11.
- A Discord bot installed in your server.
- Optional for publishing: a GitHub repository and a fine-grained token limited to that repository, with Issues read/write permission.
- An Anthropic API key, or a local Ollama installation.

The default STT configuration is Swedish KB-Whisper small on CPU with `int8` precision and two inference threads. Small improves Swedish word recognition over base in [KBLab's published benchmarks](https://huggingface.co/KBLab/kb-whisper-small#wer-compared-to-openai), at the cost of more CPU work and RAM. The first run downloads approximately 490 MB of [model and tokenizer files](https://huggingface.co/KBLab/kb-whisper-small/tree/main). Capture, STT and text analysis run independently. Claude requires no local text model; Ollama also defaults to CPU inference so the GPU remains available for other applications.

## Installation

```bash
npm ci
python3.11 -m venv .venv
.venv/bin/python -m pip install -r src/python/requirements.txt
cp .env.example .env
chmod 600 .env
```

Fill in `.env` locally. Keep API keys and tokens out of source control and chat.

Set both `GITHUB_REPO=owner/repository` and `GITHUB_TOKEN` to enable GitHub. Leave both
blank or unset to run without GitHub: startup prints a prominent warning, recording,
analysis and draft review continue, and posting buttons (including in full details)
and publication lookup controls are hidden. Old posting controls are refused and
pending approvals cannot publish while GitHub is disabled. Duplicate lookup is skipped.
Drafts from sessions started without GitHub stay local; start a new recording session
after configuring GitHub to create publishable drafts.

When either GitHub setting is supplied, startup requires both and checks repository
availability, issue reading and issue creation access before connecting to Discord.
The write check sends a blank title, which must fail specifically at issue title
validation; it never supplies a valid title or creates a test issue.
Invalid credentials, missing permissions, disabled/archived repositories, connection
failures and timeouts stop startup with an error. Fix the settings and restart.

For Claude:

```dotenv
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=YOUR_API_KEY
ANTHROPIC_MODEL=claude-sonnet-5-5
ISSUE_LANGUAGE=English
```

Claude receives transcript excerpts, speaker names/IDs, summaries, topic descriptions and existing issue numbers/titles. Audio stays local. API requests incur charges; failed analysis is retried after one minute. Vera has no total spending cap, so configure one in your Anthropic account. The integration uses the direct [Messages API](https://platform.claude.com/docs/en/api/messages/create) with [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

For local text processing, set `LLM_PROVIDER=ollama`, install [Ollama](https://docs.ollama.com/) and run `ollama pull qwen3.5:4b`. `OLLAMA_URL` and `OLLAMA_MODEL` configure this provider. Ollama uses two CPU threads, disables GPU offloading and unloads the model after each request. CPU analysis can take minutes.

`ISSUE_LANGUAGE` controls the summary and generated issue text. Original source quotations remain in the language spoken. Language and destination are frozen per session; changes apply to new sessions. Restart Vera after changing environment settings.

## Discord setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and put its bot token in `.env`.
2. Install it in your server with the `bot` and `applications.commands` scopes. Grant View Channels, Connect, Send Messages, Embed Links and Read Message History. No privileged Message Content or Server Members intent is required.
3. Enable Developer Mode in Discord, copy your server, voice-channel and review-channel IDs, and set them in `.env`. Check channel permission overrides.
4. Use a dedicated bot application: startup replaces that application's existing server commands with Vera's commands.

Start Vera:

```bash
npm start
```

This starts the local transcription worker and Discord bot together, using `.venv`'s
Python and the settings in `.env`. Startup loads the configured STT model and runs
one second of synthetic silence through voice detection and the Whisper decoder.
Only after that succeeds does the bot check GitHub (when configured) and make one
synthetic LLM analysis request using the configured provider/model and the normal
structured output format. No recorded audio or discussion is used by these checks.
The Claude check incurs a small API charge on every startup; Ollama runs locally.
Model downloads/loading and CPU inference can delay startup. Download, model load,
inference, provider authentication, quota, connection, timeout or invalid output
failures stop Vera before it connects to Discord. The STT worker reuses its loaded
model for transcription after the check. `RECORDINGS_DIR` and `STT_RUN` apply to both
processes. Ctrl+C stops both; the bot saves its final audio before the worker stops.
Any unfinished transcription jobs resume on the next start. If either process fails,
Vera stops the other and exits with an error.

If you already have base-model transcripts under the `live` run, stop Vera,
set `STT_RUN=small-cpu` in `.env`, then run `npm start` again.
This creates separate small-model transcripts, including for retained sessions;
existing recordings and base transcripts are preserved. Reusing `live` with changed
model settings fails deliberately. To keep using base instead, set
`STT_MODEL=KBLab/kb-whisper-base` in `.env`.

In the configured review channel, a person with **Manage Server** permission grants access with `/vera access user:@person role:publisher`. Reviewer access permits recording and draft review; Publisher also permits issue creation. `/vera access` shows your access, and `role:none` revokes it. Grants persist across restarts. Revocation cancels approvals whose publication has not started; it cannot undo an in-flight or completed GitHub request.

## Docker

Copy `.env.example` to `.env` and fill in your settings, then run:

```bash
docker compose up --build -d
docker compose logs -f vera
```

The included `compose.yaml` loads `.env` with `env_file`. The image installs Node.js 24,
Python 3.11 and both sets of dependencies, then runs the same launcher as `npm start`
directly so it receives Docker's shutdown signal. This starts both transcription and
the Discord bot. Secrets, local recordings and model files are excluded from the build.

Named volumes retain recordings/review state and downloaded STT models across container
replacements. Compose sets `RECORDINGS_DIR=/app/data` so both processes use the persistent
volume. Existing host `data/` and `models/` directories are not imported. The first start
downloads the STT model. Use `docker compose down` to stop Vera and retain its volumes;
adding `--volumes` deletes the stored recordings, review state and models.

For Ollama, set `OLLAMA_URL` in `.env` to an address reachable from the container;
`localhost` inside the container refers to Vera itself. After editing `.env`, run
`docker compose up -d --force-recreate` to apply the new settings.

## Recording and review

- `/vera start` posts a recording notice and joins the voice channel. Tell participants before recording.
- `/vera status` shows captured packet counts and receive/decode errors. Verify that the packet count increases when someone speaks.
- `/vera stop` disconnects and flushes the final audio. Leave STT running until queued chunks finish.
- `/vera drafts` lists drafts; `/vera draft id:...` opens one.
- Draft cards have Post issue, Edit, Comment, Reject and Details & history buttons. Cards update in place; full issues and review history open privately with pagination. Long issues require opening the full preview before approval.
- `/vera edit`, `/vera note`, `/vera merge` and `/vera reject` provide equivalent review commands. Comments remain in review history; use Edit to change proposed issue text. Evidence selection can change, but original quotations cannot be rewritten.
- `/vera summary session:...` shows a discussion summary.
- `/vera reconcile id:...` looks up an uncertain publication without repeating issue creation.

Only authorized human publishers in the configured server/channel can publish. Edits and new relevant discussion invalidate previous approval controls. Existing GitHub issue titles are provided as context for possible duplicates, which still require human judgment.

Each topic settles about one minute after its latest newly analyzed relevant evidence. Unrelated discussion does not reset that topic. Stopping waits for the final STT output before flushing remaining topics. Settled drafts can be reviewed while another analysis request is running.

Transcription joins adjacent recording files for each speaker and waits for about one
second of silence before processing a passage, keeping 200 ms of padding. Ongoing
speech at a file boundary stays buffered. Long uninterrupted passages use windows of
at most 30 seconds, with two seconds of previously processed context and a two-second
uncommitted tail carried into the next window. Word timestamps select which window
publishes each word. Other speakers do not delay that speaker's pause detection.
The worker also detects silence when no further audio file is created for a speaker.
Stopping flushes unfinished passages; atomic results preserve progress across restarts.
The 12-second recording-file cadence and CPU inference add to the transcription delay.

## Recordings and replay

`RECORDINGS_DIR` defaults to `./data`; both processes must use the same location. Each session stores per-speaker WAV chunks, speaker metadata, timestamps, receive errors, and separate transcription runs. Review state and publication attempts are stored in `data/workflow.sqlite` with SQLite WAL/SHM sidecars.

Recordings are retained until you delete them. Budget roughly 0.7 GB per recorded speaker-hour. Restrict access and agree on retention with participants. Back up the database with the recordings; restoring an old database can lose publication state.

For a clean start after upgrading from fixed-window transcription, stop Vera and
clear the old contents of `RECORDINGS_DIR` before restarting. This removes recordings,
transcripts, draft history and access grants. Keep `STT_RUN=live`; no run-name change
is needed for a clean start.

Replay retained audio with small in a separate run (including recordings originally transcribed with base):

```bash
.venv/bin/python src/python/transcribe.py replay --session data/SESSION_ID \
  --model KBLab/kb-whisper-small --run small-pauses
```

Runs never overwrite source audio. Changing settings under an existing run name fails to prevent mixed results. Failed chunks produce `.error.json` files; fix the cause and remove the affected error file to retry. Use one worker per run. Other spoken languages require a suitable multilingual model and `--language` setting. To analyze a different run, set `STT_RUN` and restart the bot.

## Tests

Run the tests with Node.js 24+ and Python 3.11+:

```bash
npm ci
npm test
npm run test:python
```

The tests use Node's built-in test runner and Python's standard-library `unittest`.
Whisper model loading/downloads, ONNX Runtime, process metrics, Claude/Ollama responses,
GitHub issue listing/creation and Discord interactions are mocked. No Python packages,
model weights, running model servers, Discord login or API credentials are required.
Test network guards reject unmocked connections. Audio files and SQLite databases use
temporary directories; the real data directory is never used.

Tests cover recording start/status/stop, Discord review commands and modals, original
evidence preservation, approval invalidation, concurrent publication, uncertain POST
recovery, preview-message recovery, and transcription watch/replay. They use real
application logic with external boundaries mocked, so refactors can change internal
structure while preserving the behavior these tests assert.

For coverage reports and the same checks as GitHub Actions:

```bash
python3 -m pip install -r src/python/requirements-dev.txt
npm run test:coverage
npm run test:coverage:python
```

JavaScript uses Node's built-in V8 coverage, excluding tests and dependencies, and
requires at least 95% lines, 85% branches and 90% functions. All seven application
modules, including the Discord entry point, are exercised. Python uses `coverage.py`
with branch measurement and a 95% combined statement/branch minimum for `src/python/transcribe.py`.
The two tools count coverage differently; their percentages are reported separately.

The workflow in `.github/workflows/tests.yml` runs coverage on pushes and pull requests
and uploads `coverage/lcov.info` and `coverage/python.xml` as a `coverage` artifact. Its only
Python dependency is the coverage tool; it never installs `src/python/requirements.txt` or
downloads ML models. Hugging Face offline flags provide an extra safeguard.

## Current limits

- Audio files use fixed 12-second windows; transcription combines them at speech pauses. A pause can still occur mid-sentence, and word timestamps around forced splits are approximate. Timing follows the local receive clock and is approximate. Validate boundaries on real Discord recordings.
- The LLM receives up to 12 new transcript segments, 12 preceding segments, a running summary and existing topics. It is instructed to interpret likely STT errors from context and flag uncertain meaning, but it can still miss or misinterpret ideas. It cannot listen to saved audio. Review the evidence before publishing.
- Oversized analysis context fails explicitly at 25 KB. Large repositories may need future retrieval support.
- Discord voice receive is an unofficial API. Connection success alone does not establish that audio is being captured.
- SQLite's built-in Node API is experimental. Run one recorder and one STT worker for this desktop setup.
- GitHub has no issue-creation idempotency key. Vera records its one permitted creation attempt before sending it. An uncertain result is reconciled using a unique marker; absence of a match never triggers an automatic second creation attempt. Investigate uncertain outcomes before taking further action.

Vera is [MIT licensed](LICENSE). Model weights and dependencies retain their own licenses.
