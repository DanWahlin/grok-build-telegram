import { Bot } from "grammy";
import type {
  InlineKeyboardMarkup,
  ReactionTypeEmoji,
} from "grammy/types";
import type {
  RequestPermissionResponse,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import { CHUNK_MAX } from "./config.js";
import {
  sleep,
  formatAge,
} from "./utils.js";
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
  setTypingStartedAt,
  type HealthSnapshotInput,
} from "./state.js";
import { sanitizedError } from "./redact.js";

export interface TelegramDeps {
  config: Config;
  onPrompt: (chatId: number, text: string, fromUserId: number) => Promise<void>;
  onCancel: (chatId: number, userId: number) => Promise<boolean>;
  onNewSession: (chatId: number, userId: number) => Promise<boolean>;
  onStatus: (chatId: number) => Promise<void>;
  resolvePermission?: (
    decision: RequestPermissionResponse,
    label: string,
    userDisplay: string,
  ) => Promise<boolean>;
  onUpdate?: () => void;
}

let telegramToken: string | null = null;
let runtimeConfig: Config | null = null;
interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
let sendQueue: QueueItem[] = [];
let sendQueueRunning = false;
let typingInterval: NodeJS.Timeout | null = null;
let typingDebounceTimer: NodeJS.Timeout | null = null;
let typingMaxTimer: NodeJS.Timeout | null = null;
const streamDrafts = new Map<number, { messageId: number | null; text: string; lastSentText: string; lastEditAt: number; timer: NodeJS.Timeout | null; flushing: boolean }>();
let currentAssistantText = "";
let bubbleActive = false;
const bubbleMessageIds = new Map<number, number>();
const allBubbleIds = new Map<number, Set<number>>();
let bubbleDebounceTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;
let reflushNeeded = false;
let lastCompletedToolDesc: string | null = null;
const activeTools = new Map<string, { name: string; description: string }>();

const BUBBLE_DEBOUNCE_MS = 300;

interface TelegramMessageResult {
  message_id: number;
}

type SendMessageExtra = {
  reply_markup?: InlineKeyboardMarkup;
};

interface TelegramApiEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  const holds: string[] = [];
  function hold(html: string) {
    const i = holds.length;
    holds.push(html);
    return `\x00${i}\x00`;
  }
  let t = md;

  // fenced code
  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    code = code.replace(/\n$/, "");
    const cls = lang ? ` class="language-${lang}"` : "";
    return hold(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
  });
  // inline code
  t = t.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  const renderLink = (text: string, url: string, image: boolean): string => {
    const label = image ? `[${text || "image"}]` : text;
    if (!isSafeLink(url)) return hold(`${escapeHtml(label)} (${escapeHtml(url)})`);
    return hold(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
  };
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) =>
    renderLink(alt, url, true));
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
    renderLink(text, url, false));

  t = escapeHtml(t);

  t = t.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  t = t.replace(/~~(.+?)~~/g, "<s>$1</s>");
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(/(?:^&gt;[ ]?.*$\n?)+/gm, (block) => {
    const lines = block.trimEnd().split("\n").map((l) => l.replace(/^&gt;[ ]?/, ""));
    return `<blockquote>${lines.join("\n")}</blockquote>\n`;
  });
  t = t.replace(/^-{3,}$/gm, "\u2500".repeat(20));
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => holds[parseInt(i)] || "");
  return t;
}

function isSafeLink(url: string): boolean {
  try {
    return ["http:", "https:", "tg:", "mailto:"].includes(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function chunkMessage(text: string, maxLen = CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function getTelegramToken(): string {
  if (!telegramToken) throw new Error("Telegram bot is not initialized");
  return telegramToken;
}

function getRuntimeConfig(): Config {
  if (!runtimeConfig) throw new Error("Telegram runtime is not configured");
  return runtimeConfig;
}

function parseApiEnvelope(value: unknown): TelegramApiEnvelope {
  if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") {
    throw new Error("Telegram API returned an invalid response");
  }
  const envelope: TelegramApiEnvelope = { ok: value.ok };
  if ("result" in value) envelope.result = value.result;
  if ("description" in value && typeof value.description === "string") {
    envelope.description = value.description;
  }
  if ("parameters" in value && value.parameters && typeof value.parameters === "object") {
    const retryAfter = "retry_after" in value.parameters
      && typeof value.parameters.retry_after === "number"
      ? value.parameters.retry_after
      : undefined;
    if (retryAfter !== undefined) envelope.parameters = { retry_after: retryAfter };
  }
  return envelope;
}

function requireMessageResult(value: unknown): TelegramMessageResult {
  if (!value || typeof value !== "object" || !("message_id" in value)
    || typeof value.message_id !== "number") {
    throw new Error("Telegram API returned an invalid message");
  }
  return { message_id: value.message_id };
}

async function callApi(
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const timeoutMs = getRuntimeConfig().API_TIMEOUT_MS;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 409) {
    throw new TelegramApiError("Conflict: another process is polling this bot", 409);
  }
  if (res.status === 429) {
    let retryAfter = 5;
    try {
      const body = parseApiEnvelope(await res.json());
      retryAfter = body.parameters?.retry_after ?? retryAfter;
    } catch (error: unknown) {
      console.warn(`[TG] Unable to parse rate-limit response: ${sanitizedError(error)}`);
    }
    throw new TelegramApiError("Rate limited", 429, retryAfter);
  }
  if (!res.ok) {
    let description = "";
    try {
      description = sanitizedError(await res.text(), 300);
    } catch (error: unknown) {
      console.warn(`[TG] Unable to read API error response: ${sanitizedError(error)}`);
    }
    throw new TelegramApiError(
      `Telegram API ${method} failed: ${res.status}${description ? ` ${description}` : ""}`,
      res.status,
    );
  }
  const json = parseApiEnvelope(await res.json());
  if (!json.ok) {
    throw new TelegramApiError(
      `Telegram API ${method} returned ok=false: ${sanitizedError(json.description ?? "unknown")}`,
      res.status === 200 ? 0 : res.status,
    );
  }
  return json.result;
}

function enqueue(fn: () => Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    sendQueue.push({ fn, resolve, reject });
    if (!sendQueueRunning) drainQueue();
  });
}
async function drainQueue(): Promise<void> {
  sendQueueRunning = true;
  while (sendQueue.length > 0) {
    const item = sendQueue.shift();
    if (!item) continue;
    try {
      const r = await item.fn();
      item.resolve(r);
    } catch (err: unknown) {
      if (err instanceof TelegramApiError && err.status === 429) {
        sendQueue.unshift(item);
        await sleep((err.retryAfter ?? 5) * 1000);
        continue;
      }
      item.reject(err);
    }
    if (sendQueue.length > 0) await sleep(getRuntimeConfig().SEND_PACE_MS);
  }
  sendQueueRunning = false;
}

export async function sendMessage(
  chatId: number,
  text: string,
  extra: SendMessageExtra = {},
): Promise<TelegramMessageResult> {
  const result = await enqueue(() =>
    callApi("sendMessage", { chat_id: chatId, text, ...extra }, getTelegramToken()));
  return requireMessageResult(result);
}

export async function sendFormattedMessage(
  chatId: number,
  markdown: string,
): Promise<TelegramMessageResult> {
  const html = markdownToTelegramHtml(markdown);
  try {
    const result = await enqueue(() =>
      callApi("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" }, getTelegramToken()));
    return requireMessageResult(result);
  } catch (err: unknown) {
    if (err instanceof Error && /can.t parse|entit/i.test(err.message)) {
      const result = await enqueue(() =>
        callApi("sendMessage", { chat_id: chatId, text: markdown }, getTelegramToken()));
      return requireMessageResult(result);
    }
    throw err;
  }
}

export async function editFormattedMessage(
  chatId: number,
  messageId: number,
  markdown: string,
): Promise<void> {
  const html = markdownToTelegramHtml(markdown);
  try {
    await enqueue(() =>
      callApi(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML" },
        getTelegramToken()
      )
    );
  } catch (err: unknown) {
    if (err instanceof Error && /can.t parse|entit/i.test(err.message)) {
      await enqueue(() =>
        callApi(
          "editMessageText",
          { chat_id: chatId, message_id: messageId, text: markdown },
          getTelegramToken()
        )
      );
      return;
    }
    throw err;
  }
}

export async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup | null = null,
): Promise<void> {
  await enqueue(() => callApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  }, getTelegramToken()));
}

export async function answerCallbackQuery(
  id: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  await enqueue(() =>
    callApi(
      "answerCallbackQuery",
      { callback_query_id: id, text: text || "", show_alert: showAlert },
      getTelegramToken()
    )
  );
}

export async function setMessageReaction(
  chatId: number,
  messageId: number,
  emoji: ReactionTypeEmoji["emoji"],
): Promise<void> {
  await enqueue(() =>
    callApi(
      "setMessageReaction",
      { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] },
      getTelegramToken()
    )
  );
}

export async function sendChatAction(chatId: number, action = "typing"): Promise<void> {
  await enqueue(() =>
    callApi("sendChatAction", { chat_id: chatId, action }, getTelegramToken())
  );
}

export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  await enqueue(() =>
    callApi("deleteMessage", { chat_id: chatId, message_id: messageId }, getTelegramToken()));
}

export function startTyping(chatIds: number[]): void {
  stopTyping();
  const config = getRuntimeConfig();
  setTypingStartedAt(Date.now());
  const doType = () => {
    for (const id of chatIds) {
      void sendChatAction(id).catch((error: unknown) => {
        console.warn(`[TG] Typing action failed for chat ${id}: ${sanitizedError(error)}`);
      });
    }
    if (bubbleActive) resetTypingDebounce();
  };
  doType();
  typingInterval = setInterval(doType, config.TYPING_INTERVAL_MS);
  typingInterval.unref();
  typingMaxTimer = setTimeout(stopTyping, config.MAX_TYPING_SESSION_MS);
  typingMaxTimer.unref();
  resetTypingDebounce();
}

export function resetTypingDebounce(): void {
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(stopTyping, getRuntimeConfig().TYPING_DEBOUNCE_MS);
  typingDebounceTimer.unref();
}

export function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
  if (typingDebounceTimer) {
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;
  }
  if (typingMaxTimer) {
    clearTimeout(typingMaxTimer);
    typingMaxTimer = null;
  }
  setTypingStartedAt(null);
}

export function resetStreamDraftState() {
  currentAssistantText = "";
  for (const d of streamDrafts.values()) {
    if (d.timer) clearTimeout(d.timer);
  }
  streamDrafts.clear();
}

function trimDraftText(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max + 80).replace(/^\S*\s*/, "");
  return `…\n${tail}`;
}

function scheduleStreamDraftFlush(chatIds: number[], force = false, config: Config): void {
  const text = trimDraftText(currentAssistantText, config.STREAM_DRAFT_MAX);
  if (!text) return;
  for (const chatId of chatIds) {
    let draft = streamDrafts.get(chatId);
    if (!draft) {
      draft = { messageId: null, text: "", lastSentText: "", lastEditAt: 0, timer: null, flushing: false };
      streamDrafts.set(chatId, draft);
    }
    draft.text = text;
    if (!force && draft.lastSentText
      && Math.abs(text.length - draft.lastSentText.length) < config.STREAM_MIN_DELTA_CHARS) {
      continue;
    }
    if (draft.timer) continue;
    const elapsed = Date.now() - draft.lastEditAt;
    const delay = force ? 0 : Math.max(0, config.STREAM_EDIT_INTERVAL_MS - elapsed);
    draft.timer = setTimeout(() => {
      void flushStreamDraft(chatId, force, config).catch((error: unknown) => {
        console.error(`[TG] Stream draft flush failed for chat ${chatId}: ${sanitizedError(error)}`);
      });
    }, delay);
  }
}

async function flushStreamDraft(chatId: number, force: boolean, config: Config): Promise<void> {
  const draft = streamDrafts.get(chatId);
  if (!draft) return;
  draft.timer = null;
  if (draft.flushing) {
    if (force) {
      while (draft.flushing) await sleep(10);
      return flushStreamDraft(chatId, true, config);
    }
    draft.timer = setTimeout(() => {
      void flushStreamDraft(chatId, false, config).catch((error: unknown) => {
        console.error(`[TG] Deferred stream flush failed for chat ${chatId}: ${sanitizedError(error)}`);
      });
    }, config.STREAM_EDIT_INTERVAL_MS);
    return;
  }
  if (!force && draft.lastSentText && draft.text === draft.lastSentText) return;

  draft.flushing = true;
  try {
    const text = draft.text;
    if (draft.messageId) {
      try {
        await editFormattedMessage(chatId, draft.messageId, text);
      } catch (err: unknown) {
        if (err instanceof Error && /message is not modified/i.test(err.message)) {
          // ok
        } else if (err instanceof Error && /message to edit not found/i.test(err.message)) {
          const sent = await sendFormattedMessage(chatId, text);
          draft.messageId = sent.message_id;
        } else {
          throw err;
        }
      }
    } else {
      const sent = await sendFormattedMessage(chatId, text);
      draft.messageId = sent.message_id;
    }
    draft.lastSentText = text;
    draft.lastEditAt = Date.now();
  } finally {
    draft.flushing = false;
    if (draft.text !== draft.lastSentText && streamDrafts.get(chatId) === draft) {
      draft.timer = setTimeout(() => {
        void flushStreamDraft(chatId, false, config).catch((error: unknown) => {
          console.error(`[TG] Follow-up stream flush failed for chat ${chatId}: ${sanitizedError(error)}`);
        });
      }, config.STREAM_EDIT_INTERVAL_MS);
    }
  }
}

export async function finalizeStreamDrafts(
  finalContent: string,
  chatIds: number[],
  config: Config,
): Promise<void> {
  const chunks = chunkMessage(finalContent);
  const finalFirst = chunks[0] ?? finalContent;
  currentAssistantText = finalFirst;
  for (const chatId of chatIds) {
    const draft = streamDrafts.get(chatId) ?? {
      messageId: null,
      text: "",
      lastSentText: "",
      lastEditAt: 0,
      timer: null,
      flushing: false,
    };
    draft.text = finalFirst;
    streamDrafts.set(chatId, draft);
  }
  try {
    await Promise.all(chatIds.map(async (chatId) => {
      const draft = streamDrafts.get(chatId);
      if (!draft) throw new Error(`Missing stream draft for chat ${chatId}`);
      if (draft.timer) {
        clearTimeout(draft.timer);
        draft.timer = null;
      }
      await flushStreamDraft(chatId, true, config);
      for (const chunk of chunks.slice(1)) {
        await sendFormattedMessage(chatId, chunk);
      }
    }));
  } catch (error: unknown) {
    console.error(`[TG] Final response delivery failed: ${sanitizedError(error)}`);
    throw error;
  } finally {
    resetStreamDraftState();
  }
}

function getStringProperty(value: unknown, property: string): string | null {
  if (!isUnknownRecord(value)) return null;
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function describeTool(title: string | null | undefined, rawInput: unknown): string | null {
  if (!title) return null;
  if (typeof rawInput === "string") return (rawInput.split("\n")[0] ?? "").slice(0, 120);
  const command = getStringProperty(rawInput, "command");
  if (command) return (command.split("\n")[0] ?? "").slice(0, 120);
  const path = getStringProperty(rawInput, "path");
  if (path) return `${title} ${path}`;
  return title;
}

function scheduleBubbleUpdate(): void {
  if (!bubbleActive) return;
  if (bubbleDebounceTimer) clearTimeout(bubbleDebounceTimer);
  bubbleDebounceTimer = setTimeout(() => {
    void flushBubble().catch((error: unknown) => {
      console.error(`[TG] Tool progress bubble failed: ${sanitizedError(error)}`);
    });
  }, BUBBLE_DEBOUNCE_MS);
}

function rememberBubbleMessage(chatId: number, messageId: number): void {
  bubbleMessageIds.set(chatId, messageId);
  const ids = allBubbleIds.get(chatId) ?? new Set<number>();
  ids.add(messageId);
  allBubbleIds.set(chatId, ids);
}

function getAuthorizedActiveChat(): number | null {
  const active = getActivePrompt();
  const config = runtimeConfig;
  if (!active || !config) return null;
  const access = reloadAccess(config);
  return isAllowed(access, active.userId) ? active.chatId : null;
}

async function flushBubble(): Promise<void> {
  bubbleDebounceTimer = null;
  if (!bubbleActive) return;
  if (flushInProgress) {
    reflushNeeded = true;
    return;
  }
  flushInProgress = true;
  try {
    const chatId = getAuthorizedActiveChat();
    if (chatId == null) return;
    const lines = [...activeTools.values()]
      .map((info) => info.description)
      .filter((description) => description.length > 0)
      .map((description) => `● ${description}`);
    const text = lines.length > 0
      ? lines.join("\n")
      : lastCompletedToolDesc
        ? `● ${lastCompletedToolDesc}`
        : null;
    if (!text || !bubbleActive) return;

    const currentMessageId = bubbleMessageIds.get(chatId);
    if (currentMessageId) {
      try {
        await editFormattedMessage(chatId, currentMessageId, text);
        return;
      } catch (error: unknown) {
        if (!(error instanceof Error && /message to edit not found/i.test(error.message))) {
          throw error;
        }
        bubbleMessageIds.delete(chatId);
      }
    }
    const sent = await sendFormattedMessage(chatId, text);
    rememberBubbleMessage(chatId, sent.message_id);
  } finally {
    flushInProgress = false;
    if (reflushNeeded) {
      reflushNeeded = false;
      scheduleBubbleUpdate();
    }
  }
}

export async function dismissBubble(): Promise<void> {
  bubbleActive = false;
  if (bubbleDebounceTimer) {
    clearTimeout(bubbleDebounceTimer);
    bubbleDebounceTimer = null;
  }
  activeTools.clear();
  lastCompletedToolDesc = null;
  while (flushInProgress) await sleep(10);
  for (const [chatId, ids] of allBubbleIds) {
    for (const mid of ids) {
      try {
        await deleteMessage(chatId, mid);
      } catch (error: unknown) {
        console.warn(`[TG] Failed to delete tool bubble ${mid} in chat ${chatId}: ${sanitizedError(error)}`);
      }
    }
    ids.clear();
  }
  allBubbleIds.clear();
  bubbleMessageIds.clear();
}

export function trackToolCall(
  toolCallId: string,
  title: string | null,
  rawInput: unknown,
): void {
  if (getAuthorizedActiveChat() == null) return;
  const desc = describeTool(title, rawInput);
  if (desc) {
    activeTools.set(toolCallId, { name: title || "tool", description: desc });
    bubbleActive = true;
    scheduleBubbleUpdate();
  }
}

export function updateToolCall(toolCallId: string, status?: ToolCallStatus | null): void {
  const t = activeTools.get(toolCallId);
  if (t && (status === "completed" || status === "failed")) {
    lastCompletedToolDesc = t.description;
    activeTools.delete(toolCallId);
    scheduleBubbleUpdate();
  }
}

export function createTelegramBot(config: Config, deps: TelegramDeps): Bot {
  telegramToken = config.TELEGRAM_BOT_TOKEN;
  runtimeConfig = config;
  const bot = new Bot(telegramToken);
  bot.use(async (_ctx, next) => {
    deps.onUpdate?.();
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    if (ctx.chat.type !== "private") {
      await sendMessage(ctx.chat.id, "This bridge only works in private chats.");
      return;
    }
    const help = [
      "Grok Build Telegram Bridge",
      "",
      "Send any message to prompt Grok Build.",
      "While working, send /cancel to stop, /status for health, /new for fresh session.",
      "",
      "Pairing: first message from unknown user generates a code shown in the terminal.",
    ].join("\n");
    await sendMessage(ctx.chat.id, help);
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    await deps.onStatus(ctx.chat.id);
  });

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    const cancelled = await deps.onCancel(ctx.chat.id, userId);
    await sendMessage(
      ctx.chat.id,
      cancelled ? "Cancel requested." : "No active prompt owned by this chat.",
    );
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await sendMessage(ctx.chat.id, "Not authorized.");
      return;
    }
    const reset = await deps.onNewSession(ctx.chat.id, userId);
    await sendMessage(
      ctx.chat.id,
      reset ? "New session started." : "Can't reset a session owned by another chat.",
    );
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
    const [, action, id] = data.split(":", 3);
    const pp = getPendingPermission();
    const active = getActivePrompt();
    if (!pp || pp.id !== id || !active || active.userId !== ctx.from.id || active.chatId !== ctx.chat?.id) {
      await answerCallbackQuery(
        ctx.callbackQuery.id,
        "This approval has expired or belongs to another session.",
      );
      return;
    }
    let decision: RequestPermissionResponse;
    let label = "";
    if (action === "a") {
      label = "✅ Approved";
      const opts = pp.rawRequest?.options ?? [];
      const chosen = opts.find((option) => option.kind === "allow_once")
        ?? opts.find((option) => option.kind === "allow_always");
      decision = chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else if (action === "r") {
      label = "❌ Rejected";
      decision = { outcome: { outcome: "cancelled" } };
    } else {
      await answerCallbackQuery(ctx.callbackQuery.id, "Unknown action");
      return;
    }
    await answerCallbackQuery(ctx.callbackQuery.id, label);
    const userDisplay = ctx.from?.first_name || ctx.from?.username || "Telegram";
    if (deps.resolvePermission) {
      await deps.resolvePermission(decision, label, userDisplay);
    }
    const callbackMessage = ctx.callbackQuery.message;
    if (ctx.chat && callbackMessage) {
      try {
        await editMessageReplyMarkup(ctx.chat.id, callbackMessage.message_id, null);
      } catch (error: unknown) {
        console.warn(`[TG] Failed to clear permission buttons: ${sanitizedError(error)}`);
      }
    }
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

    const text = message.text || message.caption || "";
    const access = reloadAccess(config);

    // permission text fallback
    const pp = getPendingPermission();
    if (pp && isAllowed(access, userId)) {
      const active = getActivePrompt();
      const norm = text.trim().toLowerCase();
      if (active?.userId === userId && active.chatId === chatId && (/^(approve|yes|y|ok)$/.test(norm) || /^(reject|no|n|deny)$/.test(norm))) {
        const approve = /^(approve|yes|y|ok)$/.test(norm);
        const label = approve ? "✅ Approved" : "❌ Rejected";
        const opts = pp.rawRequest?.options ?? [];
        const chosen = opts.find((option) => option.kind === "allow_once")
          ?? opts.find((option) => option.kind === "allow_always");
        const decision: RequestPermissionResponse = approve && chosen
          ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
          : { outcome: { outcome: "cancelled" } };
        if (deps.resolvePermission) await deps.resolvePermission(decision, label, ctx.from?.first_name || "Telegram");
        try {
          if (ctx.message?.message_id) await setMessageReaction(chatId, ctx.message.message_id, "👀");
        } catch (error: unknown) {
          console.warn(`[TG] Failed to acknowledge permission reply: ${sanitizedError(error)}`);
        }
        return;
      }
    }

    if (!isAllowed(access, userId) && access.allowedUsers.length > 0) {
      await sendMessage(chatId, "Pairing is closed. This bridge already has an owner.");
      return;
    }
    if (!isAllowed(access, userId)) {
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

    if (getActivePrompt()) {
      await sendMessage(chatId, "Grok is still working on the previous prompt. Use /cancel or wait.");
      return;
    }

    // ack + start
    if (message.message_id) {
      void setMessageReaction(chatId, message.message_id, "👀").catch((error: unknown) => {
        console.warn(`[TG] Failed to acknowledge prompt: ${sanitizedError(error)}`);
      });
    }
    const allChats = [chatId];
    resetStreamDraftState();
    startTyping(allChats);
    bubbleActive = true;
    startActivePrompt(chatId, message.message_id || 0, userId);

    const promptText = text || "User sent a non-text message.";
    void deps.onPrompt(chatId, promptText, userId).catch(async (error: unknown) => {
      console.error(`[TG] Prompt handler failed: ${sanitizedError(error)}`);
      clearActivePrompt();
      stopTyping();
      resetStreamDraftState();
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

export async function stopPolling(bot: Bot): Promise<void> {
  try {
    await bot.stop();
  } catch (error: unknown) {
    console.warn(`[TG] Failed to stop polling cleanly: ${sanitizedError(error)}`);
  }
}

// health status lines for /status
export function healthStatusLines(extra: HealthSnapshotInput): string[] {
  const ap = getActivePrompt();
  const pp = getPendingPermission();
  const typingStartedAt = getTypingStartedAt();
  const typingAgeMs = typingStartedAt == null ? null : Date.now() - typingStartedAt;
  const likelyState = !extra.connected
    ? "disconnected"
    : pp
      ? "waiting-permission"
      : ap
        ? "working"
        : "idle";
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
    `  ACP session: ${extra.acpSessionId || "none"}`,
    `  Likely state: ${likelyState}`,
  ];
  return lines;
}

export function getCurrentAssistantText() {
  return currentAssistantText;
}
export function appendAssistantDelta(delta: string) {
  currentAssistantText += delta;
}
export function scheduleAssistantDeltaFlush(chatIds: number[], config: Config) {
  scheduleStreamDraftFlush(chatIds, false, config);
}

export function getStreamDrafts() {
  return streamDrafts;
}

export function resetTelegramRuntimeForTests() {
  stopTyping();
  resetStreamDraftState();
  sendQueue = [];
  sendQueueRunning = false;
  telegramToken = null;
  runtimeConfig = null;
  bubbleActive = false;
  bubbleMessageIds.clear();
  allBubbleIds.clear();
  activeTools.clear();
  lastCompletedToolDesc = null;
}

export function setTelegramRuntimeForTests(token: string, config: Config): void {
  telegramToken = token;
  runtimeConfig = config;
}
