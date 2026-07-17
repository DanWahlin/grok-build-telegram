# Grok Build Telegram Bridge Implementation Plan

> **For Hermes:** Build and verify this plan task-by-task. External coding agents may implement, but Hermes must inspect and test the result.

**Goal:** Build a secure, production-minded Telegram bridge for xAI Grok Build using the official Agent Client Protocol (ACP) over `grok agent --model grok-build stdio`.

**Architecture:** A Node.js/TypeScript service owns one Telegram long-poller and one persistent Grok ACP subprocess. Telegram messages become ACP `session/prompt` requests; ACP stream updates become throttled Telegram draft edits, tool progress, final replies, and permission cards. Local JSON state stores access, lock, session, and health metadata, never secrets in git.

**Tech Stack:** Node.js 24, TypeScript, `@agentclientprotocol/sdk`, grammY, Vitest, Zod.

---

## Milestone 1: Project and configuration

- Create package/build/test/lint scripts and strict TypeScript config.
- Add `.env.example`, `.gitignore`, MIT license, and README skeleton.
- Parse and validate `TELEGRAM_BOT_TOKEN`, `GROK_CWD`, `GROK_BIN`, `GROK_MODEL`, state paths, timing controls, and `GROK_ALWAYS_APPROVE`.
- Default to explicit ACP permission forwarding, not always-approve.

## Milestone 2: Durable access and process ownership

- Implement allowlist plus expiring pairing codes in `access.json` with mode `0600` and atomic writes.
- Implement a single-process ownership lock with PID, hostname, process start token, and heartbeat.
- Refuse duplicate pollers unless the existing lock is provably stale.
- Never log Telegram bot tokens or Grok credentials.

## Milestone 3: Telegram transport

- Implement getMe/start long polling with messages and callback queries.
- Add `/start`, `/help`, `/status`, `/new`, and `/cancel`.
- Add immediate acknowledgment reaction and continuously refreshed typing action.
- Implement safe chunking and plain-text fallback.
- Implement throttled draft streaming through send/edit message APIs.

## Milestone 4: Grok ACP runtime

- Spawn `grok agent --model grok-build stdio`, optionally adding `--always-approve` only when explicitly configured.
- Initialize ACP using the official TypeScript SDK.
- Create one persistent session scoped to the configured absolute cwd.
- Route Telegram prompts serially into ACP.
- Handle `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, and `plan` updates.
- Persist the ACP session ID and expose it in health/status output.
- Reconnect the ACP subprocess on the next prompt after an unexpected exit.

## Milestone 5: Permission forwarding

- Handle ACP `session/request_permission` requests.
- Send Telegram inline buttons derived from ACP permission options.
- Authorize callbacks by Telegram user ID and bind callbacks to opaque local request IDs.
- Remove buttons after approval, rejection, cancellation, or timeout.
- Default unanswered requests to cancelled/rejected after a bounded timeout.
- Redact sensitive values and cap permission summaries.

## Milestone 6: Health and stalled-session behavior

- Atomically write `health.json` with polling freshness, ACP process/session state, active prompt, typing, pending permission, last activity, and likely state.
- Send periodic progress notices during long non-streaming work.
- Stop fake typing and send a stalled warning after inactivity threshold.
- Clean up drafts, pending approvals, locks, timers, polling, and ACP child on shutdown.

## Milestone 7: Tests and proof

- Unit-test config, access/pairing, redaction, chunking, locks, health state, callbacks, and update aggregation.
- Integration-test Telegram behavior with a fake Bot API and fake ACP process/client where practical.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `npm audit --omit=dev`.
- Run a live Grok ACP smoke that creates a session and receives `PONG` from `grok-build` without Telegram.
- Independently review code/security and fix evidence-backed findings.

## Acceptance criteria

- A paired/allowlisted Telegram user can send a prompt and receive a streamed then final Grok Build response.
- Unknown users cannot run Grok and receive only pairing guidance when pairing is enabled.
- Only one poller can own a configured bot/state directory.
- ACP permission requests are never silently approved unless `GROK_ALWAYS_APPROVE=true` was explicitly set.
- Status/health distinguishes idle, working, waiting-for-permission, stalled, and disconnected.
- The repository contains no bot token, Grok credential, private chat ID, or generated state file.
- Build, tests, live ACP smoke, and production dependency audit pass.
