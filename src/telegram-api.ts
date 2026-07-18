import type { InlineKeyboardMarkup, ReactionTypeEmoji } from "grammy/types";
import type { Bot } from "grammy";
import type { Config } from "./config.js";
import { sleep } from "./utils.js";
import { sanitizedError } from "./redact.js";
import { markdownToTelegramHtml } from "./telegram-render.js";

let telegramToken: string | null = null;
let runtimeConfig: Config | null = null;

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  attempts: number;
}
let sendQueue: QueueItem[] = [];
let sendQueueRunning = false;
let sendQueueClosing = false;
let sendQueueDrainPromise: Promise<void> | null = null;
let inFlightUpdates = 0;

export interface TelegramMessageResult {
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

export function setTelegramRuntime(token: string | null, config: Config | null): void {
  telegramToken = token;
  runtimeConfig = config;
  sendQueueClosing = false;
}

export function getTelegramToken(): string {
  if (!telegramToken) throw new Error("Telegram bot is not initialized");
  return telegramToken;
}

export function getRuntimeConfig(): Config {
  if (!runtimeConfig) throw new Error("Telegram runtime is not configured");
  return runtimeConfig;
}

export function getRuntimeConfigOrNull(): Config | null {
  return runtimeConfig;
}

export function beginUpdate(): void {
  inFlightUpdates += 1;
}

export function endUpdate(): void {
  inFlightUpdates -= 1;
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
    if (sendQueueClosing) {
      reject(new Error("Telegram outbound queue is shutting down"));
      return;
    }
    const config = getRuntimeConfig();
    if (sendQueue.length + (sendQueueRunning ? 1 : 0) >= config.TELEGRAM_OUTBOUND_QUEUE_MAX) {
      reject(new Error("Telegram outbound queue is full"));
      return;
    }
    sendQueue.push({ fn, resolve, reject, attempts: 0 });
    if (!sendQueueRunning) sendQueueDrainPromise = drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  sendQueueRunning = true;
  try {
    while (sendQueue.length > 0) {
      const item = sendQueue.shift();
      if (!item) continue;
      if (sendQueueClosing) {
        item.reject(new Error("Telegram outbound queue is shutting down"));
        continue;
      }
      try {
        const r = await item.fn();
        item.resolve(r);
      } catch (err: unknown) {
        const config = getRuntimeConfig();
        if (err instanceof TelegramApiError && err.status === 429
          && item.attempts < config.TELEGRAM_RETRY_MAX && !sendQueueClosing) {
          item.attempts += 1;
          sendQueue.unshift(item);
          await sleep(Math.min((err.retryAfter ?? 5) * 1000, config.API_TIMEOUT_MS));
          continue;
        }
        item.reject(err);
      }
      if (sendQueue.length > 0) await sleep(getRuntimeConfig().SEND_PACE_MS);
    }
  } finally {
    sendQueueRunning = false;
    sendQueueDrainPromise = null;
  }
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
        getTelegramToken(),
      ),
    );
  } catch (err: unknown) {
    if (err instanceof Error && /can.t parse|entit/i.test(err.message)) {
      await enqueue(() =>
        callApi(
          "editMessageText",
          { chat_id: chatId, message_id: messageId, text: markdown },
          getTelegramToken(),
        ),
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
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  }, getTelegramToken()));
}

export async function editPermissionMessage(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await enqueue(() => callApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
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
      getTelegramToken(),
    ),
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
      getTelegramToken(),
    ),
  );
}

export async function sendChatAction(chatId: number, action = "typing"): Promise<void> {
  await enqueue(() =>
    callApi("sendChatAction", { chat_id: chatId, action }, getTelegramToken()),
  );
}

export async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  await enqueue(() =>
    callApi("deleteMessage", { chat_id: chatId, message_id: messageId }, getTelegramToken()));
}

export async function getFilePath(fileId: string): Promise<string> {
  const result = await enqueue(() =>
    callApi("getFile", { file_id: fileId }, getTelegramToken()));
  if (!result || typeof result !== "object" || !("file_path" in result)) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const path = (result as { file_path?: string }).file_path;
  if (!path) throw new Error("Telegram getFile returned empty file_path");
  return path;
}

export async function stopPolling(bot: Bot): Promise<void> {
  let stopError: unknown = null;
  let stopTimer: NodeJS.Timeout | null = null;
  try {
    const stopResult = await Promise.race([
      bot.stop().then(() => true),
      new Promise<boolean>((resolve) => {
        stopTimer = setTimeout(() => resolve(false), getRuntimeConfig().API_TIMEOUT_MS);
        stopTimer.unref();
      }),
    ]);
    if (!stopResult) throw new Error("Telegram polling stop timed out");
  } catch (error: unknown) {
    stopError = error;
    console.warn(`[TG] Failed to stop polling cleanly: ${sanitizedError(error)}`);
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
  }
  const deadline = Date.now() + getRuntimeConfig().API_TIMEOUT_MS;
  while (inFlightUpdates > 0 && Date.now() < deadline) await sleep(25);
  if (inFlightUpdates > 0) {
    const handlerError = new Error(`Telegram handlers did not settle (${inFlightUpdates} still active)`);
    throw stopError
      ? new AggregateError([stopError, handlerError], "Telegram polling did not stop safely")
      : handlerError;
  }
  if (stopError) throw stopError;
}

export function beginOutboundShutdown(): void {
  sendQueueClosing = true;
  const queued = sendQueue.splice(0);
  for (const item of queued) item.reject(new Error("Telegram outbound queue is shutting down"));
}

export async function closeOutboundQueue(): Promise<void> {
  beginOutboundShutdown();
  const drain = sendQueueDrainPromise;
  if (!drain) return;
  const drained = await Promise.race([
    drain.then(() => true),
    sleep(getRuntimeConfig().API_TIMEOUT_MS + 1_000).then(() => false),
  ]);
  if (!drained) throw new Error("Telegram outbound queue did not drain during shutdown");
}

export function resetApiForTests(): void {
  for (const item of sendQueue) item.reject(new Error("Telegram test runtime reset"));
  sendQueue = [];
  sendQueueRunning = false;
  sendQueueClosing = false;
  sendQueueDrainPromise = null;
  inFlightUpdates = 0;
  telegramToken = null;
  runtimeConfig = null;
}
