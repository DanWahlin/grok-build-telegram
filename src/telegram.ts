import { Bot } from "grammy";
import { Config, CHUNK_MAX } from "./config.js";
import {
  nowIso,
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
  setTypingStartedAt,
} from "./state.js";

export interface TelegramDeps {
  config: Config;
  onPrompt: (chatId: number, text: string, fromUserId: number) => Promise<void>;
  onCancel: (chatId: number, userId: number) => Promise<boolean>;
  onNewSession: (chatId: number, userId: number) => Promise<boolean>;
  onStatus: (chatId: number) => Promise<void>;
  resolvePermission?: (decision: any, label: string, userDisplay: string) => Promise<boolean>;
  getBotUsername: () => string | null;
  getAcpSessionId: () => string | null;
  getConnected: () => boolean;
  getLastPollAt: () => string | null;
  getLastUpdateAt: () => string | null;
  getLastInboundAt: () => string | null;
  getLastAcpAt: () => string | null;
  getLastToolAt: () => string | null;
  onUpdate?: () => void;
}

let bot: Bot | null = null;
let sendQueue: Array<{ fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];
let sendQueueRunning = false;
let typingInterval: NodeJS.Timeout | null = null;
let typingDebounceTimer: NodeJS.Timeout | null = null;
let streamDrafts = new Map<number, { messageId: number | null; text: string; lastSentText: string; lastEditAt: number; timer: NodeJS.Timeout | null; flushing: boolean }>();
let currentAssistantText = "";
let bubbleActive = false;
let bubbleMessageIds = new Map<number, number>();
let allBubbleIds = new Map<number, Set<number>>();
let bubbleDebounceTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;
let reflushNeeded = false;
let lastCompletedToolDesc: string | null = null;
const activeTools = new Map<string, { name: string; description: string }>();

const BUBBLE_DEBOUNCE_MS = 300;

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
  // images/links
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => hold(`<a href="${escapeHtml(url)}">[${escapeHtml(alt || "image")}]</a>`));
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => hold(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`));

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

async function callApiWithRetry(method: string, params: any, token: string): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const timeoutMs = method === "getUpdates" ? 40000 : 30000;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 409) {
    const err: any = new Error("Conflict: another process is polling this bot");
    err.status = 409;
    throw err;
  }
  if (res.status === 429) {
    const body: any = await res.json().catch(() => ({}));
    const err: any = new Error("Rate limited");
    err.status = 429;
    err.retryAfter = (body && body.parameters && body.parameters.retry_after) || 5;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`Telegram API ${method} failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  const json: any = await res.json();
  if (!json || !json.ok) throw new Error(`Telegram API ${method} returned ok=false`);
  return json.result;
}

function enqueue(fn: () => Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => {
    sendQueue.push({ fn, resolve, reject });
    if (!sendQueueRunning) drainQueue();
  });
}
async function drainQueue() {
  sendQueueRunning = true;
  const pace = 50;
  while (sendQueue.length > 0) {
    const item = sendQueue.shift()!;
    try {
      const r = await item.fn();
      item.resolve(r);
    } catch (err: any) {
      if (err.status === 429) {
        sendQueue.unshift(item);
        await sleep((err.retryAfter || 5) * 1000);
        continue;
      }
      item.reject(err);
    }
    if (sendQueue.length > 0) await sleep(pace);
  }
  sendQueueRunning = false;
}

export async function sendMessage(chatId: number, text: string, extra: any = {}) {
  return enqueue(() => callApiWithRetry("sendMessage", { chat_id: chatId, text, ...extra }, (bot as any)._token));
}

export async function sendFormattedMessage(chatId: number, markdown: string) {
  const html = markdownToTelegramHtml(markdown);
  try {
    return await enqueue(() =>
      callApiWithRetry("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" }, (bot as any)._token)
    );
  } catch (err: any) {
    if (/can.t parse|entit/i.test(err.message || "")) {
      return await enqueue(() =>
        callApiWithRetry("sendMessage", { chat_id: chatId, text: markdown }, (bot as any)._token)
      );
    }
    throw err;
  }
}

export async function editFormattedMessage(chatId: number, messageId: number, markdown: string) {
  const html = markdownToTelegramHtml(markdown);
  try {
    return await enqueue(() =>
      callApiWithRetry(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML" },
        (bot as any)._token
      )
    );
  } catch (err: any) {
    if (/can.t parse|entit/i.test(err.message || "")) {
      return await enqueue(() =>
        callApiWithRetry(
          "editMessageText",
          { chat_id: chatId, message_id: messageId, text: markdown },
          (bot as any)._token
        )
      );
    }
    throw err;
  }
}

export async function editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: any = null) {
  const params: any = { chat_id: chatId, message_id: messageId };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return enqueue(() => callApiWithRetry("editMessageReplyMarkup", params, (bot as any)._token));
}

export async function answerCallbackQuery(id: string, text?: string, showAlert = false) {
  return enqueue(() =>
    callApiWithRetry(
      "answerCallbackQuery",
      { callback_query_id: id, text: text || "", show_alert: showAlert },
      (bot as any)._token
    )
  );
}

export async function setMessageReaction(chatId: number, messageId: number, emoji: string) {
  return enqueue(() =>
    callApiWithRetry(
      "setMessageReaction",
      { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] },
      (bot as any)._token
    )
  );
}

export async function sendChatAction(chatId: number, action = "typing") {
  return enqueue(() =>
    callApiWithRetry("sendChatAction", { chat_id: chatId, action }, (bot as any)._token)
  );
}

export function deleteMessage(chatId: number, messageId: number) {
  return enqueue(() =>
    callApiWithRetry("deleteMessage", { chat_id: chatId, message_id: messageId }, (bot as any)._token)
  ).catch(() => {});
}

export function startTyping(chatIds: number[]) {
  stopTyping();
  setTypingStartedAt(Date.now());
  const doType = () => {
    for (const id of chatIds) {
      sendChatAction(id).catch(() => {});
    }
    if (bubbleActive) resetTypingDebounce();
  };
  doType();
  typingInterval = setInterval(doType, 4000);
  resetTypingDebounce();
}

export function resetTypingDebounce() {
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(stopTyping, 60000);
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

function scheduleStreamDraftFlush(chatIds: number[], force = false, config?: Config) {
  const text = trimDraftText(currentAssistantText, config?.STREAM_DRAFT_MAX || 3800);
  if (!text) return;
  for (const chatId of chatIds) {
    let draft = streamDrafts.get(chatId);
    if (!draft) {
      draft = { messageId: null, text: "", lastSentText: "", lastEditAt: 0, timer: null, flushing: false };
      streamDrafts.set(chatId, draft);
    }
    draft.text = text;
    if (!force && draft.lastSentText && Math.abs(text.length - draft.lastSentText.length) < (config?.STREAM_MIN_DELTA_CHARS || 24)) continue;
    if (draft.timer) continue;
    const elapsed = Date.now() - draft.lastEditAt;
    const delay = force ? 0 : Math.max(0, (config?.STREAM_EDIT_INTERVAL_MS || 1500) - elapsed);
    draft.timer = setTimeout(() => flushStreamDraft(chatId, force, config), delay);
  }
}

async function flushStreamDraft(chatId: number, force = false, config?: Config) {
  const draft = streamDrafts.get(chatId);
  if (!draft) return;
  draft.timer = null;
  if (draft.flushing) {
    if (force) {
      while (draft.flushing) await sleep(10);
      return flushStreamDraft(chatId, true, config);
    }
    draft.timer = setTimeout(() => flushStreamDraft(chatId, false, config), config?.STREAM_EDIT_INTERVAL_MS || 1500);
    return;
  }
  if (!force && draft.lastSentText && draft.text === draft.lastSentText) return;

  draft.flushing = true;
  try {
    const text = draft.text;
    if (draft.messageId) {
      try {
        await editFormattedMessage(chatId, draft.messageId!, text);
      } catch (err: any) {
        if (/message is not modified/i.test(err.message || "")) {
          // ok
        } else if (/message to edit not found/i.test(err.message || "")) {
          const sent: any = await sendFormattedMessage(chatId, text);
          draft.messageId = sent.message_id;
        } else {
          throw err;
        }
      }
    } else {
      const sent: any = await sendFormattedMessage(chatId, text);
      draft.messageId = sent.message_id;
    }
    draft.lastSentText = text;
    draft.lastEditAt = Date.now();
  } finally {
    draft.flushing = false;
    if (draft.text !== draft.lastSentText && streamDrafts.get(chatId) === draft) {
      draft.timer = setTimeout(() => flushStreamDraft(chatId, false, config), config?.STREAM_EDIT_INTERVAL_MS || 1500);
    }
  }
}

export async function finalizeStreamDrafts(finalContent: string, chatIds: number[], config: Config) {
  const finalFirst = chunkMessage(finalContent)[0] || finalContent;
  currentAssistantText = finalFirst;
  scheduleStreamDraftFlush(chatIds, true, config);
  const pending: Promise<any>[] = [];
  for (const chatId of chatIds) {
    const draft = streamDrafts.get(chatId);
    if (!draft) continue;
    if (draft.timer) {
      clearTimeout(draft.timer);
      draft.timer = null;
    }
    pending.push(flushStreamDraft(chatId, true, config).catch(() => {}));
  }
  await Promise.all(pending);
  resetStreamDraftState();
}

function describeTool(title: string | null | undefined, rawInput: any): string | null {
  if (!title) return null;
  try {
    const inp = rawInput || {};
    if (typeof inp === "string") return (inp.split("\n")[0] ?? "").slice(0, 120);
    if (inp.command) return (String(inp.command).split("\n")[0] ?? "").slice(0, 120);
    if (inp.path) return `${title} ${inp.path}`;
    return title;
  } catch {
    return title || null;
  }
}

function scheduleBubbleUpdate() {
  if (!bubbleActive) return;
  if (bubbleDebounceTimer) clearTimeout(bubbleDebounceTimer);
  bubbleDebounceTimer = setTimeout(flushBubble, BUBBLE_DEBOUNCE_MS);
}

async function flushBubble() {
  bubbleDebounceTimer = null;
  if (!bubbleActive) return;
  if (flushInProgress) {
    reflushNeeded = true;
    return;
  }
  flushInProgress = true;
  try {
    const lines: string[] = [];
    for (const [, info] of activeTools) {
      if (info.description) lines.push(`● ${info.description}`);
    }
    const text = lines.length > 0 ? lines.join("\n") : lastCompletedToolDesc ? `● ${lastCompletedToolDesc}` : null;
    if (!text) return;
    // simplistic: use one allowed chat for bubble (we broadcast to allowed later)
    // For simplicity in this impl we track per chat but send to active chats via caller context
  } finally {
    flushInProgress = false;
    if (reflushNeeded) {
      reflushNeeded = false;
      scheduleBubbleUpdate();
    }
  }
}

export async function dismissBubble() {
  bubbleActive = false;
  if (bubbleDebounceTimer) {
    clearTimeout(bubbleDebounceTimer);
    bubbleDebounceTimer = null;
  }
  activeTools.clear();
  lastCompletedToolDesc = null;
  // best effort delete tracked
  for (const [chatId, ids] of allBubbleIds) {
    for (const mid of ids) {
      await deleteMessage(chatId, mid);
    }
    ids.clear();
  }
  allBubbleIds.clear();
  bubbleMessageIds.clear();
}

export function trackToolCall(toolCallId: string, title: string | null, rawInput: any) {
  const desc = describeTool(title, rawInput);
  if (desc) {
    activeTools.set(toolCallId, { name: title || "tool", description: desc });
    bubbleActive = true;
    scheduleBubbleUpdate();
  }
}

export function updateToolCall(toolCallId: string, status?: string) {
  const t = activeTools.get(toolCallId);
  if (t && status === "completed") {
    lastCompletedToolDesc = t.description;
    activeTools.delete(toolCallId);
    scheduleBubbleUpdate();
  }
}

export function createTelegramBot(config: Config, deps: TelegramDeps): Bot {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.use(async (_ctx, next) => {
    deps.onUpdate?.();
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("This bridge only works in private chats.");
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
    await ctx.reply(help);
  });

  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await ctx.reply("Not authorized.");
      return;
    }
    await deps.onStatus(ctx.chat.id);
  });

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const cancelled = await deps.onCancel(ctx.chat.id, userId);
    await ctx.reply(cancelled ? "Cancel requested." : "No active prompt owned by this chat.");
  });

  bot.command("new", async (ctx) => {
    const userId = ctx.from?.id;
    const access = reloadAccess(config);
    if (ctx.chat.type !== "private" || !userId || !isAllowed(access, userId)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const reset = await deps.onNewSession(ctx.chat.id, userId);
    await ctx.reply(reset ? "New session started." : "Can't reset a session owned by another chat.");
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("grok:")) {
      await ctx.answerCallbackQuery();
      return;
    }
    const access = reloadAccess(config);
    const userIdStr = String(ctx.from?.id || "");
    if (!isAllowed(access, userIdStr) || ctx.chat?.type !== "private") {
      await answerCallbackQuery(ctx.callbackQuery!.id, "Not authorized", true);
      return;
    }
    const [, action, id] = data.split(":", 3);
    const pp = getPendingPermission();
    const active = getActivePrompt();
    if (!pp || pp.id !== id || !active || active.userId !== ctx.from.id || active.chatId !== ctx.chat?.id) {
      await answerCallbackQuery(ctx.callbackQuery!.id, "This approval has expired or belongs to another session.");
      return;
    }
    let decision: any;
    let label = "";
    if (action === "a") {
      label = "✅ Approved";
      const req: any = pp.rawRequest;
      const opts = req?.options || [];
      const chosen = opts.find((o: any) => o.kind === "allow_once")
        || opts.find((o: any) => o.kind === "allow_always");
      decision = chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else if (action === "r") {
      label = "❌ Rejected";
      decision = { outcome: { outcome: "cancelled" } };
    } else {
      await answerCallbackQuery(ctx.callbackQuery!.id, "Unknown action");
      return;
    }
    await answerCallbackQuery(ctx.callbackQuery!.id, label);
    const userDisplay = ctx.from?.first_name || ctx.from?.username || "Telegram";
    const primary = { chatId: ctx.chat!.id, messageId: ctx.callbackQuery!.message!.message_id };
    if (deps.resolvePermission) {
      await deps.resolvePermission(decision, label, userDisplay);
    }
    // clear buttons best effort
    try {
      await editMessageReplyMarkup(primary.chatId, primary.messageId, null);
    } catch {}
  });

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!message) return;
    if (ctx.chat.type !== "private") {
      await ctx.reply("This bridge only works in private chats.");
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
        const req: any = pp.rawRequest;
        const opts = req?.options || [];
        const chosen = opts.find((option: any) => option.kind === "allow_once")
          || opts.find((option: any) => option.kind === "allow_always");
        const decision = approve && chosen
          ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
          : { outcome: { outcome: "cancelled" } };
        if (deps.resolvePermission) await deps.resolvePermission(decision, label, ctx.from?.first_name || "Telegram");
        try {
          if (ctx.message?.message_id) await setMessageReaction(chatId, ctx.message.message_id, "👀");
        } catch {}
        return;
      }
    }

    if (!isAllowed(access, userId) && access.allowedUsers.length > 0) {
      await ctx.reply("Pairing is closed. This bridge already has an owner.");
      return;
    }
    if (!isAllowed(access, userId)) {
      cleanExpiredPending(config, access);
      const pending = access.pending?.[String(chatId)];
      if (pending) {
        if (completePairing(config, access, chatId, userId, text.trim())) {
          await ctx.reply("Paired! You can now send prompts to Grok Build.");
          return;
        }
        const remaining = Math.max(0, 5 - (pending.attempts ?? 0));
        await ctx.reply(remaining > 0
          ? `Invalid pairing code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
          : "Pairing cancelled after too many invalid attempts. Send another message to request a new code.");
        return;
      }
      const code = startPairing(config, access, chatId);
      await ctx.reply(
        "Pairing required. Ask the bridge operator for the one-time code, then send it here. It expires in about 5 minutes."
      );
      console.log(`[PAIRING] User ${userId} chat ${chatId} code: ${code}`);
      return;
    }

    if (getActivePrompt()) {
      await ctx.reply("Grok is still working on the previous prompt. Use /cancel or wait.");
      return;
    }

    // ack + start
    try {
      if (message.message_id) await setMessageReaction(chatId, message.message_id, "👀");
    } catch {}
    const allChats = [chatId];
    resetStreamDraftState();
    startTyping(allChats);
    bubbleActive = true;
    startActivePrompt(chatId, message.message_id || 0, userId);

    const promptText = text || "User sent a non-text message.";
    void deps.onPrompt(chatId, promptText, userId).catch(async () => {
      clearActivePrompt();
      stopTyping();
      resetStreamDraftState();
      await ctx.reply("Grok Build couldn't complete that request. Check the bridge logs for the correlation details.").catch(() => {});
    });
  });

  return bot;
}

export async function startPolling(bot: Bot) {
  // Use long polling
  await bot.start({
    onStart: (me) => {
      console.log(`Telegram bot @${me.username} polling started.`);
    },
    allowed_updates: ["message", "callback_query"],
  });
}

export async function stopPolling(bot: Bot): Promise<void> {
  try {
    await bot.stop();
  } catch {}
}

// health status lines for /status
export function healthStatusLines(extra: any): string[] {
  const ap = getActivePrompt();
  const pp = getPendingPermission();
  const lines = [
    "",
    "Health:",
    `  Polling: ${extra.lastPollAt ? `last poll ${formatAge(extra.lastPollAt)}` : "not yet"}`,
    `  Last Telegram update: ${extra.lastUpdateAt ? formatAge(extra.lastUpdateAt) : "never"}`,
    `  Last inbound prompt: ${extra.lastInboundAt ? formatAge(extra.lastInboundAt) : "never"}`,
    `  Last ACP event: ${extra.lastAcpAt ? formatAge(extra.lastAcpAt) : "never"}`,
    `  Last tool event: ${extra.lastToolAt ? formatAge(extra.lastToolAt) : "never"}`,
    `  Typing active: ${extra.typingActive ? `yes (${formatAge(extra.typingAgeMs || 0).replace(" ago", "")})` : "no"}`,
    `  Active prompt: ${ap ? `yes (${formatAge(ap.startedAt).replace(" ago", "")})` : "no"}`,
    `  Pending permission: ${pp ? `${pp.kind} waiting ${formatAge(pp.startedAt).replace(" ago", "")}` : "no"}`,
    `  ACP session: ${extra.acpSessionId || "none"}`,
    `  Likely state: ${extra.likelyState || "unknown"}`,
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
  bot = null;
  bubbleActive = false;
}

export function setTelegramTokenForTests(token: string) {
  bot = { _token: token } as unknown as Bot;
}
