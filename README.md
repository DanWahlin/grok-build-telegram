# Grok Build Telegram Bridge

<p align="center">
  <img src="images/logo.webp" alt="Grok Build Telegram logo" width="400">
</p>

Run an xAI Grok Build coding-agent session from a private Telegram chat. The bridge uses the official [Agent Client Protocol (ACP)](https://agentclientprotocol.com) over `grok agent --model grok-4.5 stdio`; it does not expose an inbound HTTP server or Telegram webhook.

## Features

- **Secure by default**: private chats only, one numeric Telegram owner, expiring attempt-limited pairing codes, and atomic owner-only state files.
- **Multimodal prompts**: text, photos, documents, voice, and video are downloaded into a descriptor-bound, owner-only inbox under the authorized session CWD. Inbox paths are opened without following symlinks, and admitted file identity, size, and content digest are revalidated before use. Files are sent as ACP content blocks when supported, otherwise as a `resource_link` backed by a process-owned file descriptor that remains open only for the prompt lifetime.
- **Prompt queue**: text follow-ups while ACP is busy are queued in memory (default depth 3) instead of hard-rejected. The queue is intentionally volatile across restarts; media follow-ups must wait for the active prompt.
- **Interactive permissions**: choose **Allow once**, **Allow for session**, or the reject options offered by ACP. Resolved cards are replaced with their final status, and expired cards lose their buttons. Permissions are never approved automatically unless `GROK_ALWAYS_APPROVE=true` (which prefers the session-scoped option).
- **Streaming responses**: throttled draft edits, ordered multi-message final responses, typing indicators, tool-progress bubbles, progress notices, plan cards, optional thought stream (`/verbose`), and stall recovery buttons.
- **Single-poller protection**: a PID, hostname, process-start token, and heartbeat lock prevent competing bridge instances.
- **Operational visibility**: `/status` and `health.json` report session, prompt, permission, queue, cwd, usage, and tool activity.
- **Child environment minimization**: the Telegram token is omitted from the Grok subprocess environment, and sensitive values are redacted from permission summaries and logs. This is not an OS sandbox; see [Security model and limitations](#security-model-and-limitations).

## Requirements

- Linux with a mounted `/proc` filesystem. The bridge verifies the spawned ACP process through `/proc/<pid>/cwd` and fails closed when that identity proof is unavailable.
- Node.js 24 or later
- A locally installed and authenticated Grok CLI with access to the `grok-4.5` model
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Quick start

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/DanWahlin/grok-build-telegram.git
   cd grok-build-telegram
   npm ci
   cp .env.example .env
   ```

2. Edit `.env`:

   ```dotenv
   TELEGRAM_BOT_TOKEN=your-bot-token
   GROK_CWD=/absolute/path/to/the/project
   ```

   `GROK_CWD` is the directory the Grok agent can inspect and modify. Use the narrowest practical project directory. Do not point it at the bridge installation or any directory containing `.env`, credentials, private keys, or unrelated repositories.

3. Start the bridge in development mode:

   ```bash
   npm run start:dev
   ```

4. Open a private chat with the bot and send a message. The one-time pairing code appears only in the bridge terminal. Send that code to the bot within five minutes.

5. Send a text prompt, photo, or document. The bridge keeps one persistent ACP session and processes one prompt at a time (with optional Telegram-side queue).

### Production start

Build the TypeScript output and run the compiled entry point:

```bash
npm run build
npm start
```

Run only one bridge process for a bot token. Use a process supervisor if the bridge must restart automatically.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Show usage and pairing guidance |
| `/status` | Bridge, ACP, queue, cwd, usage, and activity status |
| `/new` | Stop the current Grok subprocess, clear queued prompts, and create a fresh ACP session |
| `/cancel` | Cancel the active ACP prompt (waits for idle) |
| `/cancel queue` | Cancel active prompt if any, and clear the follow-up queue |
| `/retry last` | Re-send the last final text response (no agent re-run) |
| `/verbose on\|off` | Toggle ACP thought-stream visibility |
| `/cwd` | List allowlisted working directories |
| `/cwd <n\|path>` | Switch CWD (allowlist only) and restart the ACP session |

Any other message text is forwarded as a prompt (including Grok slash-style text such as planning requests).

## Configuration

Copy `.env.example` to `.env`. Primary settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required | Token issued by @BotFather |
| `GROK_CWD` | Current directory | Working directory available to Grok |
| `GROK_CWD_ALLOWLIST` | (primary only) | Comma-separated paths allowed for `/cwd` |
| `GROK_BIN` | `grok` | Grok executable path; common user locations are also detected |
| `GROK_MODEL` | `grok-4.5` | Model passed to `grok agent` |
| `STATE_DIR` | `./.grok-telegram-state` | Directory for access, lock, and health state |
| `GROK_ALWAYS_APPROVE` | `false` | Auto-approve ACP permissions (prefers the session-scoped option) |
| `PAIRING_PENDING_MAX` | `100` | Maximum simultaneous unpaired chat challenges |
| `MEDIA_MAX_BYTES` | `20971520` | Max attachment size (20 MiB) |
| `MEDIA_MIME_ALLOWLIST` | images/audio/video/pdf/text… | Comma-separated MIME allowlist |
| `PROMPT_QUEUE_MAX` | `3` | Follow-up queue depth while busy (`0` = reject) |
| `TELEGRAM_OUTBOUND_QUEUE_MAX` | `100` | Maximum queued Telegram API operations |
| `TELEGRAM_RETRY_MAX` | `5` | Rate-limit retries per Telegram operation (`0`–`5`) |
| `API_TIMEOUT_MS` | `30000` | Per-operation API and ACP setup timeout (maximum `30000`) |
| `ASSISTANT_TEXT_MAX_CHARS` | `200000` | Maximum assistant text retained for one response |
| `CANCEL_WAIT_MS` | `15000` | Wait for ACP idle after cancel (maximum `30000`) |
| `RETRY_LAST_TTL_MS` | `1800000` | How long `/retry last` keeps the last response |
| `PROGRESS_NOTICE_AFTER_MS` | `90000` | First “still working” notice (mobile-friendly default) |
| `VERBOSE_DEFAULT` | `false` | Start with thought stream enabled |

`.env.example` documents all optional runtime limits and timing controls for pairing, permissions, streaming, typing, progress notices, health writes, API calls, and outbound pacing.

## How it works

```mermaid
flowchart LR
    telegram["Private Telegram message<br/>text / photo / file"] --> gate{"Authorized owner?"}
    gate -- No --> rejected["Reject or pair"]
    gate -- Yes --> busy{"Active ACP prompt?"}
    busy -- Yes --> queue["Telegram-side queue"]
    busy -- No --> acp["Persistent Grok ACP session<br/>ContentBlock prompt"]
    queue --> acp
    acp -- Text chunks --> response["Draft edits and final messages"]
    acp -- Tool updates --> bubble["Tool-progress bubble"]
    acp -- Plan / thoughts --> cards["Plan card · optional thoughts"]
    acp -- Permission request --> permission["Owner-bound once/session/reject"]
    permission -- Decision --> acp
```

- `grammY` long-polls Telegram. No webhook endpoint is opened.
- Prompts are serialized to ACP. Follow-ups enqueue on the Telegram side.
- Attachments land in `<CWD>/.tg-inbox/` (directory mode `0700`, active file mode `0600`) and are securely retired after the prompt finishes, as described below.
- Assistant output is HTML-escaped, rendered from a limited Markdown subset, and split at Telegram's message limit.
- Tool and permission controls are sent only to the authorized chat that owns the active prompt.
- Outbound Telegram operations share one paced queue with retry handling for rate limits.

## Runtime state

The bridge creates these files under `STATE_DIR`:

| File | Contents |
| --- | --- |
| `access.json` | Authorized user ID and temporary pairing state |
| `lock.json` | Single-poller ownership and heartbeat |
| `health.json` | Current bridge, Telegram, ACP, prompt, and permission status |

The state directory is forced to mode `0700` and state files to `0600`. Do not commit or share them.

Inbox files for media live under `<session CWD>/.tg-inbox/` (not `STATE_DIR`). The inbox is forced to mode `0700`. After a prompt settles, the bridge erases each admitted opened file, removes its permissions, and closes its retained descriptor without unlinking a reusable pathname. Empty retired entries can remain, and an abrupt process death can leave an admitted file intact; inspect and remove leftovers only while the bridge is stopped.

## Security model and limitations

- The first successfully paired Telegram user becomes the only owner. Pairing closes after that.
- Commands, prompts, callbacks, and permission decisions are accepted only from the owner in a private chat.
- Pairing codes expire and allow at most five attempts.
- The Grok subprocess receives an explicit environment allowlist and does not inherit `TELEGRAM_BOT_TOKEN`.
- Environment filtering is not a sandbox. A Grok process running as the same operating-system user may read any file that user can access, including bridge configuration if filesystem permissions allow it. Keep the bridge installation and secrets outside `GROK_CWD`; use a separate execution identity or sandbox when the agent must not share that trust boundary.
- ACP permission decisions are bound to the active request, owner, and chat.
- `GROK_ALWAYS_APPROVE=true` removes the interactive safety boundary. Leave it disabled unless the agent and working directory are fully trusted.
- Media ingress enforces MIME allowlists and size caps. Automatic outbound local-file delivery is disabled until ACP exposes a narrow artifact contract.
- One bridge supports one owner, one Grok subprocess, and one active ACP prompt at a time.
- Use a least-privilege operating-system account and a narrowly scoped `GROK_CWD`.
- `/cwd` can only switch among `GROK_CWD` and `GROK_CWD_ALLOWLIST` paths that exist on disk.

## Troubleshooting

**The bot reports another poller or exits with a conflict**

Another process is using the same bot token. Stop the other process before restarting this bridge. Do not delete `lock.json` while a bridge process is still running.

**No pairing code appears in Telegram**

The code is intentionally printed only in the bridge terminal. Send any message to the bot in a private chat, then check the terminal output.

**Grok does not connect**

Confirm that `GROK_BIN` points to a working CLI, the CLI is already authenticated, `GROK_CWD` exists, and this command works locally:

```bash
grok agent --model grok-4.5 stdio
```

When `GROK_ALWAYS_APPROVE=true`, the bridge starts the production child with the exact command:

```bash
grok agent --model grok-4.5 --always-approve stdio
```

**A prompt appears stalled**

Use `/status` and inspect `STATE_DIR/health.json`. The watchdog reports inactivity after `PROMPT_STALE_AFTER_MS` and offers **Cancel** / **Keep waiting** buttons.

**Attachment rejected**

Check `MEDIA_MAX_BYTES` and `MEDIA_MIME_ALLOWLIST`. Oversized or disallowed MIME types are refused before ACP sees them.

**Final message missing after a long run**

If delivery failed, try `/retry last` within `RETRY_LAST_TTL_MS` to re-send the last stored response without re-running the agent.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

`npm run clean` removes only generated `dist` output. It refuses to run when `STATE_DIR` or `GROK_CWD` resolves inside `dist`, including through a symlink, so cleanup cannot erase runtime identity or an active media workspace.

Run the live ACP-only smoke test when a working Grok CLI is available:

```bash
npm run smoke
```

See [`AGENTS.md`](AGENTS.md) for repository structure, security invariants, testing guidance, and contributor expectations.

## Reporting security issues

Use the repository's private **Report a vulnerability** flow as described in [`SECURITY.md`](SECURITY.md). Do not disclose suspected vulnerabilities, tokens, private prompts, or runtime state in a public issue.

## License

[MIT](LICENSE)
