import { sanitizedError } from "./redact.js";
import { setTypingStartedAt } from "./state.js";
import { getRuntimeConfig, sendChatAction } from "./telegram-api.js";
import { isBubbleActive } from "./telegram-bubbles.js";

let typingInterval: NodeJS.Timeout | null = null;
let typingDebounceTimer: NodeJS.Timeout | null = null;
let typingMaxTimer: NodeJS.Timeout | null = null;

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
    if (isBubbleActive()) resetTypingDebounce();
  };
  doType();
  typingInterval = setInterval(doType, config.TYPING_INTERVAL_MS);
  typingInterval.unref();
  typingMaxTimer = setTimeout(stopTyping, config.MAX_TYPING_SESSION_MS);
  typingMaxTimer.unref();
  resetTypingDebounce();
}

function resetTypingDebounce(): void {
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(stopTyping, getRuntimeConfig().TYPING_DEBOUNCE_MS);
  typingDebounceTimer.unref();
}

export function stopTyping(): void {
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
