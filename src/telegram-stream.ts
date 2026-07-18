import type { Config } from "./config.js";
import { sleep } from "./utils.js";
import { sanitizedError } from "./redact.js";
import { chunkMessage } from "./telegram-render.js";
import {
  getRuntimeConfig,
  sendFormattedMessage,
  editFormattedMessage,
} from "./telegram-api.js";

interface StreamDraft {
  messageId: number | null;
  text: string;
  lastSentText: string;
  lastEditAt: number;
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  generation: number;
}

const streamDrafts = new Map<number, StreamDraft>();
let streamGeneration = 0;
const streamFlushTasks = new Map<number, Set<Promise<void>>>();
let currentAssistantText = "";
let assistantTextTruncated = false;

export function resetStreamDraftState(): void {
  streamGeneration += 1;
  currentAssistantText = "";
  assistantTextTruncated = false;
  for (const d of streamDrafts.values()) {
    if (d.timer) clearTimeout(d.timer);
  }
  streamDrafts.clear();
}

export async function resetAndWaitForStreamDrafts(): Promise<void> {
  resetStreamDraftState();
  for (;;) {
    const tasks = [...streamFlushTasks.values()].flatMap((set) => [...set]);
    if (!tasks.length) return;
    await Promise.all(tasks);
  }
}

function trimDraftText(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max + 80).replace(/^\S*\s*/, "");
  return `…\n${tail}`;
}

function trackStreamFlush(
  generation: number,
  operation: Promise<void>,
  label: string,
): void {
  let tasks = streamFlushTasks.get(generation);
  if (!tasks) {
    tasks = new Set();
    streamFlushTasks.set(generation, tasks);
  }
  const tracked = operation
    .catch((error: unknown) => {
      console.error(`[TG] ${label}: ${sanitizedError(error)}`);
    })
    .finally(() => {
      tasks?.delete(tracked);
      if (tasks?.size === 0) streamFlushTasks.delete(generation);
    });
  tasks.add(tracked);
}

function scheduleStreamDraftFlush(chatIds: number[], force = false, config: Config): void {
  const text = trimDraftText(currentAssistantText, config.STREAM_DRAFT_MAX);
  if (!text) return;
  for (const chatId of chatIds) {
    let draft = streamDrafts.get(chatId);
    if (!draft) {
      draft = {
        messageId: null,
        text: "",
        lastSentText: "",
        lastEditAt: 0,
        timer: null,
        flushing: false,
        generation: streamGeneration,
      };
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
    const generation = draft.generation;
    draft.timer = setTimeout(() => {
      trackStreamFlush(
        generation,
        flushStreamDraft(chatId, force, config, generation),
        `Stream draft flush failed for chat ${chatId}`,
      );
    }, delay);
  }
}

async function flushStreamDraft(
  chatId: number,
  force: boolean,
  config: Config,
  generation: number,
): Promise<void> {
  const draft = streamDrafts.get(chatId);
  if (!draft || draft.generation !== generation || generation !== streamGeneration) return;
  draft.timer = null;
  if (draft.flushing) {
    if (force) {
      while (draft.flushing) await sleep(10);
      return flushStreamDraft(chatId, true, config, generation);
    }
    draft.timer = setTimeout(() => {
      trackStreamFlush(
        generation,
        flushStreamDraft(chatId, false, config, generation),
        `Deferred stream flush failed for chat ${chatId}`,
      );
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
        trackStreamFlush(
          generation,
          flushStreamDraft(chatId, false, config, generation),
          `Follow-up stream flush failed for chat ${chatId}`,
        );
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
      generation: streamGeneration,
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
      await flushStreamDraft(chatId, true, config, draft.generation);
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

export function getCurrentAssistantText(): string {
  return currentAssistantText;
}

export function appendAssistantDelta(delta: string): void {
  if (assistantTextTruncated) return;
  const max = getRuntimeConfig().ASSISTANT_TEXT_MAX_CHARS;
  if (currentAssistantText.length + delta.length <= max) {
    currentAssistantText += delta;
    return;
  }
  const marker = "\n\n[Response truncated by bridge]";
  const suffix = marker.slice(0, max);
  const prefixBudget = Math.max(0, max - suffix.length);
  currentAssistantText = (currentAssistantText + delta).slice(0, prefixBudget) + suffix;
  assistantTextTruncated = true;
}

export function scheduleAssistantDeltaFlush(chatIds: number[], config: Config): void {
  scheduleStreamDraftFlush(chatIds, false, config);
}

export function getStreamDrafts(): Map<number, StreamDraft> {
  return streamDrafts;
}
