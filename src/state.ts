import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  lstatSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { hostname, platform } from "node:os";
import { z, type ZodType } from "zod";
import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import { nowIso, parseTimeMs, ageMs, messageSafeRandom } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";

export interface AccessState {
  allowedUsers: string[];
  pending: Record<string, { code: string; timestamp: number; attempts?: number | undefined }>;
}

export interface LockData {
  pid: number;
  sessionId: string;
  botName?: string | undefined;
  hostname: string;
  processStartToken: string | null;
  processStartTokenSource: string;
  connectedAt: string;
  updatedAt: string;
}

export interface HealthSnapshot {
  reason: string;
  updatedAt: string;
  connected: boolean;
  pid: number;
  sessionId: string | null;
  botName: string | null;
  botUsername: string | null;
  hostname: string;
  lastPollAt: string | null;
  lastUpdateAt: string | null;
  lastInboundPromptAt: string | null;
  lastAcpEventAt: string | null;
  lastToolEventAt: string | null;
  typingActive: boolean;
  typingAgeMs: number | null;
  activePrompt: {
    id: string;
    chatId: number;
    messageId: number;
    startedAt: string;
    lastActivityAt: string | null;
    warningSent: boolean;
    progressNoticeCount: number;
    lastProgressNoticeAt: string | null;
    ageMs: number | null;
    activityAgeMs: number | null;
    stale: boolean;
  } | null;
  pendingPermission: {
    id: string;
    kind: string;
    summary: string;
    startedAt: string;
    ageMs: number | null;
    messageCount: number;
  } | null;
  acpSessionId: string | null;
  likelyState: string;
}

const DEFAULT_ACCESS: AccessState = { allowedUsers: [], pending: {} };
const PendingPairingSchema = z.object({
  code: z.string().min(1),
  timestamp: z.number().finite(),
  attempts: z.number().int().nonnegative().optional(),
});
const AccessStateSchema: ZodType<AccessState> = z.object({
  allowedUsers: z.array(z.string()),
  pending: z.record(z.string(), PendingPairingSchema),
});
const LockDataSchema: ZodType<LockData> = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  botName: z.string().optional(),
  hostname: z.string(),
  processStartToken: z.string().nullable(),
  processStartTokenSource: z.string(),
  connectedAt: z.string(),
  updatedAt: z.string(),
});

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function loadJsonOrDefault<T>(
  filePath: string,
  defaultValue: T,
  schema: ZodType<T>,
): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    const validated = schema.safeParse(parsed);
    if (validated.success) return validated.data;
    console.warn(`grok-telegram: invalid state shape in ${filePath}, using defaults`);
    return structuredClone(defaultValue);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return structuredClone(defaultValue);
    if (err instanceof SyntaxError) {
      console.warn(`grok-telegram: corrupted JSON in ${filePath}, using defaults`);
      return structuredClone(defaultValue);
    }
    throw err;
  }
}

export function saveJsonAtomic(filePath: string, data: unknown, mode = 0o600): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing symlink state directory: ${dir}`);
  chmodSync(dir, 0o700);
  const tmp = `${filePath}.${process.pid}.${messageSafeRandom()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, filePath);
    chmodSync(filePath, mode);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch (error: unknown) {
      console.warn(`grok-telegram: failed to remove temporary state file: ${sanitizedError(error)}`);
    }
  }
}

export function ensureStateDir(config: Config): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(config.stateDir).isSymbolicLink()) throw new Error("STATE_DIR may not be a symlink");
  chmodSync(config.stateDir, 0o700);
}

export function accessPath(config: Config): string {
  return join(config.stateDir, "access.json");
}
export function lockPath(config: Config): string {
  return join(config.stateDir, "lock.json");
}
export function healthPath(config: Config): string {
  return join(config.stateDir, "health.json");
}

export function reloadAccess(config: Config): AccessState {
  return loadJsonOrDefault(accessPath(config), DEFAULT_ACCESS, AccessStateSchema);
}

export function saveAccess(config: Config, access: AccessState): void {
  saveJsonAtomic(accessPath(config), access, 0o600);
}

export function isAllowed(access: AccessState, userId: number | string): boolean {
  return access.allowedUsers.includes(String(userId));
}

export function cleanExpiredPending(config: Config, access: AccessState): boolean {
  const now = Date.now();
  let changed = false;
  for (const [chatId, entry] of Object.entries(access.pending || {})) {
    if (now - entry.timestamp > config.PAIRING_EXPIRY_MS) {
      delete access.pending[chatId];
      changed = true;
    }
  }
  if (changed) saveAccess(config, access);
  return changed;
}

export function startPairing(config: Config, access: AccessState, chatId: number | string): string {
  const chatIdStr = String(chatId);
  const code = messageSafeRandom().slice(0, 6).toUpperCase();
  if (!access.pending) access.pending = {};
  access.pending[chatIdStr] = { code, timestamp: Date.now(), attempts: 0 };
  saveAccess(config, access);
  return code;
}

export function completePairing(
  config: Config,
  access: AccessState,
  chatId: number | string,
  userId: number | string,
  code: string
): boolean {
  const chatIdStr = String(chatId);
  const userIdStr = String(userId);
  const pending = access.pending?.[chatIdStr];
  if (!pending) return false;
  if (Date.now() - pending.timestamp > config.PAIRING_EXPIRY_MS) {
    delete access.pending[chatIdStr];
    saveAccess(config, access);
    return false;
  }
  if (pending.code.toUpperCase() !== code.toUpperCase()) {
    pending.attempts = (pending.attempts ?? 0) + 1;
    if (pending.attempts >= 5) delete access.pending[chatIdStr];
    saveAccess(config, access);
    return false;
  }
  if (!access.allowedUsers.includes(userIdStr)) {
    access.allowedUsers.push(userIdStr);
  }
  delete access.pending[chatIdStr];
  saveAccess(config, access);
  return true;
}

// --- Lock management ---

function getProcessStartToken(pid: number): string | null {
  if (platform() !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return null;
    const fields = stat.slice(lastParen + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ? `linux:${startTime}` : null;
  } catch {
    return null;
  }
}

export function createLockData(
  sessionId: string,
  connectedAt = nowIso()
): LockData {
  return {
    pid: process.pid,
    sessionId,
    hostname: hostname(),
    processStartToken: getProcessStartToken(process.pid),
    processStartTokenSource: platform(),
    connectedAt,
    updatedAt: nowIso(),
  };
}

export function acquireLock(config: Config, sessionId: string): void {
  const path = lockPath(config);
  const data = createLockData(sessionId);
  try {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return;
  } catch (error: unknown) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  const existing = readLock(config);
  if (existing && !isLockStale(config, existing)) {
    throw new Error(`Bot is already locked by pid ${existing.pid} on ${existing.hostname}`);
  }
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

export function readLock(config: Config): LockData | null {
  return loadJsonOrDefault<LockData | null>(
    lockPath(config),
    null,
    LockDataSchema.nullable(),
  );
}

export function lockOwnedByCurrentProcess(lock: LockData | null, sessionId: string): boolean {
  if (!lock || lock.pid !== process.pid || lock.sessionId !== sessionId) return false;
  if (lock.hostname && lock.hostname !== hostname()) return false;
  if (lock.processStartToken) {
    const current = getProcessStartToken(lock.pid);
    if (current && current !== lock.processStartToken) return false;
  }
  return true;
}

export function refreshLock(config: Config, sessionId: string): boolean {
  const lock = readLock(config);
  if (!lock || !lockOwnedByCurrentProcess(lock, sessionId)) return false;
  const connectedAt = lock.connectedAt || nowIso();
  saveJsonAtomic(lockPath(config), createLockData(sessionId, connectedAt), 0o600);
  return true;
}

export function removeLock(config: Config, sessionId: string): void {
  const lock = readLock(config);
  if (lockOwnedByCurrentProcess(lock, sessionId)) {
    try {
      rmSync(lockPath(config), { force: true });
    } catch (error: unknown) {
      console.warn(`grok-telegram: failed to remove lock: ${sanitizedError(error)}`);
    }
  }
}

export function isLockStale(config: Config, lock: LockData | null): boolean {
  if (!lock) return true;
  const updatedAt = parseTimeMs(lock.updatedAt || lock.connectedAt);
  if (!Number.isFinite(updatedAt)) return true;
  const heartbeatExpired = Date.now() - (updatedAt as number) > config.LOCK_STALE_AFTER_MS;

  if (lock.hostname && lock.hostname !== hostname()) return heartbeatExpired;

  try {
    process.kill(lock.pid, 0);
  } catch {
    return true;
  }
  if (lock && lock.processStartToken) {
    const current = getProcessStartToken(lock.pid);
    if (current && current !== lock.processStartToken) return true;
  }
  return false;
}

// --- Health ---

let lastHealthWriteAt = 0;
interface ResolvedHealthInput {
  connected: boolean;
  botName: string | null;
  botUsername: string | null;
  acpSessionId: string | null;
  lastPollAt: string | null;
  lastUpdateAt: string | null;
  lastInboundPromptAt: string | null;
  lastAcpEventAt: string | null;
  lastToolEventAt: string | null;
  typingActive: boolean;
}
const healthInputByStateDir = new Map<string, ResolvedHealthInput>();

export interface ActivePromptState {
  id: string;
  chatId: number;
  userId: number;
  messageId: number;
  startedAt: string;
  lastActivityAt: string | null;
  warningSent: boolean;
  progressNoticeCount: number;
  lastProgressNoticeAt: string | null;
}

export interface PendingPermissionState {
  id: string;
  kind: string;
  summary: string;
  startedAt: string;
  timer: NodeJS.Timeout;
  resolve: (outcome: RequestPermissionResponse) => void;
  messages: Array<{ chatId: number; messageId: number }>;
  rawRequest?: { options: PermissionOption[] };
}

let activePrompt: ActivePromptState | null = null;
let pendingPermission: PendingPermissionState | null = null;
let typingStartedAt: number | null = null;

export function getActivePrompt(): ActivePromptState | null {
  return activePrompt;
}
export function setActivePrompt(p: ActivePromptState | null): void {
  activePrompt = p;
}
export function getPendingPermission(): PendingPermissionState | null {
  return pendingPermission;
}
export function setPendingPermission(p: PendingPermissionState | null): void {
  pendingPermission = p;
}
export function getTypingStartedAt(): number | null {
  return typingStartedAt;
}
export function setTypingStartedAt(t: number | null): void {
  typingStartedAt = t;
}

export function startActivePrompt(chatId: number, messageId: number, userId = chatId): ActivePromptState {
  const startedAt = nowIso();
  activePrompt = {
    id: messageSafeRandom(),
    chatId,
    userId,
    messageId,
    startedAt,
    lastActivityAt: startedAt,
    warningSent: false,
    progressNoticeCount: 0,
    lastProgressNoticeAt: null,
  };
  return activePrompt;
}

export function clearActivePrompt(): void {
  activePrompt = null;
}

export interface HealthSnapshotInput {
  connected: boolean;
  botName?: string | null;
  botUsername?: string | null;
  acpSessionId?: string | null;
  lastPollAt?: string | null;
  lastUpdateAt?: string | null;
  lastInboundPromptAt?: string | null;
  lastAcpEventAt?: string | null;
  lastToolEventAt?: string | null;
  typingActive?: boolean;
}

function resolveHealthInput(config: Config, extra: HealthSnapshotInput): ResolvedHealthInput {
  const previous = healthInputByStateDir.get(config.stateDir);
  const resolved: ResolvedHealthInput = {
    connected: extra.connected,
    botName: extra.botName !== undefined ? extra.botName : previous?.botName ?? null,
    botUsername: extra.botUsername !== undefined
      ? extra.botUsername
      : previous?.botUsername ?? null,
    acpSessionId: extra.acpSessionId !== undefined
      ? extra.acpSessionId
      : previous?.acpSessionId ?? null,
    lastPollAt: extra.lastPollAt !== undefined ? extra.lastPollAt : previous?.lastPollAt ?? null,
    lastUpdateAt: extra.lastUpdateAt !== undefined
      ? extra.lastUpdateAt
      : previous?.lastUpdateAt ?? null,
    lastInboundPromptAt: extra.lastInboundPromptAt !== undefined
      ? extra.lastInboundPromptAt
      : previous?.lastInboundPromptAt ?? null,
    lastAcpEventAt: extra.lastAcpEventAt !== undefined
      ? extra.lastAcpEventAt
      : previous?.lastAcpEventAt ?? null,
    lastToolEventAt: extra.lastToolEventAt !== undefined
      ? extra.lastToolEventAt
      : previous?.lastToolEventAt ?? null,
    typingActive: extra.typingActive !== undefined
      ? extra.typingActive
      : previous?.typingActive ?? false,
  };
  healthInputByStateDir.set(config.stateDir, resolved);
  return resolved;
}

export function buildHealthSnapshot(
  config: Config,
  reason: string,
  extra: HealthSnapshotInput,
): HealthSnapshot {
  const resolved = resolveHealthInput(config, extra);
  const ap = activePrompt;
  const pp = pendingPermission;
  const promptAge = ap ? ageMs(ap.startedAt) : null;
  const promptActivityAge = ap ? ageMs(ap.lastActivityAt || ap.startedAt) : null;
  const typingAge = typingStartedAt ? Date.now() - typingStartedAt : null;

  const snapshot: HealthSnapshot = {
    reason,
    updatedAt: nowIso(),
    connected: resolved.connected,
    pid: process.pid,
    sessionId: resolved.acpSessionId,
    botName: resolved.botName,
    botUsername: resolved.botUsername,
    hostname: hostname(),
    lastPollAt: resolved.lastPollAt,
    lastUpdateAt: resolved.lastUpdateAt,
    lastInboundPromptAt: resolved.lastInboundPromptAt,
    lastAcpEventAt: resolved.lastAcpEventAt,
    lastToolEventAt: resolved.lastToolEventAt,
    typingActive: resolved.typingActive,
    typingAgeMs: typingAge,
    activePrompt: ap
      ? {
          id: ap.id,
          chatId: ap.chatId,
          messageId: ap.messageId,
          startedAt: ap.startedAt,
          lastActivityAt: ap.lastActivityAt,
          warningSent: !!ap.warningSent,
          progressNoticeCount: ap.progressNoticeCount || 0,
          lastProgressNoticeAt: ap.lastProgressNoticeAt,
          ageMs: promptAge,
          activityAgeMs: promptActivityAge,
          stale: !!(promptActivityAge != null && promptActivityAge > config.PROMPT_STALE_AFTER_MS),
        }
      : null,
    pendingPermission: pp
      ? {
          id: pp.id,
          kind: pp.kind,
          summary: sanitizePermissionText(pp.summary, config.PERMISSION_SUMMARY_MAX),
          startedAt: pp.startedAt,
          ageMs: ageMs(pp.startedAt),
          messageCount: pp.messages?.length || 0,
        }
      : null,
    acpSessionId: resolved.acpSessionId,
    likelyState: getLikelyState(resolved.connected, !!pp, !!(promptActivityAge != null && promptActivityAge > config.PROMPT_STALE_AFTER_MS), !!ap),
  };
  return snapshot;
}

function getLikelyState(
  connected: boolean,
  pendingPerm: boolean,
  promptStale: boolean,
  hasActivePrompt: boolean
): string {
  if (!connected) return "disconnected";
  if (pendingPerm) return "waiting for Telegram approval";
  if (promptStale) return "ACP session stalled";
  if (hasActivePrompt) return "waiting for ACP response";
  return "healthy/idle";
}

export function writeHealthSnapshot(
  config: Config,
  reason: string,
  extra: HealthSnapshotInput,
  { force = true }: { force?: boolean } = {}
): void {
  const now = Date.now();
  if (!force && now - lastHealthWriteAt < config.HEALTH_WRITE_MIN_INTERVAL_MS) return;
  try {
    ensureStateDir(config);
    const snap = buildHealthSnapshot(config, reason, extra);
    saveJsonAtomic(healthPath(config), snap, 0o600);
    lastHealthWriteAt = now;
  } catch (err: unknown) {
    console.error(`grok-telegram: failed to write health snapshot: ${sanitizedError(err)}`);
  }
}

export function updateActivePromptActivity() {
  if (activePrompt) {
    activePrompt.lastActivityAt = nowIso();
  }
}
