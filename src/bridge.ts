import type { Config } from "./config.js";
import {
  ensureStateDir,
  reloadAccess,
  saveAccess,
  acquireLock,
  removeLock,
  refreshLock,
  writeHealthSnapshot,
  getActivePrompt,
  getPendingPermission,
  setPendingPermission,
  clearActivePrompt,
  updateActivePromptActivity,
  getTypingStartedAt,
  type ActivePromptState,
  type HealthSnapshotInput,
} from "./state.js";
import {
  createTelegramBot,
  stopPolling,
  sendMessage,
  editMessageReplyMarkup,
  resetStreamDraftState,
  finalizeStreamDrafts,
  stopTyping,
  appendAssistantDelta,
  scheduleAssistantDeltaFlush,
  dismissBubble,
  healthStatusLines,
  getCurrentAssistantText,
  trackToolCall,
  updateToolCall,
} from "./telegram.js";
import {
  createAcpClient,
  handlePermissionForward,
  type AcpClientHandle,
  type PermissionRequest,
} from "./acp-client.js";
import type {
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { nowIso, formatAge, ageMs } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";
import { Bot, InlineKeyboard } from "grammy";

export interface Bridge {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const WATCHDOG_INTERVAL_MS = 30_000;

export function createBridge(config: Config): Bridge {
  ensureStateDir(config);
  let botInstance: Bot | null = null;
  let acpHandle: AcpClientHandle | null = null;
  let lastPollAt: string | null = null;
  let lastUpdateAt: string | null = null;
  let lastInboundPromptAt: string | null = null;
  let lastAcpEventAt: string | null = null;
  let lastToolEventAt: string | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let lockHeartbeatTimer: NodeJS.Timeout | null = null;
  let connected = false;
  let currentBotName: string | null = null;
  let currentBotUsername: string | null = null;
  let shutdownPromise: Promise<void> | null = null;

  // initial access
  const access = reloadAccess(config);
  saveAccess(config, access);

  const sessionIdForLock = `tg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  acquireLock(config, sessionIdForLock);

  function updateLastPoll() {
    lastPollAt = nowIso();
    refreshLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "poll", buildExtra(), { force: false });
  }

  function buildExtra(): HealthSnapshotInput {
    return {
      connected,
      botName: currentBotName,
      botUsername: currentBotUsername,
      acpSessionId: acpHandle?.getSessionId() ?? null,
      lastPollAt,
      lastUpdateAt,
      lastInboundPromptAt,
      lastAcpEventAt,
      lastToolEventAt,
      typingActive: getTypingStartedAt() !== null,
    };
  }

  function recordAcp(kind: string) {
    lastAcpEventAt = nowIso();
    if (kind.includes("tool")) lastToolEventAt = lastAcpEventAt;
    updateActivePromptActivity();
    writeHealthSnapshot(config, `acp-${kind}`, buildExtra(), { force: !kind.endsWith("delta") });
  }

  // Permission sender
  async function sendPermissionCard(
    summary: string,
    id: string,
    _options: PermissionOption[],
  ): Promise<Array<{ chatId: number; messageId: number }>> {
    const active = getActivePrompt();
    const chats = active ? [active.chatId] : [];
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `grok:a:${id}`)
      .text("❌ Reject", `grok:r:${id}`);
    const msgs: Array<{ chatId: number; messageId: number }> = [];
    const text = `⚠️ Grok Build needs approval\n\n${sanitizePermissionText(summary, config.PERMISSION_SUMMARY_MAX)}\n\nTap a button or reply approve/reject.`;
    if (chats.length === 0) {
      throw new Error("No active Telegram chat available for ACP permission request");
    }
    let lastError: unknown;
    for (const chatId of chats) {
      try {
        const sent = await sendMessage(chatId, text, { reply_markup: keyboard });
        msgs.push({ chatId, messageId: sent.message_id });
      } catch (error: unknown) {
        console.error(`[TG] Permission card delivery failed: ${sanitizedError(error)}`);
        lastError = error;
      }
    }
    if (msgs.length === 0 && lastError) throw lastError;
    return msgs;
  }

  async function resolvePermissionFromTelegram(
    decision: RequestPermissionResponse,
    label: string,
    _userDisplay: string,
  ): Promise<boolean> {
    const pp = getPendingPermission();
    if (!pp) return false;
    clearTimeout(pp.timer);
    const messages = [...pp.messages];
    setPendingPermission(null);
    for (const m of messages) {
      try {
        await editMessageReplyMarkup(m.chatId, m.messageId, null);
        await sendMessage(m.chatId, `${label} (via Telegram)`);
      } catch (error: unknown) {
        console.warn(`[TG] Permission confirmation cleanup failed: ${sanitizedError(error)}`);
      }
    }
    // call the ACP resolver
    pp.resolve(decision);
    writeHealthSnapshot(config, "permission-resolved", buildExtra(), { force: true });
    return true;
  }

  // ACP handlers
  const acpClient = createAcpClient(config, {
    onSessionUpdate: (upd: SessionUpdate) => {
      const kind = upd.sessionUpdate;
      recordAcp(kind);

      const active = getActivePrompt();
      const chats = active ? [active.chatId] : [];
      if (!chats.length) return;

      switch (upd.sessionUpdate) {
        case "agent_message_chunk":
          if (upd.content.type === "text") {
            appendAssistantDelta(upd.content.text);
            scheduleAssistantDeltaFlush(chats, config);
          }
          break;
        case "tool_call":
          trackToolCall(upd.toolCallId, upd.title, upd.rawInput);
          break;
        case "tool_call_update":
          updateToolCall(upd.toolCallId, upd.status);
          break;
        default:
          break;
      }
    },
    onPermissionRequest: async (req: PermissionRequest) => {
      if (config.GROK_ALWAYS_APPROVE) {
        const allow = (req.options || []).find((option) =>
          option.kind === "allow_once" || option.kind === "allow_always"
        );
        return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
      }
      return new Promise((resolve) => {
        handlePermissionForward(config, req, sendPermissionCard, resolve).catch((error: unknown) => {
          console.error(`[ACP] Permission forwarding failed: ${sanitizedError(error)}`);
          resolve({ outcome: { outcome: "cancelled" } });
        });
      });
    },
    onEvent: (k: string) => recordAcp(k),
  });
  acpHandle = acpClient;

  // Telegram handlers
  const deps = {
    config,
    onPrompt: async (chatId: number, text: string, _userId: number) => {
      lastInboundPromptAt = nowIso();
      try {
        await acpClient.sendPrompt(text);
        await onPromptComplete(getCurrentAssistantText());
      } catch (error: unknown) {
        const correlationId = `grok-${Date.now().toString(36)}`;
        console.error(`[${correlationId}] Grok prompt failed: ${sanitizedError(error)}`);
        try {
          await sendMessage(chatId, `Grok Build couldn't complete that request. Reference: ${correlationId}`);
        } catch (deliveryError: unknown) {
          console.error(`[${correlationId}] Error notice delivery failed: ${sanitizedError(deliveryError)}`);
        }
        clearActivePrompt();
        stopTyping();
        resetStreamDraftState();
        await dismissBubble();
      }
    },
    onCancel: async (chatId: number, userId: number) => {
      const ap = getActivePrompt();
      if (!ap || ap.chatId !== chatId || ap.userId !== userId) return false;
      await acpClient.cancelCurrent();
      clearActivePrompt();
      stopTyping();
      resetStreamDraftState();
      try {
        await sendMessage(ap.chatId, "Cancel sent to ACP.");
      } catch (error: unknown) {
        console.warn(`[TG] Failed to deliver cancel confirmation: ${sanitizedError(error)}`);
      }
      return true;
    },
    onNewSession: async (chatId: number, userId: number) => {
      const ap = getActivePrompt();
      if (ap && (ap.chatId !== chatId || ap.userId !== userId)) return false;
      await acpClient.restart();
      return true;
    },
    onStatus: async (chatId: number) => {
      const access = reloadAccess(config);
      const paired = access.allowedUsers.length;
      const acpId = acpClient.getSessionId();
      const lines = [
        `Paired users: ${paired}`,
        `ACP session: ${acpId ?? "none"}`,
        ...healthStatusLines({
          ...buildExtra(),
          acpSessionId: acpId,
        }),
      ];
      await sendMessage(chatId, lines.join("\n"));
      writeHealthSnapshot(config, "status", buildExtra(), { force: true });
    },
    resolvePermission: resolvePermissionFromTelegram,
    onUpdate: () => {
      lastUpdateAt = nowIso();
      updateLastPoll();
    },
  };

  const bot = createTelegramBot(config, deps);
  botInstance = bot;

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      void runWatchdog().catch((error: unknown) => {
        console.error(`[WATCHDOG] Check failed: ${sanitizedError(error)}`);
      });
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref();
  }

  async function runWatchdog(): Promise<void> {
    const ap = getActivePrompt();
    if (!ap) return;
    const age = ageMs(ap.startedAt);
    const activityAge = ageMs(ap.lastActivityAt ?? ap.startedAt);
    await maybeProgressNotice(ap, age);
    if (activityAge != null
      && activityAge > config.PROMPT_STALE_AFTER_MS
      && !ap.warningSent) {
      ap.warningSent = true;
      stopTyping();
      resetStreamDraftState();
      await dismissBubble();
      await sendMessage(
        ap.chatId,
        `⚠️ ACP appears stalled (${formatAge(activityAge)} without activity).`,
      );
      writeHealthSnapshot(config, "stalled", buildExtra(), { force: true });
    }
  }

  async function maybeProgressNotice(
    ap: ActivePromptState,
    age: number | null,
  ): Promise<void> {
    if (age == null || age < config.PROGRESS_NOTICE_AFTER_MS) return;
    if (ap.progressNoticeCount >= config.PROGRESS_NOTICE_MAX_ITERATIONS) return;
    const lastAge = ap.lastProgressNoticeAt ? ageMs(ap.lastProgressNoticeAt) : 999999;
    if ((lastAge || 0) < config.PROGRESS_NOTICE_INTERVAL_MS) return;
    ap.progressNoticeCount += 1;
    ap.lastProgressNoticeAt = nowIso();
    const iteration = Math.min(
      config.PROGRESS_NOTICE_MAX_ITERATIONS,
      Math.max(1, Math.ceil(age / config.PROGRESS_NOTICE_ITERATION_MS)),
    );
    const detail = getPendingPermission() ? "waiting permission" : "working";
    await sendMessage(
      ap.chatId,
      `⏳ Still working... ${formatAge(age)} — ${detail} (${iteration}/${config.PROGRESS_NOTICE_MAX_ITERATIONS})`,
    );
  }

  async function onPromptComplete(finalText?: string): Promise<void> {
    const active = getActivePrompt();
    const chats = active ? [active.chatId] : [];
    clearActivePrompt();
    stopTyping();
    try {
      if (finalText && chats.length) {
        await finalizeStreamDrafts(finalText, chats, config);
      } else {
        resetStreamDraftState();
      }
    } finally {
      await dismissBubble();
      writeHealthSnapshot(config, "prompt-done", buildExtra(), { force: true });
    }
  }

  async function start(): Promise<void> {
    console.log("[BRIDGE] Starting Grok Build Telegram bridge...");
    connected = true;

    try {
      try {
        await acpClient.connect();
      } catch (error: unknown) {
        console.warn(`[BRIDGE] Initial ACP connect failed (will retry on first prompt): ${sanitizedError(error)}`);
      }

      startWatchdog();
      lockHeartbeatTimer = setInterval(() => {
        if (!refreshLock(config, sessionIdForLock)) {
          console.error("[LOCK] Lost poller lock ownership; shutting down.");
          void shutdown();
        }
      }, 15_000);
      lockHeartbeatTimer.unref();

      const initialAccess = reloadAccess(config);
      if (initialAccess.allowedUsers.length === 0) {
        console.log("[BRIDGE] No paired user. Send a private message to the bot to start pairing.");
      }

      await bot.start({
        allowed_updates: ["message", "callback_query"],
        onStart: (me) => {
          currentBotName = me.first_name;
          currentBotUsername = me.username ?? null;
          console.log(`[TG] ${currentBotUsername ? `@${currentBotUsername}` : currentBotName} ready.`);
          writeHealthSnapshot(config, "tg-ready", buildExtra(), { force: true });
        },
      });
    } catch (error: unknown) {
      await shutdown();
      throw error;
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = performShutdown();
    return shutdownPromise;
  }

  async function performShutdown(): Promise<void> {
    console.log("[BRIDGE] Shutting down...");
    connected = false;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
    stopTyping();
    resetStreamDraftState();
    await dismissBubble();

    const pp = getPendingPermission();
    if (pp) {
      clearTimeout(pp.timer);
      setPendingPermission(null);
      for (const m of pp.messages) {
        try {
          await editMessageReplyMarkup(m.chatId, m.messageId, null);
        } catch (error: unknown) {
          console.warn(`[TG] Failed to clear pending permission during shutdown: ${sanitizedError(error)}`);
        }
      }
    }

    clearActivePrompt();

    if (botInstance) await stopPolling(botInstance);
    if (acpHandle) {
      try {
        await acpHandle.shutdown();
      } catch (error: unknown) {
        console.error(`[ACP] Shutdown failed: ${sanitizedError(error)}`);
      }
    }

    removeLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "shutdown", buildExtra(), { force: true });
  }

  return { start, shutdown };
}
