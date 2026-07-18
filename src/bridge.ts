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
  takePendingPermission,
  clearActivePrompt,
  updateActivePromptActivity,
  getTypingStartedAt,
  markActivePromptCancelling,
  incrementActivePromptTools,
  setLastFinalResponse,
  getLastFinalResponse,
  getVerboseMode,
  setVerboseMode,
  getCurrentModeId,
  setCurrentModeId,
  getLastUsage,
  setLastUsage,
  getSessionCwd,
  setSessionCwd,
  getPlanMessageId,
  setPlanMessageId,
  getThoughtDraft,
  setThoughtDraft,
  resetSessionUiState,
  dequeuePrompt,
  clearPromptQueue,
  promptQueueLength,
  startActivePrompt,
  type ActivePromptState,
  type HealthSnapshotInput,
} from "./state.js";
import {
  createTelegramBot,
  stopPolling,
  sendMessage,
  sendPhoto,
  sendDocument,
  editPermissionMessage,
  editMessageReplyMarkup,
  editFormattedMessage,
  sendFormattedMessage,
  expiredPermissionText,
  pendingPermissionText,
  permissionKeyboard,
  resolvedPermissionText,
  resetStreamDraftState,
  finalizeStreamDrafts,
  stopTyping,
  startTyping,
  appendAssistantDelta,
  scheduleAssistantDeltaFlush,
  dismissBubble,
  healthStatusLines,
  getCurrentAssistantText,
  trackToolCall,
  updateToolCall,
  getToolsSeenCount,
  stalePromptKeyboard,
  type PromptPayload,
} from "./telegram.js";
import {
  createAcpClient,
  handlePermissionForward,
  type AcpClientHandle,
  type PermissionRequest,
} from "./acp-client.js";
import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { nowIso, formatAge, ageMs, sleep } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";
import {
  buildPromptBlocks,
  cleanupInboxFiles,
  cleanupStaleInbox,
  classifyArtifact,
  artifactFitsLimit,
  extractPathsFromUnknown,
  formatPlanText,
  formatPlanUpdateText,
  resolveSafeArtifactPath,
} from "./media.js";
import { Bot } from "grammy";
import { resolve } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

export interface Bridge {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

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
  let drainingQueue = false;
  let queuePaused = false;
  let shuttingDown = false;
  let promptTask: Promise<void> | null = null;
  const collectedArtifacts = new Set<string>();

  setSessionCwd(config.grokCwdAbs);
  try {
    cleanupStaleInbox(config.grokCwdAbs);
  } catch (error: unknown) {
    console.warn(`[MEDIA] Could not initialize inbox cleanup: ${sanitizedError(error)}`);
  }
  setVerboseMode(config.VERBOSE_DEFAULT);

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
    const light = kind.endsWith("delta")
      || kind === "agent_message_chunk"
      || kind === "agent_thought_chunk";
    writeHealthSnapshot(config, `acp-${kind}`, buildExtra(), { force: !light });
  }

  function cwd(): string {
    return acpHandle?.getCwd() ?? getSessionCwd(config.grokCwdAbs);
  }

  function rememberArtifacts(paths: string[]): void {
    for (const path of paths) {
      const safePath = resolveSafeArtifactPath(path, cwd());
      if (!safePath || !artifactFitsLimit(safePath, config.MEDIA_MAX_BYTES)) continue;
      const artifact = classifyArtifact(safePath);
      if (artifact) collectedArtifacts.add(artifact.path);
    }
  }

  async function deliverArtifacts(chatId: number, paths: string[]): Promise<string[]> {
    const delivered: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const safePath = resolveSafeArtifactPath(path, cwd());
      if (!safePath || !artifactFitsLimit(safePath, config.MEDIA_MAX_BYTES)) continue;
      const artifact = classifyArtifact(safePath);
      if (!artifact) continue;
      try {
        if (artifact.kind === "photo") {
          await sendPhoto(chatId, artifact.path);
        } else {
          await sendDocument(chatId, artifact.path);
        }
        delivered.push(artifact.path);
      } catch (error: unknown) {
        console.warn(`[TG] Failed to deliver artifact ${path}: ${sanitizedError(error)}`);
      }
    }
    return delivered;
  }

  async function sendPermissionCard(
    summary: string,
    id: string,
    options: PermissionOption[],
  ): Promise<Array<{ chatId: number; messageId: number }>> {
    const active = getActivePrompt();
    const chats = active ? [active.chatId] : [];
    const keyboard = permissionKeyboard(id, options);
    const msgs: Array<{ chatId: number; messageId: number }> = [];
    const safeSummary = sanitizePermissionText(summary, config.PERMISSION_SUMMARY_MAX);
    const text = pendingPermissionText(safeSummary);
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
    const pp = takePendingPermission();
    if (!pp) return false;
    clearTimeout(pp.timer);
    for (const m of pp.messages) {
      try {
        await editPermissionMessage(
          m.chatId,
          m.messageId,
          resolvedPermissionText(pp.summary, label),
        );
      } catch (error: unknown) {
        console.warn(`[TG] Permission confirmation cleanup failed: ${sanitizedError(error)}`);
        try {
          await editMessageReplyMarkup(m.chatId, m.messageId, null);
          await sendMessage(m.chatId, `${label} (via Telegram)`);
        } catch (fallbackError: unknown) {
          console.warn(`[TG] Permission confirmation fallback failed: ${sanitizedError(fallbackError)}`);
        }
      }
    }
    pp.resolve(decision);
    writeHealthSnapshot(config, "permission-resolved", buildExtra(), { force: true });
    return true;
  }

  async function expirePermissionCards(
    summary: string,
    messages: Array<{ chatId: number; messageId: number }>,
  ): Promise<void> {
    for (const message of messages) {
      try {
        await editPermissionMessage(
          message.chatId,
          message.messageId,
          expiredPermissionText(summary),
        );
      } catch (error: unknown) {
        console.warn(`[TG] Failed to expire permission card: ${sanitizedError(error)}`);
        try {
          await editMessageReplyMarkup(message.chatId, message.messageId, null);
        } catch (fallbackError: unknown) {
          console.warn(`[TG] Failed to clear expired permission buttons: ${sanitizedError(fallbackError)}`);
        }
      }
    }
  }

  function cancelPendingPermission(): Promise<void> | null {
    const pending = takePendingPermission();
    if (!pending) return null;
    clearTimeout(pending.timer);
    pending.resolve({ outcome: { outcome: "cancelled" } });
    return expirePermissionCards(pending.summary, pending.messages).catch((error: unknown) => {
      console.warn(`[TG] Pending permission card cleanup failed: ${sanitizedError(error)}`);
    });
  }

  async function clearStalePromptCard(active: ActivePromptState | null): Promise<void> {
    if (!active?.staleMessageId) return;
    try {
      await editMessageReplyMarkup(active.chatId, active.staleMessageId, null);
    } catch (error: unknown) {
      console.warn(`[TG] Failed to clear stale prompt buttons: ${sanitizedError(error)}`);
    } finally {
      active.staleMessageId = null;
    }
  }

  async function upsertPlanMessage(chatId: number, text: string): Promise<void> {
    const existing = getPlanMessageId(chatId);
    if (existing) {
      try {
        await editFormattedMessage(chatId, existing, text);
        return;
      } catch (error: unknown) {
        if (!(error instanceof Error && /message to edit not found/i.test(error.message))) {
          console.warn(`[TG] Plan edit failed: ${sanitizedError(error)}`);
        }
        setPlanMessageId(chatId, null);
      }
    }
    try {
      const sent = await sendFormattedMessage(chatId, text);
      setPlanMessageId(chatId, sent.message_id);
    } catch (error: unknown) {
      console.warn(`[TG] Plan send failed: ${sanitizedError(error)}`);
    }
  }

  async function updateThoughtStream(chatId: number, delta: string): Promise<void> {
    if (!getVerboseMode()) return;
    let draft = getThoughtDraft(chatId);
    if (!draft) draft = { messageId: null, text: "", lastEditAt: 0 };
    draft.text = (draft.text + delta).slice(-3500);
    const now = Date.now();
    if (draft.messageId && now - draft.lastEditAt < config.THOUGHT_EDIT_INTERVAL_MS) {
      setThoughtDraft(chatId, draft);
      return;
    }
    const body = `💭 Thinking…\n${draft.text}`;
    try {
      if (draft.messageId) {
        await editFormattedMessage(chatId, draft.messageId, body);
      } else {
        const sent = await sendFormattedMessage(chatId, body);
        draft.messageId = sent.message_id;
      }
      draft.lastEditAt = now;
      setThoughtDraft(chatId, draft);
    } catch (error: unknown) {
      console.warn(`[TG] Thought stream update failed: ${sanitizedError(error)}`);
    }
  }

  const acpClient = createAcpClient(config, {
    onSessionUpdate: (upd: SessionUpdate) => {
      const kind = upd.sessionUpdate;
      recordAcp(kind);

      const active = getActivePrompt();
      const chats = active ? [active.chatId] : [];
      if (!chats.length) return;
      const chatId = chats[0]!;

      switch (upd.sessionUpdate) {
        case "agent_message_chunk":
          if (upd.content.type === "text") {
            appendAssistantDelta(upd.content.text);
            scheduleAssistantDeltaFlush(chats, config);
          }
          break;
        case "agent_thought_chunk":
          if (upd.content.type === "text") {
            void updateThoughtStream(chatId, upd.content.text);
          }
          break;
        case "tool_call":
          incrementActivePromptTools();
          trackToolCall(upd.toolCallId, upd.title, upd.rawInput);
          break;
        case "tool_call_update":
          updateToolCall(upd.toolCallId, upd.status);
          if (upd.status === "completed") {
            rememberArtifacts(extractPathsFromUnknown(upd.rawOutput, cwd()));
            rememberArtifacts(extractPathsFromUnknown(upd.content, cwd()));
          }
          break;
        case "plan":
          void upsertPlanMessage(chatId, formatPlanText(upd.entries ?? []));
          break;
        case "plan_update": {
          const plan = upd.plan as {
            type?: string;
            entries?: Array<{ content: string; status: string }>;
            content?: string;
            planId?: string;
          };
          void upsertPlanMessage(chatId, formatPlanUpdateText(plan));
          break;
        }
        case "plan_removed":
          setPlanMessageId(chatId, null);
          void sendMessage(chatId, "📋 Plan cleared.").catch(() => undefined);
          break;
        case "current_mode_update":
          setCurrentModeId(upd.currentModeId);
          break;
        case "usage_update": {
          const usage: { used: number; size: number; costAmount?: number; currency?: string } = {
            used: upd.used,
            size: upd.size,
          };
          if (upd.cost?.amount != null) usage.costAmount = upd.cost.amount;
          if (upd.cost?.currency) usage.currency = upd.cost.currency;
          setLastUsage(usage);
          break;
        }
        default:
          break;
      }
    },
    onPermissionRequest: async (req: PermissionRequest) => {
      if (config.GROK_ALWAYS_APPROVE) {
        const allow = (req.options || []).find((option) => option.kind === "allow_always")
          ?? (req.options || []).find((option) => option.kind === "allow_once");
        return {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        };
      }
      return new Promise((resolve) => {
        handlePermissionForward(
          config,
          req,
          sendPermissionCard,
          resolve,
          expirePermissionCards,
        ).catch((error: unknown) => {
          console.error(`[ACP] Permission forwarding failed: ${sanitizedError(error)}`);
          resolve({ outcome: { outcome: "cancelled" } });
        });
      });
    },
    onEvent: (k: string) => recordAcp(k),
  });
  acpHandle = acpClient;

  async function runPromptPayload(chatId: number, payload: PromptPayload): Promise<void> {
    lastInboundPromptAt = nowIso();
    collectedArtifacts.clear();
    setThoughtDraft(chatId, null);
    setPlanMessageId(chatId, null);

    try {
      await acpClient.connect();
      const caps = acpClient.getPromptCapabilities();
      const { blocks } = buildPromptBlocks({
        text: payload.text,
        files: payload.inboxFiles,
        capabilities: caps,
      });

      const finalBlocks: ContentBlock[] = payload.replyContext
        ? [{ type: "text", text: `In reply to:\n${payload.replyContext}` }, ...blocks]
        : blocks;

      await acpClient.sendPrompt(finalBlocks.length === 1 ? finalBlocks[0]! : finalBlocks);
      await onPromptComplete(getCurrentAssistantText(), chatId);
    } catch (error: unknown) {
      const correlationId = `grok-${Date.now().toString(36)}`;
      console.error(`[${correlationId}] Grok prompt failed: ${sanitizedError(error)}`);
      if (!getActivePrompt()?.cancelling) {
        try {
          await sendMessage(
            chatId,
            `Grok Build couldn't complete that request. Reference: ${correlationId}`,
          );
        } catch (deliveryError: unknown) {
          console.error(`[${correlationId}] Error notice delivery failed: ${sanitizedError(deliveryError)}`);
        }
      }
      await clearStalePromptCard(getActivePrompt());
      clearActivePrompt();
      stopTyping();
      resetStreamDraftState();
      await dismissBubble();
    } finally {
      cleanupInboxFiles(payload.inboxFiles.map((f) => f.path));
    }
  }

  async function executePrompt(chatId: number, payload: PromptPayload): Promise<void> {
    if (promptTask) throw new Error("A prompt task is already active");
    const task = runPromptPayload(chatId, payload);
    promptTask = task;
    try {
      await task;
    } finally {
      if (promptTask === task) promptTask = null;
      if (!queuePaused && !drainingQueue && !getActivePrompt() && !acpClient.isPromptRunning()) {
        void drainQueue();
      }
    }
  }

  async function waitForPromptTask(timeoutMs: number): Promise<boolean> {
    const task = promptTask;
    if (!task) return true;
    return Promise.race([
      task.then(() => true, () => true),
      sleep(timeoutMs).then(() => false),
    ]);
  }

  async function drainQueue(): Promise<void> {
    if (shuttingDown || queuePaused || drainingQueue || promptTask || getActivePrompt() || acpClient.isPromptRunning()) return;
    const next = dequeuePrompt();
    if (!next) return;
    drainingQueue = true;
    try {
      resetStreamDraftState();
      startTyping([next.chatId]);
      startActivePrompt(
        next.chatId,
        next.messageId,
        next.userId,
        next.inboxFiles.map((f) => f.path),
      );
      await executePrompt(next.chatId, {
        text: next.text,
        replyContext: next.replyContext,
        inboxFiles: next.inboxFiles,
      });
    } finally {
      drainingQueue = false;
      if (!getActivePrompt() && !acpClient.isPromptRunning() && promptQueueLength() > 0) {
        await drainQueue();
      }
    }
  }

  async function onPromptComplete(finalText: string | undefined, chatIdHint?: number): Promise<void> {
    const active = getActivePrompt();
    const chatId = active?.chatId ?? chatIdHint;
    const chats = chatId != null ? [chatId] : [];
    const toolCount = active?.toolCount ?? getToolsSeenCount();
    const textFromStream = (finalText ?? "").trim();
    stopTyping();

    const allArtifacts = [...collectedArtifacts];

    try {
      if (textFromStream && chats.length) {
        try {
          await finalizeStreamDrafts(textFromStream, chats, config);
        } catch (error: unknown) {
          console.error(`[TG] Final response delivery failed: ${sanitizedError(error)}`);
          setLastFinalResponse({
            chatId: chats[0]!,
            text: textFromStream,
            artifactPaths: allArtifacts,
            savedAt: Date.now(),
          });
          // fall through to still try artifacts / retry storage
        }
      } else if (chats.length) {
        resetStreamDraftState();
        const doneMsg = toolCount > 0
          ? `Done. (no assistant text; ${toolCount} tool call(s) ran)`
          : "Done. (no assistant text)";
        await sendMessage(chats[0]!, doneMsg);
      } else {
        resetStreamDraftState();
      }

      if (chats.length && allArtifacts.length) {
        await deliverArtifacts(chats[0]!, allArtifacts);
      }

      if (chats.length) {
        setLastFinalResponse({
          chatId: chats[0]!,
          text: textFromStream,
          artifactPaths: allArtifacts,
          savedAt: Date.now(),
        });
      }
    } finally {
      await dismissBubble();
      if (chats[0] != null) setThoughtDraft(chats[0], null);
      await clearStalePromptCard(active);
      clearActivePrompt();
      writeHealthSnapshot(config, "prompt-done", buildExtra(), { force: true });
      collectedArtifacts.clear();
    }
  }

  const deps = {
    config,
    canAcceptPrompts: () => !shuttingDown,
    onPrompt: async (chatId: number, payload: PromptPayload, _userId: number) => {
      await executePrompt(chatId, payload);
    },
    onCancel: async (chatId: number, userId: number, clearQueue: boolean) => {
      const ap = getActivePrompt();
      if (!ap || ap.chatId !== chatId || ap.userId !== userId) {
        const permissionCleanup = !ap ? cancelPendingPermission() : null;
        await permissionCleanup;
        const permissionCancelled = permissionCleanup !== null;
        if (clearQueue) {
          const cleared = clearPromptQueue();
          for (const item of cleared) {
            cleanupInboxFiles(item.inboxFiles.map((f) => f.path));
          }
          return { cancelled: permissionCancelled, queueCleared: cleared.length };
        }
        return { cancelled: permissionCancelled, queueCleared: 0 };
      }
      queuePaused = true;
      try {
        markActivePromptCancelling();
        const permissionCleanup = cancelPendingPermission();
        await acpClient.cancelCurrent();
        await permissionCleanup;
        let idle = await acpClient.waitForIdle(config.CANCEL_WAIT_MS);
        if (!idle) {
          console.warn("[ACP] Cancel wait timed out; restarting ACP to guarantee prompt termination");
          await acpClient.restart();
          idle = true;
        }
        const taskSettled = await waitForPromptTask(config.CANCEL_WAIT_MS);
        if (!taskSettled) {
          console.warn("[ACP] Prompt task did not settle after cancellation; keeping bridge busy");
        } else {
          clearActivePrompt();
        }
        stopTyping();
        resetStreamDraftState();
        setThoughtDraft(chatId, null);
        await clearStalePromptCard(ap);
        await dismissBubble();
        let queueCleared = 0;
        if (clearQueue) {
          const cleared = clearPromptQueue();
          queueCleared = cleared.length;
          for (const item of cleared) {
            cleanupInboxFiles(item.inboxFiles.map((file) => file.path));
          }
        }
        try {
          await sendMessage(
            ap.chatId,
            taskSettled
              ? `Cancel completed.${queueCleared ? ` Cleared ${queueCleared} queued prompt(s).` : ""}`
              : `Cancel requested; cleanup is still finishing.${queueCleared ? ` Cleared ${queueCleared} queued prompt(s).` : ""}`,
          );
        } catch (error: unknown) {
          console.warn(`[TG] Failed to deliver cancel confirmation: ${sanitizedError(error)}`);
        }
        return { cancelled: true, queueCleared };
      } finally {
        queuePaused = false;
        if (!promptTask && !getActivePrompt() && !acpClient.isPromptRunning()) void drainQueue();
      }
    },
    onNewSession: async (chatId: number, userId: number) => {
      const ap = getActivePrompt();
      if (ap && (ap.chatId !== chatId || ap.userId !== userId)) return false;
      queuePaused = true;
      try {
        const permissionCleanup = cancelPendingPermission();
        const cleared = clearPromptQueue();
        for (const item of cleared) {
          cleanupInboxFiles(item.inboxFiles.map((file) => file.path));
        }
        let restarted = false;
        if (ap) {
          markActivePromptCancelling();
          await acpClient.cancelCurrent();
          await permissionCleanup;
          const idle = await acpClient.waitForIdle(config.CANCEL_WAIT_MS);
          if (!idle) {
            await acpClient.restart();
            restarted = true;
          }
          await waitForPromptTask(config.CANCEL_WAIT_MS);
          clearActivePrompt();
        } else {
          await permissionCleanup;
        }
        stopTyping();
        resetStreamDraftState();
        await clearStalePromptCard(ap);
        await dismissBubble();
        resetSessionUiState();
        if (!restarted) await acpClient.restart();
        return true;
      } finally {
        queuePaused = false;
      }
    },
    onStatus: async (chatId: number) => {
      const accessState = reloadAccess(config);
      const acpId = acpClient.getSessionId();
      const usage = getLastUsage();
      const lines = [
        `Paired users: ${accessState.allowedUsers.length}`,
        `ACP session: ${acpId ?? "none"}`,
        `CWD: ${cwd()}`,
        `Verbose: ${getVerboseMode() ? "on" : "off"}`,
        `Mode: ${getCurrentModeId() ?? "default"}`,
        `Queue: ${promptQueueLength()}/${config.PROMPT_QUEUE_MAX}`,
        usage
          ? `Usage: ${usage.used}/${usage.size} tokens${usage.costAmount != null ? ` · ${usage.costAmount} ${usage.currency ?? ""}` : ""}`
          : "Usage: n/a",
        `Image prompts: ${acpClient.getPromptCapabilities().image ? "yes" : "no"}`,
        ...healthStatusLines({
          ...buildExtra(),
          acpSessionId: acpId,
        }),
      ];
      await sendMessage(chatId, lines.join("\n"));
      writeHealthSnapshot(config, "status", buildExtra(), { force: true });
    },
    onRetryLast: async (chatId: number) => {
      const last = getLastFinalResponse(config.RETRY_LAST_TTL_MS);
      if (!last || last.chatId !== chatId) {
        await sendMessage(chatId, "No recent response available to retry.");
        return;
      }
      try {
        if (last.text) {
          await finalizeStreamDrafts(last.text, [chatId], config);
        }
        if (last.artifactPaths.length) {
          await deliverArtifacts(chatId, last.artifactPaths);
        }
        await sendMessage(chatId, "Re-sent last response (no agent re-run).");
      } catch (error: unknown) {
        console.error(`[TG] /retry last failed: ${sanitizedError(error)}`);
        await sendMessage(chatId, "Failed to re-send the last response.");
      }
    },
    onSetVerbose: async (chatId: number, enabled: boolean) => {
      setVerboseMode(enabled);
      await sendMessage(
        chatId,
        `Verbose mode ${enabled ? "on" : "off"} (thought stream ${enabled ? "enabled" : "hidden"}).`,
      );
    },
    onSetCwd: async (chatId: number, target: string | null) => {
      if (getActivePrompt() || promptTask || acpClient.isPromptRunning()) {
        await sendMessage(chatId, "Cannot change CWD while a prompt is active. Use /cancel first.");
        return;
      }
      if (promptQueueLength() > 0) {
        await sendMessage(chatId, "Cannot change CWD while prompts are queued. Use /cancel queue first.");
        return;
      }
      if (!target) {
        const list = config.cwdAllowlist
          .map((path, i) => `${i + 1}. ${path}${path === cwd() ? " (current)" : ""}`)
          .join("\n");
        await sendMessage(
          chatId,
          `Allowed working directories:\n${list}\n\nUse /cwd <number|path> to switch.`,
        );
        return;
      }
      let resolvedPath: string | null = null;
      const asIndex = Number(target);
      if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= config.cwdAllowlist.length) {
        resolvedPath = config.cwdAllowlist[asIndex - 1] ?? null;
      } else {
        const candidate = resolve(target);
        if (existsSync(candidate)) {
          try {
            const canonical = realpathSync(candidate);
            if (config.cwdAllowlist.includes(canonical)) resolvedPath = canonical;
          } catch {
            resolvedPath = null;
          }
        }
      }
      if (!resolvedPath) {
        await sendMessage(
          chatId,
          "CWD not in allowlist or does not exist. Use /cwd to list allowed paths.",
        );
        return;
      }
      if (!statSync(resolvedPath).isDirectory()) {
        await sendMessage(chatId, "CWD target is not a directory.");
        return;
      }
      const previousPath = acpClient.getCwd();
      await cancelPendingPermission();
      acpClient.setCwd(resolvedPath);
      try {
        await acpClient.restart();
      } catch (error: unknown) {
        acpClient.setCwd(previousPath);
        try {
          await acpClient.restart();
        } catch (rollbackError: unknown) {
          console.error(`[ACP] CWD rollback failed: ${sanitizedError(rollbackError)}`);
        }
        await sendMessage(chatId, `Could not switch working directory: ${sanitizedError(error)}`);
        return;
      }
      setSessionCwd(resolvedPath);
      try {
        cleanupStaleInbox(resolvedPath);
      } catch (error: unknown) {
        console.warn(`[MEDIA] Could not initialize inbox cleanup: ${sanitizedError(error)}`);
      }
      setLastFinalResponse(null);
      resetSessionUiState();
      await sendMessage(chatId, `Working directory set to:\n${resolvedPath}\nNew ACP session started.`);
    },
    onStaleAction: async (
      chatId: number,
      userId: number,
      promptId: string,
      action: "cancel" | "keep",
    ) => {
      const ap = getActivePrompt();
      if (!ap || ap.id !== promptId || ap.chatId !== chatId || ap.userId !== userId) return false;
      if (action === "keep") {
        ap.warningSent = false;
        ap.lastActivityAt = nowIso();
        if (ap.staleMessageId) {
          try {
            await editMessageReplyMarkup(chatId, ap.staleMessageId, null);
          } catch {
            // best effort
          }
        }
        await sendMessage(chatId, "Continuing to wait for ACP.");
        return true;
      }
      await deps.onCancel(chatId, userId, false);
      return true;
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
    }, config.WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref();
  }

  async function runWatchdog(): Promise<void> {
    const ap = getActivePrompt();
    if (!ap || ap.cancelling) return;
    const age = ageMs(ap.startedAt);
    const activityAge = ageMs(ap.lastActivityAt ?? ap.startedAt);
    await maybeProgressNotice(ap, age);
    if (
      activityAge != null
      && activityAge > config.PROMPT_STALE_AFTER_MS
      && !ap.warningSent
    ) {
      ap.warningSent = true;
      stopTyping();
      resetStreamDraftState();
      await dismissBubble();
      try {
        const sent = await sendMessage(
          ap.chatId,
          `⚠️ ACP appears stalled (${formatAge(activityAge)} without activity).`,
          { reply_markup: stalePromptKeyboard(ap.id) },
        );
        ap.staleMessageId = sent.message_id;
      } catch (error: unknown) {
        console.warn(`[WATCHDOG] Stale notice failed: ${sanitizedError(error)}`);
      }
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

  async function start(): Promise<void> {
    console.log("[BRIDGE] Starting Grok Build Telegram bridge...");
    connected = true;

    try {
      try {
        await acpClient.connect();
      } catch (error: unknown) {
        console.warn(
          `[BRIDGE] Initial ACP connect failed (will retry on first prompt): ${sanitizedError(error)}`,
        );
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
          console.log(
            `[TG] ${currentBotUsername ? `@${currentBotUsername}` : currentBotName} ready.`,
          );
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
    shuttingDown = true;
    connected = false;
    queuePaused = true;
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

    await cancelPendingPermission();

    if (botInstance) await stopPolling(botInstance);
    const active = getActivePrompt();
    const cleared = clearPromptQueue();
    for (const item of cleared) {
      cleanupInboxFiles(item.inboxFiles.map((file) => file.path));
    }

    if (acpHandle) {
      try {
        await acpHandle.shutdown();
      } catch (error: unknown) {
        console.error(`[ACP] Shutdown failed: ${sanitizedError(error)}`);
      }
    }
    if (promptTask && !await waitForPromptTask(config.CANCEL_WAIT_MS + config.API_TIMEOUT_MS)) {
      console.warn("[BRIDGE] Prompt task did not settle before shutdown cleanup");
    }
    await clearStalePromptCard(active);
    if (active) cleanupInboxFiles(active.inboxFiles);
    clearActivePrompt();

    removeLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "shutdown", buildExtra(), { force: true });
  }

  return { start, shutdown };
}
