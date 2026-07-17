import type { Config } from "./config.js";

export function createTestConfig(
  stateDir: string,
  overrides: Partial<Config> = {},
): Config {
  return {
    TELEGRAM_BOT_TOKEN: "123456789:test-token-not-real",
    GROK_CWD: stateDir,
    GROK_BIN: "grok",
    GROK_MODEL: "grok-build",
    STATE_DIR: stateDir,
    GROK_ALWAYS_APPROVE: false,
    PAIRING_EXPIRY_MS: 300_000,
    PERMISSION_TIMEOUT_MS: 300_000,
    LOCK_STALE_AFTER_MS: 135_000,
    PROMPT_STALE_AFTER_MS: 900_000,
    MAX_TYPING_SESSION_MS: 1_800_000,
    STREAM_EDIT_INTERVAL_MS: 1_500,
    STREAM_MIN_DELTA_CHARS: 24,
    STREAM_DRAFT_MAX: 3_800,
    PROGRESS_NOTICE_AFTER_MS: 600_000,
    PROGRESS_NOTICE_INTERVAL_MS: 600_000,
    PROGRESS_NOTICE_ITERATION_MS: 60_000,
    PROGRESS_NOTICE_MAX_ITERATIONS: 90,
    SEND_PACE_MS: 50,
    TYPING_INTERVAL_MS: 4_000,
    TYPING_DEBOUNCE_MS: 60_000,
    HEALTH_WRITE_MIN_INTERVAL_MS: 5_000,
    API_TIMEOUT_MS: 30_000,
    PERMISSION_SUMMARY_MAX: 1_800,
    stateDir,
    grokCwdAbs: stateDir,
    grokBin: "grok",
    ...overrides,
  };
}
