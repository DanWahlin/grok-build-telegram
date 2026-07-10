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
import { Config } from "./config.js";
import { nowIso, parseTimeMs, ageMs, messageSafeRandom } from "./utils.js";
import { sanitizePermissionText } from "./redact.js";

export interface AccessState {
  allowedUsers: string[];
  pending: Record<string, { code: string; timestamp: number; attempts?: number }>;
}

export interface LockData {
  pid: number;
  sessionId: string;
  botName?: string;
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

export function loadJsonOrDefault<T>(filePath: string, defaultValue: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    if (err.code === "ENOENT") return structuredClone(defaultValue);
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
    try { rmSync(tmp, { force: true }); } catch {}
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
  return loadJsonOrDefault(accessPath(config), DEFAULT_ACCESS);
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
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
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
  const data = loadJsonOrDefault<LockData | null>(lockPath(config), null);
  if (!data || !data.pid || !data.sessionId) return null;
  return data;
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
    } catch {}
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
  resolve: (outcome: any) => void;
  messages: Array<{ chatId: number; messageId: number }>;
  rawRequest?: any;
}

let activePrompt: ActivePromptState | null = null;
let pendingPermission: PendingPermissionState | null = null;
let typingStartedAt: number | null = null;

export function getActivePrompt() {
  return activePrompt;
}
export function setActivePrompt(p: ActivePromptState | null) {
  activePrompt = p;
}
export function getPendingPermission() {
  return pendingPermission;
}
export function setPendingPermission(p: PendingPermissionState | null) {
  pendingPermission = p;
}
export function getTypingStartedAt() {
  return typingStartedAt;
}
export function setTypingStartedAt(t: number | null) {
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
  return activePrompt!;
}

export function clearActivePrompt() {
  activePrompt = null;
}

export function recordAcpEvent(kind?: string) {
  // side effect captured via health write in caller
}

export function buildHealthSnapshot(
  config: Config,
  reason: string,
  extra: {
    connected: boolean;
    botUsername?: string | null;
    acpSessionId?: string | null;
    lastPollAt?: string | null;
    lastUpdateAt?: string | null;
    lastInboundPromptAt?: string | null;
    lastAcpEventAt?: string | null;
    lastToolEventAt?: string | null;
    typingActive?: boolean;
  }
): HealthSnapshot {
  const ap = activePrompt;
  const pp = pendingPermission;
  const promptAge = ap ? ageMs(ap.startedAt) : null;
  const promptActivityAge = ap ? ageMs(ap.lastActivityAt || ap.startedAt) : null;
  const typingAge = typingStartedAt ? Date.now() - typingStartedAt : null;

  const snapshot: HealthSnapshot = {
    reason,
    updatedAt: nowIso(),
    connected: extra.connected,
    pid: process.pid,
    sessionId: extra.acpSessionId || null,
    botName: null,
    botUsername: extra.botUsername || null,
    hostname: hostname(),
    lastPollAt: extra.lastPollAt || null,
    lastUpdateAt: extra.lastUpdateAt || null,
    lastInboundPromptAt: extra.lastInboundPromptAt || null,
    lastAcpEventAt: extra.lastAcpEventAt || null,
    lastToolEventAt: extra.lastToolEventAt || null,
    typingActive: !!extra.typingActive,
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
    acpSessionId: extra.acpSessionId || null,
    likelyState: getLikelyState(extra.connected, !!pp, !!(promptActivityAge != null && promptActivityAge > config.PROMPT_STALE_AFTER_MS), !!ap),
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
  extra: any,
  { force = true }: { force?: boolean } = {}
): void {
  const now = Date.now();
  if (!force && now - lastHealthWriteAt < config.HEALTH_WRITE_MIN_INTERVAL_MS) return;
  try {
    ensureStateDir(config);
    const snap = buildHealthSnapshot(config, reason, extra);
    saveJsonAtomic(healthPath(config), snap, 0o600);
    lastHealthWriteAt = now;
  } catch (err: any) {
    console.error("grok-telegram: failed to write health snapshot:", err.message);
  }
}

export function updateActivePromptActivity() {
  if (activePrompt) {
    activePrompt.lastActivityAt = nowIso();
  }
}
