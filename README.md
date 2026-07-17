# Grok Build Telegram Bridge

<p align="center">
  <img src="images/logo.webp" alt="Grok Build Telegram logo" width="400">
</p>

Secure Telegram bridge for xAI Grok Build using the official [Agent Client Protocol (ACP)](https://agentclientprotocol.com) over `grok agent --model grok-build stdio`.

A single long-polling process owns the bot. Telegram messages become ACP `session/prompt` turns. ACP stream updates become throttled Telegram draft edits, tool bubbles, final replies, and interactive permission cards.

## Features

- **Secure by default**: private chats only, one numeric Telegram owner, expiring attempt-limited pairing codes, and atomic `0600` state files.
- **One-poller lock**: PID + hostname + Linux start-time token + heartbeat; refuses duplicate pollers on stale detection.
- **ACP permission forwarding**: inline Telegram buttons (Approve / Reject). Never silently approves unless `GROK_ALWAYS_APPROVE=true`.
- **Streaming UX**: throttled draft edits, ordered multi-message finals, typing, live tool-progress bubbles, progress notices, and a stalled watchdog.
- **Commands**: `/start`, `/help`, `/status`, `/new`, `/cancel`.
- **Redaction**: tokens, keys, and secrets are stripped from permission summaries and health.
- **Health snapshots**: `health.json` with precise state for debugging.
- **Clean shutdown**: cancels in-flight work, removes locks, cleans drafts/permissions.

## Requirements

- Node.js 24+
- Grok CLI with `grok-build` model access (`/root/.grok/bin/grok` or in PATH)
- A Telegram bot token from @BotFather

## Quick Start

1. Clone and install:

   ```bash
   cd grok-build-telegram
   npm install
   cp .env.example .env
   ```

2. Edit `.env` and set `TELEGRAM_BOT_TOKEN` and `GROK_CWD` (absolute path recommended).

3. Pair yourself:

   ```bash
   npm run start:dev
   ```

   Send any message to the bot. The bot asks for a pairing code, while the one-time code is printed only in the bridge terminal. Copy that code into Telegram within five minutes. Pairing attempts are rate-limited and the runtime access file is stored with mode `0600`.

4. Talk to Grok Build from Telegram.

## Commands (in Telegram)

- `/start`, `/help` — usage
- `/status` — health, session, last activity, pending permission
- `/new` — stop the current Grok ACP subprocess and create a fresh session
- `/cancel` — send ACP `session/cancel` for the current prompt turn

## Configuration

See `.env.example`. Key variables:

- `GROK_ALWAYS_APPROVE` — **insecure**. Only set true for trusted fully-automated setups.
- `STATE_DIR` — where `access.json`, `lock.json`, `health.json` live (mode 0700 dir, 0600 files).
- `SEND_PACE_MS`, `API_TIMEOUT_MS` — outbound Telegram queue pacing and API timeout.
- `TYPING_INTERVAL_MS`, `TYPING_DEBOUNCE_MS`, `MAX_TYPING_SESSION_MS` — typing cadence and limits.
- `STREAM_EDIT_INTERVAL_MS`, `STREAM_MIN_DELTA_CHARS`, `STREAM_DRAFT_MAX` — streaming draft throttling.
- `PROGRESS_NOTICE_*` — progress notice timing and maximum notice count.

## Architecture Notes

- One persistent ACP session per bridge lifetime.
- Prompts are processed serially; while busy a new message is rejected with guidance.
- Permissions use ACP `requestPermission` handler and map to Telegram callbacks bound to opaque IDs.
- Draft streaming uses edit throttling + force flush on final.
- Tool calls create one progress bubble in the active authorized prompt chat, edit it as tools change, and delete it when the prompt ends.
- Watchdog sends ⏳ progress notices after long inactivity and warns on stall.

## Development

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run smoke   # live ACP-only smoke (no Telegram)
npm audit --omit=dev
```

## Security

- Never commit `.env`, state JSONs, or `access.json`.
- The bridge only trusts its first explicitly paired numeric user ID and only in a private chat.
- The Grok ACP subprocess receives a strict environment allowlist, never the Telegram bot token. It also forces Claude-compatible MCP and hook discovery off, preventing an imported Claude Telegram plugin from launching a competing Bot API poller.
- All permission decisions and control commands are bound to the active owner/chat.
- Use least-privilege `GROK_CWD` when possible.

## License

MIT
