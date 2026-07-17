# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## Project purpose

This project is a security-sensitive bridge between one private Telegram owner and one local Grok Build ACP session. Preserve the single-owner, single-poller, single-active-prompt model unless a change explicitly redesigns and tests that model.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Process entry point and signal handling |
| `src/bridge.ts` | Telegram-to-ACP orchestration and lifecycle |
| `src/telegram.ts` | Telegram handlers, rendering, outbound queue, streaming, and tool bubbles |
| `src/acp-client.ts` | Grok subprocess and ACP session/permission client |
| `src/state.ts` | Pairing, authorization, locks, runtime state, and health snapshots |
| `src/config.ts` | Environment parsing and runtime configuration |
| `src/redact.ts` | Sanitization for logs and permission text |
| `src/utils.ts` | Small shared time and random-value helpers |
| `src/*.test.ts` | Unit, integration, runtime, and security regression tests |
| `scripts/smoke-acp.ts` | Live ACP smoke test without Telegram |

## Non-negotiable invariants

- Accept prompts, commands, callbacks, and permission decisions only from the paired owner in a private chat.
- Keep permission decisions bound to the pending request, active user, and active chat.
- Never pass `TELEGRAM_BOT_TOKEN` or unrelated parent-process secrets to the Grok subprocess.
- Launch subprocesses with `shell: false`; do not construct shell command strings from user input.
- Preserve atomic state writes, state-directory symlink refusal, `0700` directory mode, and `0600` file mode.
- Preserve the one-poller ownership lock and verify ownership before refreshing or removing it.
- Route Telegram API operations through the shared paced queue so ordering and rate-limit handling stay consistent.
- Escape agent output before Telegram HTML rendering and allow only explicitly supported link schemes.
- Sanitize errors before logging or sending them to Telegram.
- Do not silently swallow failures in required delivery or permission paths. Cleanup may be best effort, but failures should be safely logged.
- Keep automatic tool approval disabled by default.

## Development workflow

Install dependencies with:

```bash
npm install
```

Before considering a change complete, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

Use `npm run smoke` only when a local, authenticated Grok CLI is available. It starts a real ACP subprocess.

## Coding conventions

- Use strict TypeScript and the concrete grammY and ACP SDK types. Do not introduce `any` in production code.
- Keep ESM imports consistent with the project, including `.js` suffixes in TypeScript import paths.
- Prefer small typed interfaces and discriminated unions over casts.
- Read configuration through `Config`; do not add duplicate hardcoded timing or limit values.
- Keep modules focused. Avoid barrel files and new abstractions that do not reduce real duplication.
- Add comments only for security-sensitive or non-obvious behavior.
- Preserve explicit error handling. Error messages must not expose tokens, credentials, raw permission payloads, or sensitive paths unnecessarily.

## Testing guidance

- Put pure rendering, redaction, environment, and state behavior in `src/core.test.ts`.
- Put authorization and update-dispatch behavior in `src/telegram-integration.test.ts`.
- Put outbound queue, streaming, typing, and tool-bubble behavior in `src/telegram-runtime.test.ts`.
- Put pairing, filesystem permissions, lock ownership, and other security regressions in `src/security-regressions.test.ts`.
- Use `src/test-support.ts` for complete test configuration instead of scattered partial `Config` casts.
- Every security fix or externally visible behavior change needs a focused regression test.
- Tests must not call the real Telegram API or require live credentials.

## Change checklist

When changing Telegram behavior:

- Verify private-chat and owner checks execute before side effects.
- Preserve the active prompt's `userId` and `chatId` binding.
- Test outbound ordering, Telegram message-size boundaries, and rate-limit behavior when relevant.

When changing ACP behavior:

- Use SDK request and response types.
- Preserve serialized prompts, cancellation, permission forwarding, and subprocess shutdown.
- Confirm child-process environment isolation remains intact.

When changing state or configuration:

- Validate persisted data at runtime.
- Keep safe defaults and owner-only permissions.
- Update `.env.example` and `README.md` for any added, removed, or renamed setting.

When changing documented behavior:

- Confirm the behavior exists in code.
- Keep `README.md`, Telegram help text, and tests consistent.

## Files and secrets

Never commit:

- `.env` or local environment variants
- Telegram bot tokens or API credentials
- `.grok-telegram-state/`
- `access.json`, `lock.json`, or `health.json`
- Logs containing user prompts, agent output, permission payloads, or credentials

Use fake values that cannot be mistaken for real credentials in tests and examples.
