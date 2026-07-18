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
  setPlanMessageId,
  setThoughtDraft,
  resetSessionUiState,
  dequeuePrompt,
  clearPromptQueue,
  promptQueueLength,
  startActivePrompt,
  type HealthSnapshotInput,
} from "./state.js";
import {
  createTelegramBot,
  stopPolling,
  beginOutboundShutdown,
  closeOutboundQueue,
  sendMessage,
  editMessageReplyMarkup,
  resetStreamDraftState,
  resetAndWaitForStreamDrafts,
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
  type PromptPayload,
  type TelegramDeps,
} from "./telegram.js";
import {
  createAcpClient,
  handlePermissionForward,
  type AcpClientHandle,
  type PermissionRequest,
} from "./acp-client.js";
import type {
  ContentBlock,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { nowIso, sleep } from "./utils.js";
import { sanitizedError } from "./redact.js";
import {
  buildPromptBlocks,
  cleanupInboxFiles,
  ensureInboxDir,
  captureRootIdentity,
  validateRootIdentity,
  formatPlanText,
  formatPlanUpdateText,
  type RootIdentity,
} from "./media.js";
import { Bot } from "grammy";
import { resolve } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createPermissionCards } from "./bridge-permissions.js";
import { createBridgeUi } from "./bridge-ui.js";
import { createWatchdog } from "./bridge-watchdog.js";

export interface Bridge {
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface BridgeFactories {
  createAcpClient?: typeof createAcpClient;
  createTelegramBot?: (config: Config, deps: TelegramDeps) => Bot;
  stopPolling?: typeof stopPolling;
}

export function createBridge(config: Config, factories: BridgeFactories = {}): Bridge {
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
  let lifecycleCompromised = false;
  let shuttingDown = false;
  let promptTask: Promise<void> | null = null;
  const promptUiTasks = new Map<string, Set<Promise<void>>>();
  const closingPromptUiIds = new Set<string>();
  const allowedRootIdentities = new Map(
    config.cwdAllowlist.map((path) => [path, captureRootIdentity(path)] as const),
  );
  let sessionRoot: RootIdentity = allowedRootIdentities.get(config.grokCwdAbs)
    ?? captureRootIdentity(config.grokCwdAbs);
  let acpExpectedRoot: RootIdentity = sessionRoot;
  const sessionIdForLock = `tg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  acquireLock(config, sessionIdForLock);

  setSessionCwd(sessionRoot.path);
  try {
    ensureInboxDir(sessionRoot);
  } catch (error: unknown) {
    console.warn(`[MEDIA] Could not initialize inbox: ${sanitizedError(error)}`);
  }
  setVerboseMode(config.VERBOSE_DEFAULT);

  const access = reloadAccess(config);
  saveAccess(config, access);

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

  const reportHealth = (reason: string): void => {
    writeHealthSnapshot(config, reason, buildExtra(), { force: true });
  };
  const {
    sendPermissionCard,
    expirePermissionCards,
    resolvePermissionFromTelegram,
    cancelPendingPermission,
  } = createPermissionCards(config, reportHealth);
  const { clearStalePromptCard, upsertPlanMessage, updateThoughtStream } = createBridgeUi(config);
  const { runWatchdog } = createWatchdog(config, reportHealth);

  function trackPromptUiTask(promptId: string, operation: Promise<void>): void {
    let tasks = promptUiTasks.get(promptId);
    if (!tasks) {
      tasks = new Set();
      promptUiTasks.set(promptId, tasks);
    }
    const tracked = operation
      .catch((error: unknown) => {
        console.warn(`[TG] Prompt UI task failed: ${sanitizedError(error)}`);
      })
      .finally(() => {
        tasks?.delete(tracked);
        if (tasks?.size === 0) promptUiTasks.delete(promptId);
      });
    tasks.add(tracked);
  }

  async function waitForPromptUiTasks(promptId: string): Promise<void> {
    for (;;) {
      const tasks = promptUiTasks.get(promptId);
      if (!tasks?.size) return;
      await Promise.all([...tasks]);
    }
  }

  const acpClient = (factories.createAcpClient ?? createAcpClient)(config, {
    onSessionUpdate: (upd: SessionUpdate) => {
      const kind = upd.sessionUpdate;
      recordAcp(kind);

      const active = getActivePrompt();
      if (!active || closingPromptUiIds.has(active.id)) return;
      const chats = [active.chatId];
      const chatId = active.chatId;

      switch (upd.sessionUpdate) {
        case "agent_message_chunk":
          if (upd.content.type === "text") {
            appendAssistantDelta(upd.content.text);
            scheduleAssistantDeltaFlush(chats, config);
          }
          break;
        case "agent_thought_chunk":
          if (upd.content.type === "text") {
            trackPromptUiTask(active.id, updateThoughtStream(chatId, upd.content.text, active.id));
          }
          break;
        case "tool_call":
          incrementActivePromptTools();
          trackToolCall(upd.toolCallId, upd.title, upd.rawInput);
          break;
        case "tool_call_update":
          updateToolCall(upd.toolCallId, upd.status);
          break;
        case "plan":
          trackPromptUiTask(active.id, upsertPlanMessage(chatId, formatPlanText(upd.entries ?? []), active.id));
          break;
        case "plan_update": {
          const plan = upd.plan as {
            type?: string;
            entries?: Array<{ content: string; status: string }>;
            content?: string;
            planId?: string;
          };
          trackPromptUiTask(active.id, upsertPlanMessage(chatId, formatPlanUpdateText(plan), active.id));
          break;
        }
        case "plan_removed":
          setPlanMessageId(chatId, null);
          trackPromptUiTask(active.id, sendMessage(chatId, "📋 Plan cleared.").then(() => undefined));
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
    getExpectedRootIdentity: () => acpExpectedRoot,
  });
  acpHandle = acpClient;

  async function shutdownAcpOwnership(): Promise<void> {
    try {
      await acpClient.shutdown();
    } catch (error: unknown) {
      lifecycleCompromised = true;
      queuePaused = true;
      throw error;
    }
  }

  function requireLifecycleOpen(operation: string): void {
    if (shuttingDown || lifecycleCompromised) {
      throw new Error(`${operation} refused while the bridge is shutting down`);
    }
  }

  async function connectAuthorizedRoot(): Promise<void> {
    requireLifecycleOpen("ACP connect");
    validateRootIdentity(sessionRoot);
    try {
      await acpClient.connect();
      requireLifecycleOpen("ACP connect");
      validateRootIdentity(sessionRoot);
    } catch (error: unknown) {
      await shutdownAcpOwnership();
      throw error;
    }
  }

  async function runPromptPayload(chatId: number, payload: PromptPayload, promptId: string): Promise<void> {
    lastInboundPromptAt = nowIso();
    setThoughtDraft(chatId, null);
    setPlanMessageId(chatId, null);

    try {
      await connectAuthorizedRoot();
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
      await onPromptComplete(getCurrentAssistantText(), chatId, promptId);
    } catch (error: unknown) {
      const correlationId = `grok-${Date.now().toString(36)}`;
      console.error(`[${correlationId}] Grok prompt failed: ${sanitizedError(error)}`);
      const current = getActivePrompt();
      if (current?.id === promptId && !current.cancelling) {
        try {
          await sendMessage(
            chatId,
            `Grok Build couldn't complete that request. Reference: ${correlationId}`,
          );
        } catch (deliveryError: unknown) {
          console.error(`[${correlationId}] Error notice delivery failed: ${sanitizedError(deliveryError)}`);
        }
      }
      if (getActivePrompt()?.id === promptId) {
        await clearStalePromptCard(getActivePrompt());
        stopTyping();
        resetStreamDraftState();
        await dismissBubble();
      }
    } finally {
      closingPromptUiIds.add(promptId);
      await resetAndWaitForStreamDrafts();
      await waitForPromptUiTasks(promptId);
      cleanupInboxFiles(payload.inboxFiles);
    }
  }

  async function executePrompt(chatId: number, payload: PromptPayload): Promise<void> {
    if (promptTask) throw new Error("A prompt task is already active");
    const active = getActivePrompt();
    if (!active || active.chatId !== chatId) throw new Error("Active prompt ownership is missing");
    const task = runPromptPayload(chatId, payload, active.id);
    promptTask = task;
    try {
      await task;
    } finally {
      if (promptTask === task) {
        if (getActivePrompt()?.id === active.id) clearActivePrompt();
        promptTask = null;
      }
      closingPromptUiIds.delete(active.id);
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
    if (shuttingDown || lifecycleCompromised || queuePaused || drainingQueue || promptTask || getActivePrompt() || acpClient.isPromptRunning()) return;
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
        next.inboxFiles,
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

  async function onPromptComplete(
    finalText: string | undefined,
    chatIdHint: number | undefined,
    promptId: string,
  ): Promise<void> {
    const active = getActivePrompt();
    if (!active || active.id !== promptId) return;
    const chatId = active?.chatId ?? chatIdHint;
    const chats = chatId != null ? [chatId] : [];
    const toolCount = active?.toolCount ?? getToolsSeenCount();
    const textFromStream = (finalText ?? "").trim();
    stopTyping();

    try {
      if (textFromStream && chats.length) {
        try {
          await finalizeStreamDrafts(textFromStream, chats, config);
        } catch (error: unknown) {
          console.error(`[TG] Final response delivery failed: ${sanitizedError(error)}`);
          // The response is still saved for /retry last by the block below.
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

      if (chats.length) {
        setLastFinalResponse({
          chatId: chats[0]!,
          text: textFromStream,
          savedAt: Date.now(),
        });
      }
    } finally {
      if (getActivePrompt()?.id === promptId) {
        await dismissBubble();
        if (chats[0] != null) setThoughtDraft(chats[0], null);
        await clearStalePromptCard(active);
        writeHealthSnapshot(config, "prompt-done", buildExtra(), { force: true });
      }
    }
  }

  async function stopPromptTaskForTransition(): Promise<boolean> {
    try {
      await acpClient.cancelCurrent();
    } catch (error: unknown) {
      console.warn(`[ACP] Graceful cancel failed: ${sanitizedError(error)}`);
    }
    if (await waitForPromptTask(config.CANCEL_WAIT_MS)) return true;

    console.warn("[ACP] Prompt task did not settle after cancel; terminating the old ACP process");
    await shutdownAcpOwnership();
    const settled = await waitForPromptTask(config.API_TIMEOUT_MS + 5_000);
    if (!settled) lifecycleCompromised = true;
    return settled;
  }

  const deps = {
    config,
    canAcceptPrompts: () => !shuttingDown && !lifecycleCompromised && !queuePaused,
    getSessionRoot: () => sessionRoot,
    onPrompt: async (chatId: number, payload: PromptPayload, _userId: number) => {
      await executePrompt(chatId, payload);
    },
    onCancel: async (chatId: number, userId: number, clearQueue: boolean) => {
      const wasQueuePaused = queuePaused;
      queuePaused = true;
      const ap = getActivePrompt();
      if (!ap || ap.chatId !== chatId || ap.userId !== userId) {
        try {
          const permissionCleanup = !ap ? cancelPendingPermission() : null;
          await permissionCleanup;
          const permissionCancelled = permissionCleanup !== null;
          if (clearQueue) {
            const cleared = clearPromptQueue();
            for (const item of cleared) cleanupInboxFiles(item.inboxFiles);
            return { cancelled: permissionCancelled, queueCleared: cleared.length };
          }
          return { cancelled: permissionCancelled, queueCleared: 0 };
        } finally {
          if (!lifecycleCompromised) queuePaused = wasQueuePaused;
          if (!queuePaused && !promptTask && !getActivePrompt() && !acpClient.isPromptRunning()) {
            void drainQueue();
          }
        }
      }
      try {
        markActivePromptCancelling();
        const permissionCleanup = cancelPendingPermission();
        const taskSettled = await stopPromptTaskForTransition();
        await permissionCleanup;
        if (!taskSettled) {
          console.error("[ACP] Prompt task remained active after process termination; bridge stays busy");
        } else if (getActivePrompt()?.id === ap.id) {
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
            cleanupInboxFiles(item.inboxFiles);
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
        if (!lifecycleCompromised) queuePaused = wasQueuePaused;
        if (!queuePaused && !promptTask && !getActivePrompt() && !acpClient.isPromptRunning()) {
          void drainQueue();
        }
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
          cleanupInboxFiles(item.inboxFiles);
        }
        if (ap) {
          markActivePromptCancelling();
          const taskSettled = await stopPromptTaskForTransition();
          await permissionCleanup;
          if (!taskSettled) {
            console.error("[ACP] Refusing /new because the previous prompt task is still active");
            return false;
          }
        } else {
          const taskSettled = promptTask ? await stopPromptTaskForTransition() : true;
          await permissionCleanup;
          if (!taskSettled) return false;
        }
        await shutdownAcpOwnership();
        if (!(await waitForPromptTask(config.API_TIMEOUT_MS + 5_000))) {
          console.error("[ACP] Refusing /new because prompt delivery did not settle");
          return false;
        }
        const latePermissionCleanup = cancelPendingPermission();
        if (!ap || getActivePrompt()?.id === ap.id) clearActivePrompt();
        stopTyping();
        resetStreamDraftState();
        await clearStalePromptCard(ap);
        await dismissBubble();
        resetSessionUiState();
        await latePermissionCleanup;
        await connectAuthorizedRoot();
        return true;
      } finally {
        if (!lifecycleCompromised) queuePaused = false;
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
      const nextRoot = allowedRootIdentities.get(resolvedPath);
      if (!nextRoot) {
        await sendMessage(chatId, "CWD authorization is unavailable. Restart the bridge and try again.");
        return;
      }
      try {
        validateRootIdentity(nextRoot);
      } catch {
        await sendMessage(chatId, "CWD target changed after startup. Restart the bridge to re-authorize it.");
        return;
      }
      queuePaused = true;
      try {
        const previousPath = acpClient.getCwd();
        await cancelPendingPermission();
        acpExpectedRoot = nextRoot;
        acpClient.setCwd(resolvedPath);
        try {
          requireLifecycleOpen("CWD restart");
          await acpClient.restart();
          requireLifecycleOpen("CWD restart");
          validateRootIdentity(nextRoot);
        } catch (error: unknown) {
          await shutdownAcpOwnership();
          if (shuttingDown || lifecycleCompromised) return;
          acpExpectedRoot = sessionRoot;
          acpClient.setCwd(previousPath);
          try {
            requireLifecycleOpen("CWD rollback");
            validateRootIdentity(sessionRoot);
            await acpClient.restart();
            requireLifecycleOpen("CWD rollback");
            validateRootIdentity(sessionRoot);
          } catch (rollbackError: unknown) {
            await shutdownAcpOwnership();
            console.error(`[ACP] CWD rollback failed: ${sanitizedError(rollbackError)}`);
          }
          await sendMessage(chatId, `Could not switch working directory: ${sanitizedError(error)}`);
          return;
        }
        sessionRoot = nextRoot;
        setSessionCwd(sessionRoot.path);
        try {
          ensureInboxDir(sessionRoot);
        } catch (error: unknown) {
          console.warn(`[MEDIA] Could not initialize inbox: ${sanitizedError(error)}`);
        }
        setLastFinalResponse(null);
        resetSessionUiState();
        await sendMessage(chatId, `Working directory set to:\n${resolvedPath}\nNew ACP session started.`);
      } finally {
        if (!lifecycleCompromised) queuePaused = false;
      }
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

  const bot = (factories.createTelegramBot ?? createTelegramBot)(config, deps);
  botInstance = bot;

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      const active = getActivePrompt();
      if (!active || closingPromptUiIds.has(active.id)) return;
      trackPromptUiTask(active.id, runWatchdog(active));
    }, config.WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref();
  }

  async function start(): Promise<void> {
    console.log("[BRIDGE] Starting Grok Build Telegram bridge...");
    connected = true;

    try {
      try {
        await connectAuthorizedRoot();
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
    beginOutboundShutdown();
    const teardownErrors: unknown[] = [];
    const active = getActivePrompt();
    if (active) markActivePromptCancelling();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }
    if (botInstance) {
      try {
        await (factories.stopPolling ?? stopPolling)(botInstance);
      } catch (error: unknown) {
        teardownErrors.push(error);
        console.error(`[TG] Polling shutdown failed; continuing ACP teardown: ${sanitizedError(error)}`);
      }
    }

    stopTyping();
    resetStreamDraftState();
    const permissionCleanup = cancelPendingPermission();
    const cleared = clearPromptQueue();
    for (const item of cleared) cleanupInboxFiles(item.inboxFiles);

    if (acpHandle) {
      try {
        await acpHandle.cancelCurrent();
      } catch (error: unknown) {
        console.warn(`[ACP] Shutdown cancel failed: ${sanitizedError(error)}`);
      }
      try {
        await acpHandle.shutdown();
      } catch (error: unknown) {
        lifecycleCompromised = true;
        console.error(`[ACP] Initial shutdown attempt failed: ${sanitizedError(error)}`);
      }
    }

    if (permissionCleanup) await permissionCleanup;
    await dismissBubble();
    const promptSettled = !promptTask
      || await waitForPromptTask(config.CANCEL_WAIT_MS + config.API_TIMEOUT_MS + 5_000);
    if (!promptSettled) {
      teardownErrors.push(new Error("Prompt task remained active during shutdown"));
      console.error("[BRIDGE] Prompt task did not settle; preserving lock until process exit");
    }

    // A final serialized ACP shutdown closes any reconnect that raced the first attempt.
    if (acpHandle) {
      try {
        await acpHandle.shutdown();
      } catch (error: unknown) {
        lifecycleCompromised = true;
        teardownErrors.push(error);
        console.error(`[ACP] Final shutdown failed; preserving lock: ${sanitizedError(error)}`);
      }
    }

    await clearStalePromptCard(active);
    if (active) cleanupInboxFiles(active.inboxFiles);
    if (promptSettled) clearActivePrompt();
    try {
      await closeOutboundQueue();
    } catch (error: unknown) {
      teardownErrors.push(error);
      console.error(`[TG] Outbound shutdown failed; preserving lock: ${sanitizedError(error)}`);
    }

    if (teardownErrors.length) {
      lifecycleCompromised = true;
      throw new AggregateError(teardownErrors, "Bridge shutdown did not complete safely");
    }
    removeLock(config, sessionIdForLock);
    writeHealthSnapshot(config, "shutdown", buildExtra(), { force: true });
  }

  return { start, shutdown };
}
