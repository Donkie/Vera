# Vera

Vera is a self-hosted Discord assistant that turns voice discussions into GitHub issue drafts. Use it during project meetings to capture bugs, improvements and ideas, then review and publish them in Discord.

It records each speaker separately, transcribes speech locally with a configurable Whisper model and spoken language, and uses Claude or Ollama to write summaries and drafts in your chosen language. Drafts include original transcript quotes as evidence. An authorized person must approve each issue before it is published. GitHub is optional: recording and draft review work without it.

## Run Vera

Download or clone this repository, then create your settings file from its directory:

```bash
cp .env.example .env
chmod 600 .env
```

Fill in `.env` using [Configuration](#configuration), then choose one way to run Vera.

The first start downloads and loads the speech model, which can take several minutes. Vera checks transcription and the configured services before connecting to Discord. Wait for the `Ready` message; recording starts only when you ask.

### Directly

Install Node.js 24+ and Python 3.11 with venv support, then run:

```bash
npm ci
python3.11 -m venv .venv
.venv/bin/python -m pip install -r src/python/requirements.txt
npm start
```

These commands use Linux/macOS paths. Stop Vera with Ctrl+C.

### With Docker

Install Docker with Compose support. You do not need Node.js or Python on the host.

```bash
docker compose up --build -d
docker compose logs -f vera
```

Stop Vera with `docker compose down`. Recordings, review state and downloaded models persist in Docker volumes; adding `--volumes` deletes them. Existing host `data/` and `models/` folders are not imported.

## Configuration

Keep tokens and API keys in `.env`, out of source control. See [.env.example](.env.example) for all settings.

### Discord

1. Create a dedicated bot application in the [Discord Developer Portal](https://discord.com/developers/applications). Startup replaces that application's commands in your server.
2. Install it in your server with the `bot` and `applications.commands` scopes. Grant **View Channels**, **Connect**, **Send Messages**, **Embed Links** and **Read Message History**, including any channel overrides. No privileged intents are needed.
3. Enable Developer Mode in Discord to copy IDs, then fill in:

| Setting | Value |
| --- | --- |
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_GUILD_ID` | Your server ID |
| `DISCORD_VOICE_CHANNEL_ID` | The voice channel to record |
| `DISCORD_TEXT_CHANNEL_ID` | The text channel for commands and draft review |

### Text analysis

Choose one provider:

- **Claude** (the example configuration): set `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY`. `ANTHROPIC_MODEL` selects the model. Claude is paid and receives transcript text, speaker details, summaries and issue context; audio stays local. Each startup also makes a small paid check request. Vera has no spending cap.
- **Ollama**: install [Ollama](https://ollama.com/), run `ollama pull qwen3.5:4b`, and set `LLM_PROVIDER=ollama`. `OLLAMA_MODEL` and `OLLAMA_URL` select the model and server. Text stays on your Ollama server; Vera requests CPU inference, which can take minutes. With Docker, use a server address reachable from the container: `localhost` points to Vera itself.

### GitHub (optional)

Set `GITHUB_REPO=owner/repository` and `GITHUB_TOKEN` to a repository-scoped token with **Issues: read and write** access. The repository must be active with Issues enabled. Vera checks access at startup and stops if it fails.

Leave **both** settings blank to disable publishing and duplicate lookup. Those sessions' drafts stay local; start a new recording after enabling GitHub to create publishable drafts.

### Other settings

| Setting | Purpose |
| --- | --- |
| `ISSUE_LANGUAGE` | Language for summaries and issue text; defaults to English. Independent of the spoken language; original quotes stay unchanged. |
| `RECORDINGS_DIR` | Storage folder; defaults to `./data`. Docker Compose uses `/app/data` in its persistent volume. |
| `STT_MODEL` | Speech model: a faster-whisper model name, CTranslate2 Hugging Face ID or local model directory. Defaults to `KBLab/kb-whisper-small` on CPU. |
| `STT_LANGUAGE` | Spoken-language code supported by the model, such as `sv`, `en` or `de`; defaults to `sv` (Swedish). |
| `STT_RUN` | Transcript run name; defaults to `live`. Choose a new name when changing speech model settings to preserve existing transcripts. |

For Swedish speech, we recommend [KBLab's KB-Whisper](https://huggingface.co/KBLab/kb-whisper-small), which is the default. For other languages, select a compatible [faster-whisper model](https://github.com/SYSTRAN/faster-whisper#model-conversion) and set `STT_LANGUAGE`; for example, `STT_MODEL=small` and `STT_LANGUAGE=en` for English. Choose a new `STT_RUN` when changing either setting.

Restart after editing `.env`. With Docker, run `docker compose up -d --force-recreate`. Issue language and publishing destination are saved per session; changes apply to new sessions.

## Use Vera

Run commands in the configured review text channel.

1. **Grant access.** A person with **Manage Server** permission runs `/vera access user:@person role:publisher`. Use `role:reviewer` for recording and review without publishing, or `role:none` to revoke access. Grants survive restarts; `/vera access` shows your access.
2. **Record.** Tell everyone they will be recorded, then run `/vera start`. Vera joins the configured voice channel. Use `/vera status` while someone speaks to confirm the packet count increases.
3. **Finish.** Run `/vera stop`. Keep Vera running while the remaining audio is transcribed and analyzed. Drafts appear after analysis and about a minute without new relevant discussion; CPU processing can add delay.
4. **Review and publish.** Read each draft and its evidence. Use **Edit**, **Comment**, **Reject** or **Details & history**. Comments stay in review history; Edit changes the issue. A publisher clicks **Post issue** to approve the current revision. Long drafts require opening the full preview first; edits or new relevant discussion invalidate earlier approvals.

Other useful commands:

| Command | Purpose |
| --- | --- |
| `/vera drafts` | List drafts |
| `/vera draft id:...` | Open a draft and its buttons |
| `/vera merge keep:... remove:...` | Combine drafts for fresh review |
| `/vera summary session:...` | Read a session summary |
| `/vera reconcile id:...` | Check an uncertain GitHub publication without retrying creation |

If publication is uncertain, check GitHub and use reconcile before taking further action. Vera never automatically repeats issue creation.

Recordings and transcripts remain in the storage folder until you delete them. Transcripts are under `SESSION_ID/recognitions/STT_RUN/` as `transcript.md` and `transcript.json`; review history and access grants are in `workflow.sqlite`. Allow roughly 0.7 GB per recorded speaker-hour, agree on retention with participants, and back up the storage together. Review transcripts and drafts for recognition or AI mistakes before publishing.

For development, tests and replaying saved audio, see [CONTRIBUTING.md](CONTRIBUTING.md). Agent navigation is in [AGENTS.md](AGENTS.md).

Vera is [MIT licensed](LICENSE). Models and dependencies have their own licenses.
