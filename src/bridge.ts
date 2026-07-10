import { Config } from "./config.js";
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
} from "./state.js";
import {
  createTelegramBot,
  startPolling,
  stopPolling,
  sendFormattedMessage,
  sendMessage,
  editMessageReplyMarkup,
  resetStreamDraftState,
  finalizeStreamDrafts,
  startTyping,
  stopTyping,
  appendAssistantDelta,
  scheduleAssistantDeltaFlush,
  dismissBubble,
  healthStatusLines,
  getCurrentAssistantText,
  trackToolCall,
  updateToolCall,
} from "./telegram.js";
import { createAcpClient, PermissionRequest, handlePermissionForward } from "./acp-client.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { nowIso, sleep, formatAge, ageMs } from "./utils.js";
import { sanitizePermissionText } from "./redact.js";
import { InlineKeyboard } from "grammy";

export interface Bridge {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

let botInstance: any = null;
let acpHandle: ReturnType<typeof createAcpClient> | null = null;
let lastPollAt: string | null = null;
let lastUpdateAt: string | null = null;
let lastInboundPromptAt: string | null = null;
let lastAcpEventAt: string | null = null;
let lastToolEventAt: string | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let lockHeartbeatTimer: NodeJS.Timeout | null = null;
let connected = false;
let currentBotUsername: string | null = null;

export function createBridge(config: Config): Bridge {
  ensureStateDir(config);

  // initial access
  let access = reloadAccess(config);
  saveAccess(config, access);

  const sessionIdForLock = `tg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  acquireLock(config, sessionIdForLock);

  function updateLastPoll() {
    lastPollAt = nowIso();
    refreshLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "poll", buildExtra(), { force: false });
  }

  function buildExtra() {
    const ap = getActivePrompt();
    const pp = getPendingPermission();
    return {
      connected,
      botUsername: currentBotUsername,
      acpSessionId: acpHandle?.getSessionId() || null,
      lastPollAt,
      lastUpdateAt,
      lastInboundAt: lastInboundPromptAt,
      lastAcpAt: lastAcpEventAt,
      lastToolAt: lastToolEventAt,
      typingActive: !!getActivePrompt(), // rough
      typingAgeMs: null,
      likelyState: pp ? "waiting for Telegram approval" : ap ? "working" : "idle",
    };
  }

  function recordAcp(kind: string) {
    lastAcpEventAt = nowIso();
    if (kind.includes("tool")) lastToolEventAt = lastAcpEventAt;
    updateActivePromptActivity();
    writeHealthSnapshot(config, `acp-${kind}`, buildExtra(), { force: !kind.endsWith("delta") });
  }

  // Permission sender
  async function sendPermissionCard(summary: string, id: string, _options: any[]) {
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
    for (const chatId of chats) {
      try {
        const sent: any = await sendMessage(chatId, text, { reply_markup: keyboard });
        if (sent?.message_id) msgs.push({ chatId, messageId: sent.message_id });
      } catch (e) {}
    }
    return msgs;
  }

  async function resolvePermissionFromTelegram(decision: any, label: string, _userDisplay: string) {
    const pp = getPendingPermission();
    if (!pp) return false;
    clearTimeout(pp.timer);
    const messages = [...pp.messages];
    setPendingPermission(null);
    for (const m of messages) {
      try {
        await editMessageReplyMarkup(m.chatId, m.messageId, null);
        await sendMessage(m.chatId, `${label} (via Telegram)`);
      } catch {}
    }
    // call the ACP resolver
    try {
      pp.resolve(decision);
    } catch {}
    writeHealthSnapshot(config, "permission-resolved", buildExtra(), { force: true });
    return true;
  }

  // ACP handlers
  const acpClient = createAcpClient(config, {
    onSessionUpdate: (upd: SessionUpdate) => {
      const u = upd as any;
      const kind = u.sessionUpdate || "update";
      recordAcp(kind);

      const active = getActivePrompt();
      const chats = active ? [active.chatId] : [];
      if (!chats.length) return;

      if (kind === "agent_message_chunk" && u.content?.type === "text") {
        appendAssistantDelta(u.content.text || "");
        scheduleAssistantDeltaFlush(chats, config);
      } else if (kind === "tool_call") {
        trackToolCall(u.toolCallId || u.id, u.title, u.rawInput);
      } else if (kind === "tool_call_update") {
        updateToolCall(u.toolCallId || u.id, u.status);
      } else if (kind === "plan" || kind === "agent_thought_chunk") {
        // ignore for TG or log
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
        handlePermissionForward(config, req, sendPermissionCard, (outcome) => resolve(outcome)).catch(() => {
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
      } catch (error) {
        const correlationId = `grok-${Date.now().toString(36)}`;
        console.error(`[${correlationId}] Grok prompt failed:`, sanitizePermissionText(error instanceof Error ? error.message : String(error), 500));
        await sendMessage(chatId, `Grok Build couldn't complete that request. Reference: ${correlationId}`).catch(() => {});
        clearActivePrompt();
        stopTyping();
      }
    },
    onCancel: async (chatId: number, userId: number) => {
      const ap = getActivePrompt();
      if (!ap || ap.chatId !== chatId || ap.userId !== userId) return false;
      await acpClient.cancelCurrent();
      if (ap) {
        try {
          await sendMessage(ap.chatId, "Cancel sent to ACP.");
        } catch {}
      }
      clearActivePrompt();
      stopTyping();
      resetStreamDraftState();
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
        `ACP session: ${acpId || "none"}`,
        ...healthStatusLines({
          lastPollAt,
          lastUpdateAt,
          lastInboundAt: lastInboundPromptAt,
          lastAcpAt: lastAcpEventAt,
          lastToolAt: lastToolEventAt,
          typingActive: false,
          acpSessionId: acpId,
          likelyState: getPendingPermission() ? "waiting-permission" : getActivePrompt() ? "working" : "idle",
        }),
      ];
      await sendMessage(chatId, lines.join("\n")).catch(() => {});
      writeHealthSnapshot(config, "status", buildExtra(), { force: true });
    },
    resolvePermission: resolvePermissionFromTelegram,
    getBotUsername: () => currentBotUsername,
    getAcpSessionId: () => acpClient.getSessionId(),
    getConnected: () => connected,
    getLastPollAt: () => lastPollAt,
    getLastUpdateAt: () => lastUpdateAt,
    getLastInboundAt: () => lastInboundPromptAt,
    getLastAcpAt: () => lastAcpEventAt,
    getLastToolAt: () => lastToolEventAt,
    onUpdate: () => {
      lastUpdateAt = nowIso();
      updateLastPoll();
    },
  };

  const bot = createTelegramBot(config, deps);
  botInstance = bot;

  async function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      const ap = getActivePrompt();
      if (!ap) return;
      const age = ageMs(ap.startedAt);
      const actAge = ageMs(ap.lastActivityAt || ap.startedAt);
      await maybeProgressNotice(ap, age, actAge);
      if (actAge != null && actAge > config.PROMPT_STALE_AFTER_MS && !ap.warningSent) {
        ap.warningSent = true;
        stopTyping();
        resetStreamDraftState();
        await dismissBubble().catch(() => {});
        await sendMessage(ap.chatId, `⚠️ ACP appears stalled (${formatAge(actAge)} without activity).`).catch(() => {});
        writeHealthSnapshot(config, "stalled", buildExtra(), { force: true });
      }
    }, 30000);
  }

  async function maybeProgressNotice(ap: any, age: number | null, _act: number | null) {
    if (!ap || age == null || age < config.PROGRESS_NOTICE_AFTER_MS) return;
    const lastAge = ap.lastProgressNoticeAt ? ageMs(ap.lastProgressNoticeAt) : 999999;
    if ((lastAge || 0) < config.PROGRESS_NOTICE_INTERVAL_MS) return;
    ap.progressNoticeCount = (ap.progressNoticeCount || 0) + 1;
    ap.lastProgressNoticeAt = nowIso();
    const iter = Math.max(1, Math.ceil(age / config.PROGRESS_NOTICE_ITERATION_MS));
    const detail = getPendingPermission() ? "waiting permission" : "working";
    await sendMessage(ap.chatId, `⏳ Still working... ${formatAge(age)} — ${detail}`).catch(() => {});
  }

  async function onPromptComplete(finalText?: string) {
    const active = getActivePrompt();
    const chats = active ? [active.chatId] : [];
    clearActivePrompt();
    stopTyping();
    if (finalText && chats.length) {
      try {
        await finalizeStreamDrafts(finalText, chats, config);
      } catch {}
    } else {
      resetStreamDraftState();
    }
    await dismissBubble().catch(() => {});
    writeHealthSnapshot(config, "prompt-done", buildExtra(), { force: true });
  }

  async function start() {
    console.log("[BRIDGE] Starting Grok Build Telegram bridge...");
    connected = true;

    try {
      try {
        await acpClient.connect();
      } catch (e: any) {
        console.warn("[BRIDGE] Initial ACP connect failed (will retry on first prompt):", e.message);
      }

    // Patch to capture bot identity before polling.
    const origStart = bot.start.bind(bot);
    bot.start = async (opts?: any) => {
      const me = await bot.api.getMe();
      currentBotUsername = me.username || null;
      console.log(`[TG] @${currentBotUsername} ready.`);
      writeHealthSnapshot(config, "tg-ready", buildExtra(), { force: true });
      return origStart(opts);
    };

    startWatchdog();
    lockHeartbeatTimer = setInterval(() => {
      if (!refreshLock(config, sessionIdForLock)) {
        console.error("[LOCK] Lost poller lock ownership; shutting down.");
        void shutdown();
      }
    }, 15000);
    lockHeartbeatTimer.unref();

    const initialAccess = reloadAccess(config);
    if (initialAccess.allowedUsers.length === 0) {
      console.log("[BRIDGE] No paired user. Send a private message to the bot to start pairing.");
    }

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    await bot.start({ allowed_updates: ["message", "callback_query"] });
    } catch (error) {
      await shutdown();
      throw error;
    }
  }

  async function shutdown() {
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
    await dismissBubble().catch(() => {});

    const pp = getPendingPermission();
    if (pp) {
      clearTimeout(pp.timer);
      setPendingPermission(null);
      for (const m of pp.messages) {
        editMessageReplyMarkup(m.chatId, m.messageId, null).catch(() => {});
      }
    }

    clearActivePrompt();

    if (botInstance) await stopPolling(botInstance);
    if (acpHandle) await acpHandle.shutdown().catch(() => {});

    removeLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "shutdown", { connected: false }, { force: true });
    // give sends a moment
    await sleep(200);
  }

  return { start, shutdown };
}
