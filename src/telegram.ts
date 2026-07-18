import { Bot, type Context } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import { formatAge, ageMs } from "./utils.js";
import {
  reloadAccess,
  isAllowed,
  cleanExpiredPending,
  startPairing,
  completePairing,
  startActivePrompt,
  clearActivePrompt,
  getActivePrompt,
  getPendingPermission,
  getTypingStartedAt,
  enqueuePrompt,
  getLikelyState,
  type HealthSnapshotInput,
} from "./state.js";
import { sanitizedError } from "./redact.js";
import { cleanupInboxFiles, type InboxFile, type RootIdentity } from "./media.js";
import {
  setTelegramRuntime,
  beginUpdate,
  endUpdate,
  getRuntimeConfig,
  sendMessage,
  answerCallbackQuery,
  editPermissionMessage,
  editMessageReplyMarkup,
  setMessageReaction,
  resetApiForTests,
} from "./telegram-api.js";
import {
  permissionSelection,
  permissionSelectionByKind,
  finalizeExistingPermissionText,
} from "./telegram-permissions.js";
import { resetStreamDraftState } from "./telegram-stream.js";
import { startTyping, stopTyping } from "./telegram-typing.js";
import {
  setBubbleActive,
  setToolsSeenCount,
  resetBubblesForTests,
} from "./telegram-bubbles.js";
import {
  extractMediaFromMessage,
  replyContextFromMessage,
  messageHasMedia,
} from "./telegram-media.js";

export { escapeHtml, markdownToTelegramHtml, chunkMessage } from "./telegram-render.js";
export {
  permissionKeyboard,
  stalePromptKeyboard,
  permissionSelection,
  permissionSelectionByKind,
  pendingPermissionText,
  resolvedPermissionText,
  expiredPermissionText,
  finalizeExistingPermissionText,
} from "./telegram-permissions.js";
export {
  sendMessage,
  sendFormattedMessage,
  editFormattedMessage,
  editMessageReplyMarkup,
  editPermissionMessage,
  stopPolling,
  beginOutboundShutdown,
  closeOutboundQueue,
} from "./telegram-api.js";
export {
  resetStreamDraftState,
  resetAndWaitForStreamDrafts,
  finalizeStreamDrafts,
  appendAssistantDelta,
  scheduleAssistantDeltaFlush,
  getCurrentAssistantText,
  getStreamDrafts,
} from "./telegram-stream.js";
export { startTyping, stopTyping } from "./telegram-typing.js";
export {
  dismissBubble,
  trackToolCall,
  updateToolCall,
  getToolsSeenCount,
  describeTool,
} from "./telegram-bubbles.js";

export interface PromptPayload {
  text: string;
  replyContext: string | null;
  inboxFiles: InboxFile[];
}

export interface CancelResult {
  cancelled: boolean;
  queueCleared: number;
}

export interface TelegramDeps {
  config: Config;
  canAcceptPrompts?: () => boolean;
  getSessionRoot: () => RootIdentity;
  onPrompt: (chatId: number, payload: PromptPayload, fromUserId: number) => Promise<void>;
  onCancel: (chatId: number, userId: number, clearQueue: boolean) => Promise<CancelResult>;
  onNewSession: (chatId: number, userId: number) => Promise<boolean>;
  onStatus: (chatId: number) => Promise<void>;
  onRetryLast: (chatId: number) => Promise<void>;
  onSetVerbose: (chatId: number, enabled: boolean) => Promise<void>;
  onSetCwd: (chatId: number, target: string | null) => Promise<void>;
  onStaleAction: (
    chatId: number,
    userId: number,
    promptId: string,
    action: "cancel" | "keep",
  ) => Promise<boolean>;
  resolvePermission?: (
    decision: RequestPermissionResponse,
    label: string,
    userDisplay: string,
  ) => Promise<boolean>;
  onUpdate?: () => void;
}

function requireAuthorizedPrivate(
  ctx: Context,
  config: Config,
): { chatId: number; userId: number } | null {
  if (ctx.chat?.type !== "private") return null;
  const userId = ctx.from?.id;
  if (userId == null) return null;
  const access = reloadAccess(config);
  if (!isAllowed(access, userId)) return null;
  return { chatId: ctx.chat.id, userId };
}

export function createTelegramBot(config: Config, deps: TelegramDeps): Bot {
  setTelegramRuntime(config.TELEGRAM_BOT_TOKEN, config);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.use(async (_ctx, next) => {
    beginUpdate();
    try {
      deps.onUpdate?.();
      await next();
    } finally {
      endUpdate();
    }
  });

  const mutationsAllowed = () => !deps.canAcceptPrompts || deps.canAcceptPrompts();
  const rejectUnavailableCommand = async (chatId: number): Promise<void> => {
    await sendMessage(chatId, "Bridge is temporarily unavailable. Try again shortly.");
  };

  bot.command(["start", "help"], async (ctx) => {
    if (ctx.chat.type !== "private") {
      await sendMessage(ctx.chat.id, "This bridge only works in private chats.");
      return;
    }
    const help = [
      "Grok Build Telegram Bridge",
      "",
      "Send text, photos, documents, voice, or video to prompt Grok Build.",
      "Bridge commands:",
      "  /status — health, queue, cwd, usage",
      "  /cancel [queue] — stop active prompt; add queue to clear queue",
      "  /new — fresh ACP session",
      "  /retry last — re-send last response without re-running",
      "  /verbose on|off — thought stream",
      "  /cwd [n|path] — list or switch allowed working directories",
      "",
      "Other messages are forwarded as prompts (including Grok slash-style text).",
      "While busy, follow-ups are queued (see PROMPT_QUEUE_MAX).",
      "Permission cards: once / session / reject (or reply approve/reject).",
      "",
      "Pairing: first message from an unknown user prints a code in the bridge terminal.",
    ].join("\n");
    await sendMessage(ctx.chat.id, help);
  });

  bot.command("status", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    await deps.onStatus(auth.chatId);
  });

  bot.command("cancel", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    if (!mutationsAllowed()) {
      await rejectUnavailableCommand(auth.chatId);
      return;
    }
    const arg = (ctx.match && String(ctx.match).trim().toLowerCase()) || "";
    const clearQueue = arg === "queue" || arg === "all";
    const result = await deps.onCancel(auth.chatId, auth.userId, clearQueue);
    if (!result.cancelled && !result.queueCleared) {
      await sendMessage(auth.chatId, "No active prompt owned by this chat.");
    } else if (!result.cancelled && result.queueCleared) {
      await sendMessage(auth.chatId, `Cleared ${result.queueCleared} queued prompt(s).`);
    }
  });

  bot.command("new", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    if (!mutationsAllowed()) {
      await rejectUnavailableCommand(auth.chatId);
      return;
    }
    const reset = await deps.onNewSession(auth.chatId, auth.userId);
    await sendMessage(
      auth.chatId,
      reset ? "New session started." : "Can't reset a session owned by another chat.",
    );
  });

  bot.command("retry", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    if (!mutationsAllowed()) {
      await rejectUnavailableCommand(auth.chatId);
      return;
    }
    const arg = (ctx.match && String(ctx.match).trim().toLowerCase()) || "";
    if (arg !== "last") {
      await sendMessage(auth.chatId, "Usage: /retry last");
      return;
    }
    await deps.onRetryLast(auth.chatId);
  });

  bot.command("verbose", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    if (!mutationsAllowed()) {
      await rejectUnavailableCommand(auth.chatId);
      return;
    }
    const arg = (ctx.match && String(ctx.match).trim().toLowerCase()) || "";
    if (arg !== "on" && arg !== "off") {
      await sendMessage(auth.chatId, "Usage: /verbose on|off");
      return;
    }
    await deps.onSetVerbose(auth.chatId, arg === "on");
  });

  bot.command("cwd", async (ctx) => {
    const auth = requireAuthorizedPrivate(ctx, config);
    if (!auth) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    if (!mutationsAllowed()) {
      await rejectUnavailableCommand(auth.chatId);
      return;
    }
    const arg = (ctx.match && String(ctx.match).trim()) || "";
    await deps.onSetCwd(auth.chatId, arg || null);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("grok:")) {
      await answerCallbackQuery(ctx.callbackQuery.id);
      return;
    }
    const access = reloadAccess(config);
    const userIdStr = String(ctx.from?.id || "");
    if (!isAllowed(access, userIdStr) || ctx.chat?.type !== "private") {
      await answerCallbackQuery(ctx.callbackQuery.id, "Not authorized", true);
      return;
    }
    if (!mutationsAllowed()) {
      await answerCallbackQuery(ctx.callbackQuery.id, "Bridge temporarily unavailable", true);
      return;
    }

    const parts = data.split(":");
    const action = parts[1];

    // Stale prompt recovery
    if (action === "s") {
      const promptId = parts[2] ?? "";
      const staleAction = parts[3] === "cancel" ? "cancel" : parts[3] === "keep" ? "keep" : null;
      if (!promptId || !staleAction || !ctx.chat || !ctx.from) {
        await answerCallbackQuery(ctx.callbackQuery.id, "Unknown action");
        return;
      }
      const ok = await deps.onStaleAction(ctx.chat.id, ctx.from.id, promptId, staleAction);
      await answerCallbackQuery(
        ctx.callbackQuery.id,
        ok ? (staleAction === "cancel" ? "Cancelling…" : "Keeping…") : "Not applicable",
      );
      return;
    }

    const id = parts[2] ?? "";
    const optionIndex = parts[3];
    const pp = getPendingPermission();
    const active = getActivePrompt();
    const callbackMessage = ctx.callbackQuery.message;
    const expireCallbackCard = async (): Promise<void> => {
      if (!ctx.chat || !callbackMessage) return;
      const existingText = "text" in callbackMessage ? callbackMessage.text : undefined;
      try {
        await editPermissionMessage(
          ctx.chat.id,
          callbackMessage.message_id,
          finalizeExistingPermissionText(existingText, "⌛ Approval expired"),
        );
      } catch (error: unknown) {
        console.warn(`[TG] Failed to expire stale permission card: ${sanitizedError(error)}`);
        try {
          await editMessageReplyMarkup(ctx.chat.id, callbackMessage.message_id, null);
        } catch (fallbackError: unknown) {
          console.warn(`[TG] Failed to clear stale permission buttons: ${sanitizedError(fallbackError)}`);
        }
      }
    };
    if (!pp || pp.id !== id || !active || active.userId !== ctx.from.id || active.chatId !== ctx.chat?.id) {
      await expireCallbackCard();
      await answerCallbackQuery(
        ctx.callbackQuery.id,
        "This approval has expired or belongs to another session.",
      );
      return;
    }

    const options = pp.rawRequest?.options ?? [];
    let selection: { decision: RequestPermissionResponse; label: string } | null = null;
    if (action === "o") {
      const index = Number(optionIndex);
      if (Number.isInteger(index) && index >= 0) selection = permissionSelection(options, index);
    } else if (action === "c") {
      selection = {
        decision: { outcome: { outcome: "cancelled" } },
        label: "❌ Rejected",
      };
    } else if (action === "a") {
      selection = permissionSelectionByKind(options, ["allow_once", "allow_always"]);
    } else if (action === "r") {
      selection = permissionSelectionByKind(options, ["reject_once", "reject_always"])
        ?? { decision: { outcome: { outcome: "cancelled" } }, label: "❌ Rejected" };
    } else {
      await answerCallbackQuery(ctx.callbackQuery.id, "Unknown action");
      return;
    }
    if (!selection) {
      await answerCallbackQuery(ctx.callbackQuery.id, "That option is no longer available.", true);
      return;
    }

    const userDisplay = ctx.from?.first_name || ctx.from?.username || "Telegram";
    const resolved = deps.resolvePermission
      ? await deps.resolvePermission(selection.decision, selection.label, userDisplay)
      : false;
    if (!resolved) {
      await expireCallbackCard();
      await answerCallbackQuery(ctx.callbackQuery.id, "This approval has already been handled.");
      return;
    }
    await answerCallbackQuery(ctx.callbackQuery.id, selection.label);
  });

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!message) return;
    if (ctx.chat.type !== "private") {
      await sendMessage(ctx.chat.id, "This bridge only works in private chats.");
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (userId == null) return;

    // Skip command messages already handled by bot.command (they also hit message)
    if (message.text?.startsWith("/")) {
      const cmd = message.text.split(/\s+/)[0]?.split("@")[0];
      if (cmd && [
        "/start", "/help", "/status", "/cancel", "/new", "/retry", "/verbose", "/cwd",
      ].includes(cmd)) {
        return;
      }
    }

    const text = message.text || message.caption || "";
    const access = reloadAccess(config);
    const allowed = isAllowed(access, userId);

    if (!allowed && access.allowedUsers.length > 0) {
      await sendMessage(chatId, "Pairing is closed. This bridge already has an owner.");
      return;
    }
    if (!allowed) {
      if (deps.canAcceptPrompts && !deps.canAcceptPrompts()) {
        await sendMessage(chatId, "Bridge is temporarily unavailable. Try again shortly.");
        return;
      }
      cleanExpiredPending(config, access);
      const pending = access.pending?.[String(chatId)];
      if (pending) {
        if (completePairing(config, access, chatId, userId, text.trim())) {
          await sendMessage(chatId, "Paired! You can now send prompts to Grok Build.");
          return;
        }
        const remaining = Math.max(0, 5 - (pending.attempts ?? 0));
        await sendMessage(chatId, remaining > 0
          ? `Invalid pairing code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
          : "Pairing cancelled after too many invalid attempts. Send another message to request a new code.");
        return;
      }
      const code = startPairing(config, access, chatId);
      const expiryMinutes = Math.max(1, Math.round(config.PAIRING_EXPIRY_MS / 60_000));
      await sendMessage(
        chatId,
        `Pairing required. Ask the bridge operator for the one-time code, then send it here. It expires in about ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}.`,
      );
      console.log(`[PAIRING] User ${userId} chat ${chatId} code: ${code}`);
      return;
    }

    if (deps.canAcceptPrompts && !deps.canAcceptPrompts()) {
      await sendMessage(chatId, "Bridge is temporarily unavailable. Try again shortly.");
      return;
    }

    // permission text fallback
    const pp = getPendingPermission();
    if (pp && isAllowed(access, userId)) {
      const active = getActivePrompt();
      const norm = text.trim().toLowerCase();
      const allowOnce = /^(approve|yes|y|ok)$/.test(norm);
      const allowAlways = /^(always|always approve|approve always)$/.test(norm);
      const rejectOnce = /^(reject|no|n|deny)$/.test(norm);
      const rejectAlways = /^(always reject|reject always|always deny|deny always)$/.test(norm);
      if (active?.userId === userId && active.chatId === chatId
        && (allowOnce || allowAlways || rejectOnce || rejectAlways)) {
        const options = pp.rawRequest?.options ?? [];
        let selection: { decision: RequestPermissionResponse; label: string } | null;
        if (allowAlways) {
          selection = permissionSelectionByKind(options, ["allow_always"]);
        } else if (allowOnce) {
          selection = permissionSelectionByKind(options, ["allow_once", "allow_always"]);
        } else if (rejectAlways) {
          selection = permissionSelectionByKind(options, ["reject_always"]);
        } else {
          selection = permissionSelectionByKind(options, ["reject_once", "reject_always"])
            ?? { decision: { outcome: { outcome: "cancelled" } }, label: "❌ Rejected" };
        }
        if (!selection) {
          await sendMessage(chatId, "That permission option isn't available for this request.");
          return;
        }
        const resolved = deps.resolvePermission
          ? await deps.resolvePermission(
            selection.decision,
            selection.label,
            ctx.from?.first_name || "Telegram",
          )
          : false;
        if (!resolved) {
          await sendMessage(chatId, "That approval has already been handled or expired.");
          return;
        }
        try {
          if (ctx.message?.message_id) {
            const reaction: ReactionTypeEmoji["emoji"] = selection.label.startsWith("✅") ? "👍" : "👎";
            await setMessageReaction(chatId, ctx.message.message_id, reaction);
          }
        } catch (error: unknown) {
          console.warn(`[TG] Failed to acknowledge permission reply: ${sanitizedError(error)}`);
        }
        return;
      }
    }

    if (getActivePrompt() && messageHasMedia(message)) {
      await sendMessage(
        chatId,
        "Media follow-ups are not queued. Wait for the active prompt or use /cancel first.",
      );
      return;
    }

    // Authorized prompt path — download media first
    const media = await extractMediaFromMessage(config, message, deps.getSessionRoot());
    if (media.errors.length) {
      await sendMessage(chatId, `Could not process attachment: ${media.errors[0]}`);
      cleanupInboxFiles(media.files);
      return;
    }
    if (deps.canAcceptPrompts && !deps.canAcceptPrompts()) {
      cleanupInboxFiles(media.files);
      return;
    }

    const replyContext = replyContextFromMessage(message);
    const promptText = text.trim()
      || (media.files.length ? "User sent media. Please inspect the attached files." : "");

    if (!promptText && media.files.length === 0) {
      await sendMessage(chatId, "Send text or an attachment to prompt Grok Build.");
      return;
    }

    const payload: PromptPayload = {
      text: promptText,
      replyContext,
      inboxFiles: media.files,
    };

    if (getActivePrompt()) {
      if (media.files.length > 0) {
        cleanupInboxFiles(media.files);
        await sendMessage(
          chatId,
          "Media follow-ups are not queued. Wait for the active prompt or use /cancel first.",
        );
        return;
      }
      if (config.PROMPT_QUEUE_MAX <= 0) {
        await sendMessage(chatId, "Grok is still working on the previous prompt. Use /cancel or wait.");
        cleanupInboxFiles(media.files);
        return;
      }
      const queued = enqueuePrompt({
        chatId,
        userId,
        messageId: message.message_id || 0,
        text: payload.text,
        replyContext: payload.replyContext,
        inboxFiles: payload.inboxFiles,
      }, config.PROMPT_QUEUE_MAX);
      if (!queued.ok) {
        await sendMessage(
          chatId,
          `Queue full (${config.PROMPT_QUEUE_MAX}). Use /cancel or wait.`,
        );
        cleanupInboxFiles(media.files);
        return;
      }
      await sendMessage(
        chatId,
        `Queued (${queued.position}/${config.PROMPT_QUEUE_MAX}). Use /cancel queue to clear.`,
      );
      return;
    }

    // Start promptly
    if (message.message_id) {
      void setMessageReaction(chatId, message.message_id, "👀").catch((error: unknown) => {
        console.warn(`[TG] Failed to acknowledge prompt: ${sanitizedError(error)}`);
      });
    }
    setToolsSeenCount(0);
    resetStreamDraftState();
    startTyping([chatId]);
    setBubbleActive(true);
    const activePrompt = startActivePrompt(
      chatId,
      message.message_id || 0,
      userId,
      payload.inboxFiles,
    );

    void deps.onPrompt(chatId, payload, userId).catch(async (error: unknown) => {
      console.error(`[TG] Prompt handler failed: ${sanitizedError(error)}`);
      const ownsPrompt = getActivePrompt()?.id === activePrompt.id;
      if (ownsPrompt) {
        clearActivePrompt();
        stopTyping();
        resetStreamDraftState();
      }
      cleanupInboxFiles(payload.inboxFiles);
      if (!ownsPrompt) return;
      try {
        await sendMessage(
          chatId,
          "Grok Build couldn't complete that request. Check the bridge logs for the correlation details.",
        );
      } catch (deliveryError: unknown) {
        console.error(`[TG] Failed to deliver prompt error: ${sanitizedError(deliveryError)}`);
      }
    });
  });

  return bot;
}

export function healthStatusLines(extra: HealthSnapshotInput): string[] {
  const ap = getActivePrompt();
  const pp = getPendingPermission();
  const typingStartedAt = getTypingStartedAt();
  const typingAgeMs = typingStartedAt == null ? null : Date.now() - typingStartedAt;
  const activityAgeMs = ap ? ageMs(ap.lastActivityAt ?? ap.startedAt) : null;
  const promptStale = activityAgeMs != null
    && activityAgeMs > getRuntimeConfig().PROMPT_STALE_AFTER_MS;
  const likelyState = getLikelyState(!!extra.connected, !!pp, promptStale, !!ap);
  const lines = [
    "",
    "Health:",
    `  Polling: ${extra.lastPollAt ? `last poll ${formatAge(extra.lastPollAt)}` : "not yet"}`,
    `  Last Telegram update: ${extra.lastUpdateAt ? formatAge(extra.lastUpdateAt) : "never"}`,
    `  Last inbound prompt: ${extra.lastInboundPromptAt ? formatAge(extra.lastInboundPromptAt) : "never"}`,
    `  Last ACP event: ${extra.lastAcpEventAt ? formatAge(extra.lastAcpEventAt) : "never"}`,
    `  Last tool event: ${extra.lastToolEventAt ? formatAge(extra.lastToolEventAt) : "never"}`,
    `  Typing active: ${extra.typingActive && typingAgeMs != null ? `yes (${formatAge(typingAgeMs).replace(" ago", "")})` : "no"}`,
    `  Active prompt: ${ap ? `yes (${formatAge(ap.startedAt).replace(" ago", "")})` : "no"}`,
    `  Pending permission: ${pp ? `${pp.kind} waiting ${formatAge(pp.startedAt).replace(" ago", "")}` : "no"}`,
    `  Likely state: ${likelyState}`,
  ];
  return lines;
}

export function resetTelegramRuntimeForTests(): void {
  stopTyping();
  resetStreamDraftState();
  resetBubblesForTests();
  resetApiForTests();
}

export function setTelegramRuntimeForTests(token: string, config: Config): void {
  setTelegramRuntime(token, config);
}
