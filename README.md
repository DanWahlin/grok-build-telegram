# Grok Build Telegram Bridge

Secure Telegram bridge for xAI Grok Build using the official [Agent Client Protocol (ACP)](https://agentclientprotocol.com) over `grok agent --model grok-build stdio`.

A single long-polling process owns the bot. Telegram messages become ACP `session/prompt` turns. ACP stream updates become throttled Telegram draft edits, tool bubbles, final replies, and interactive permission cards.

## Features

- **Secure by default**: numeric allowlist + expiring 6-char pairing codes. Atomic 0600 state files.
- **One-poller lock**: PID + hostname + Linux start-time token + heartbeat; refuses duplicate pollers on stale detection.
- **ACP permission forwarding**: inline Telegram buttons (Approve / Reject). Never silently approves unless `GROK_ALWAYS_APPROVE=true`.
- **Streaming UX**: throttled draft edits + typing + progress notices + stalled watchdog.
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

## Architecture Notes

- One persistent ACP session per bridge lifetime.
- Prompts are processed serially; while busy a new message is rejected with guidance.
- Permissions use ACP `requestPermission` handler and map to Telegram callbacks bound to opaque IDs.
- Draft streaming uses edit throttling + force flush on final.
- Watchdog sends ⏳ progress notices after long inactivity and warns on stall.

## Development

```bash
npm run typecheck
npm run build
npm test
npm run smoke   # live ACP-only smoke (no Telegram)
npm audit --omit=dev
```

## Security

- Never commit `.env`, state JSONs, or `access.json`.
- The bridge only trusts explicitly paired numeric user IDs.
- All permission decisions from Telegram are bound to the requesting user ID.
- Use least-privilege `GROK_CWD` when possible.

## License

MIT
