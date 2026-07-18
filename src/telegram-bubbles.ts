import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import { sleep } from "./utils.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";
import { reloadAccess, isAllowed, getActivePrompt } from "./state.js";
import {
  getRuntimeConfig,
  getRuntimeConfigOrNull,
  sendFormattedMessage,
  editFormattedMessage,
  deleteMessage,
} from "./telegram-api.js";

let bubbleActive = false;
const bubbleMessageIds = new Map<number, number>();
const allBubbleIds = new Map<number, Set<number>>();
let bubbleDebounceTimer: NodeJS.Timeout | null = null;
let flushInProgress = false;
let reflushNeeded = false;
let lastCompletedToolDesc: string | null = null;
const activeTools = new Map<string, { name: string; description: string }>();
let toolsSeenCount = 0;

export function isBubbleActive(): boolean {
  return bubbleActive;
}

export function setBubbleActive(value: boolean): void {
  bubbleActive = value;
}

function getStringProperty(value: unknown, property: string): string | null {
  if (!isUnknownRecord(value)) return null;
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function describeTool(title: string | null | undefined, rawInput: unknown): string | null {
  if (!title) return null;
  if (typeof rawInput === "string") {
    return sanitizePermissionText(rawInput.split("\n")[0] ?? "", 120);
  }
  const command = getStringProperty(rawInput, "command");
  if (command) return sanitizePermissionText(command.split("\n")[0] ?? "", 120);
  const path = getStringProperty(rawInput, "path");
  if (path) return sanitizePermissionText(`${title} ${path}`, 120);
  return sanitizePermissionText(title, 120);
}

function scheduleBubbleUpdate(): void {
  if (!bubbleActive) return;
  if (bubbleDebounceTimer) clearTimeout(bubbleDebounceTimer);
  const debounce = getRuntimeConfig().BUBBLE_DEBOUNCE_MS;
  bubbleDebounceTimer = setTimeout(() => {
    void flushBubble().catch((error: unknown) => {
      console.error(`[TG] Tool progress bubble failed: ${sanitizedError(error)}`);
    });
  }, debounce);
}

function rememberBubbleMessage(chatId: number, messageId: number): void {
  bubbleMessageIds.set(chatId, messageId);
  const ids = allBubbleIds.get(chatId) ?? new Set<number>();
  ids.add(messageId);
  allBubbleIds.set(chatId, ids);
}

function getAuthorizedActiveChat(): number | null {
  const active = getActivePrompt();
  const config = getRuntimeConfigOrNull();
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
  toolsSeenCount += 1;
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

export function getToolsSeenCount(): number {
  return toolsSeenCount;
}

export function setToolsSeenCount(value: number): void {
  toolsSeenCount = value;
}

export function resetBubblesForTests(): void {
  bubbleActive = false;
  if (bubbleDebounceTimer) {
    clearTimeout(bubbleDebounceTimer);
    bubbleDebounceTimer = null;
  }
  bubbleMessageIds.clear();
  allBubbleIds.clear();
  activeTools.clear();
  lastCompletedToolDesc = null;
  flushInProgress = false;
  reflushNeeded = false;
  toolsSeenCount = 0;
}
