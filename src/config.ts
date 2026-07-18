import { z } from "zod";
import { resolve } from "node:path";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import dotenv from "dotenv";
import { parseCwdAllowlist, parseMimeAllowlist } from "./media.js";
import {
  assertRuntimePathsOutsideBuildOutput,
  getBuildOutputDir,
} from "./path-safety.js";

dotenv.config();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  GROK_CWD: z.string().default(process.cwd()),
  GROK_BIN: z.string().default("grok"),
  GROK_MODEL: z.string().default("grok-4.5"),
  STATE_DIR: z.string().default(resolve(process.cwd(), ".grok-telegram-state")),
  GROK_ALWAYS_APPROVE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  // Timing controls (ms)
  PAIRING_EXPIRY_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  PAIRING_PENDING_MAX: z.coerce.number().int().positive().max(1000).default(100),
  PERMISSION_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  LOCK_STALE_AFTER_MS: z.coerce.number().int().positive().default((30 + 60 + 45) * 1000),
  PROMPT_STALE_AFTER_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MAX_TYPING_SESSION_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  STREAM_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  STREAM_MIN_DELTA_CHARS: z.coerce.number().int().positive().default(24),
  STREAM_DRAFT_MAX: z.coerce.number().int().positive().default(3800),
  // Mobile-friendly default: first progress notice at 90s
  PROGRESS_NOTICE_AFTER_MS: z.coerce.number().int().positive().default(90 * 1000),
  PROGRESS_NOTICE_INTERVAL_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
  PROGRESS_NOTICE_ITERATION_MS: z.coerce.number().int().positive().default(60 * 1000),
  PROGRESS_NOTICE_MAX_ITERATIONS: z.coerce.number().int().positive().default(90),
  SEND_PACE_MS: z.coerce.number().int().nonnegative().default(50),
  TELEGRAM_OUTBOUND_QUEUE_MAX: z.coerce.number().int().positive().max(1000).default(100),
  TELEGRAM_RETRY_MAX: z.coerce.number().int().nonnegative().max(5).default(5),
  ASSISTANT_TEXT_MAX_CHARS: z.coerce.number().int().positive().max(1_000_000).default(200_000),
  TYPING_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  TYPING_DEBOUNCE_MS: z.coerce.number().int().positive().default(60000),
  HEALTH_WRITE_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  API_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(30_000),
  PERMISSION_SUMMARY_MAX: z.coerce.number().int().positive().default(1800),
  // Media / queue / reliability
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(20 * 1024 * 1024),
  MEDIA_MIME_ALLOWLIST: z.string().default(""),
  PROMPT_QUEUE_MAX: z.coerce.number().int().nonnegative().max(100).default(3),
  CANCEL_WAIT_MS: z.coerce.number().int().positive().max(30_000).default(15_000),
  RETRY_LAST_TTL_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  BUBBLE_DEBOUNCE_MS: z.coerce.number().int().positive().default(300),
  THOUGHT_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(2500),
  GROK_CWD_ALLOWLIST: z.string().default(""),
  VERBOSE_DEFAULT: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
});

export type Config = z.infer<typeof EnvSchema> & {
  stateDir: string;
  grokCwdAbs: string;
  grokBin: string;
  mimeAllowlist: string[];
  cwdAllowlist: string[];
};

export function parseEnvironment(input: NodeJS.ProcessEnv) {
  return EnvSchema.parse(input);
}

export function resolveGrokBinary(
  configured: string,
  home: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (configured && configured !== "grok") return configured;
  const candidates = [home ? `${home}/.grok/bin/grok` : null, "grok"]
    .filter(Boolean) as string[];
  return candidates.find((candidate) => candidate === "grok" || fileExists(candidate)) ?? "grok";
}

export function loadConfig(): Config {
  const parsed = parseEnvironment(process.env);

  const stateDir = resolve(parsed.STATE_DIR);
  const grokCwdCandidate = resolve(parsed.GROK_CWD);
  if (!existsSync(grokCwdCandidate) || !statSync(grokCwdCandidate).isDirectory()) {
    throw new Error(`GROK_CWD must be an existing directory: ${grokCwdCandidate}`);
  }
  const grokCwdAbs = realpathSync(grokCwdCandidate);
  assertRuntimePathsOutsideBuildOutput(
    stateDir,
    grokCwdAbs,
    getBuildOutputDir(import.meta.url),
  );
  const grokBin = resolveGrokBinary(parsed.GROK_BIN, process.env["HOME"]);

  const cwdAllowlist = [...new Set(
    parseCwdAllowlist(parsed.GROK_CWD_ALLOWLIST, grokCwdAbs).map((entry) => {
      const candidate = resolve(entry);
      if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isDirectory()) {
        throw new Error(`GROK_CWD_ALLOWLIST entries must be existing non-symlink directories: ${candidate}`);
      }
      return realpathSync(candidate);
    }),
  )];

  return {
    ...parsed,
    stateDir,
    grokCwdAbs,
    grokBin,
    mimeAllowlist: parseMimeAllowlist(parsed.MEDIA_MIME_ALLOWLIST),
    cwdAllowlist,
  };
}

export const CHUNK_MAX = 4096;
