import { z } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  GROK_CWD: z.string().default(process.cwd()),
  GROK_BIN: z.string().default("grok"),
  GROK_MODEL: z.string().default("grok-build"),
  STATE_DIR: z.string().default(resolve(process.cwd(), ".grok-telegram-state")),
  GROK_ALWAYS_APPROVE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Timing controls (ms)
  PAIRING_EXPIRY_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  PERMISSION_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  LOCK_STALE_AFTER_MS: z.coerce.number().int().positive().default((30 + 60 + 45) * 1000),
  PROMPT_STALE_AFTER_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MAX_TYPING_SESSION_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  STREAM_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  STREAM_MIN_DELTA_CHARS: z.coerce.number().int().positive().default(24),
  STREAM_DRAFT_MAX: z.coerce.number().int().positive().default(3800),
  PROGRESS_NOTICE_AFTER_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  PROGRESS_NOTICE_INTERVAL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  PROGRESS_NOTICE_ITERATION_MS: z.coerce.number().int().positive().default(60 * 1000),
  PROGRESS_NOTICE_MAX_ITERATIONS: z.coerce.number().int().positive().default(90),
  SEND_PACE_MS: z.coerce.number().int().nonnegative().default(50),
  TYPING_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  TYPING_DEBOUNCE_MS: z.coerce.number().int().positive().default(60000),
  HEALTH_WRITE_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  API_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  PERMISSION_SUMMARY_MAX: z.coerce.number().int().positive().default(1800),
});

export type Config = z.infer<typeof EnvSchema> & {
  stateDir: string;
  grokCwdAbs: string;
  grokBin: string;
};

export function loadConfig(): Config {
  const parsed = EnvSchema.parse(process.env);

  const stateDir = resolve(parsed.STATE_DIR);
  const grokCwdAbs = resolve(parsed.GROK_CWD);
  let grokBin = parsed.GROK_BIN;
  if (!grokBin || grokBin === "grok") {
    // Prefer the known grok location if present
    const home = process.env["HOME"];
    const candidates = [
      "/root/.grok/bin/grok",
      home ? `${home}/.grok/bin/grok` : null,
      "grok",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (c === "grok" || existsSync(c)) {
        grokBin = c;
        break;
      }
    }
  }

  return {
    ...parsed,
    stateDir,
    grokCwdAbs,
    grokBin,
  };
}

export const CHUNK_MAX = 4096;
