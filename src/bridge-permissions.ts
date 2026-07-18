import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Config } from "./config.js";
import {
  getActivePrompt,
  takePendingPermission,
  cancelPendingPermissionState,
} from "./state.js";
import {
  sendMessage,
  editPermissionMessage,
  editMessageReplyMarkup,
  permissionKeyboard,
  pendingPermissionText,
  resolvedPermissionText,
  expiredPermissionText,
} from "./telegram.js";
import { sanitizedError, sanitizePermissionText } from "./redact.js";

export type PermissionCardTarget = { chatId: number; messageId: number };

export interface PermissionCards {
  sendPermissionCard: (
    summary: string,
    id: string,
    options: PermissionOption[],
  ) => Promise<PermissionCardTarget[]>;
  expirePermissionCards: (summary: string, messages: PermissionCardTarget[]) => Promise<void>;
  resolvePermissionFromTelegram: (
    decision: RequestPermissionResponse,
    label: string,
    userDisplay: string,
  ) => Promise<boolean>;
  cancelPendingPermission: () => Promise<void> | null;
}

/**
 * Permission-card lifecycle bound to the bridge's config and health reporter.
 * `reportHealth` records a forced health snapshot for the given reason.
 */
export function createPermissionCards(
  config: Config,
  reportHealth: (reason: string) => void,
): PermissionCards {
  async function sendPermissionCard(
    summary: string,
    id: string,
    options: PermissionOption[],
  ): Promise<PermissionCardTarget[]> {
    const active = getActivePrompt();
    const chats = active ? [active.chatId] : [];
    const keyboard = permissionKeyboard(id, options);
    const msgs: PermissionCardTarget[] = [];
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

  async function expirePermissionCards(
    summary: string,
    messages: PermissionCardTarget[],
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

  async function resolvePermissionFromTelegram(
    decision: RequestPermissionResponse,
    label: string,
    _userDisplay: string,
  ): Promise<boolean> {
    const pp = takePendingPermission();
    if (!pp) return false;
    clearTimeout(pp.timer);
    pp.resolve(decision);
    reportHealth("permission-resolved");
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
    return true;
  }

  function cancelPendingPermission(): Promise<void> | null {
    const pending = cancelPendingPermissionState();
    if (!pending) return null;
    return expirePermissionCards(pending.summary, pending.messages).catch((error: unknown) => {
      console.warn(`[TG] Pending permission card cleanup failed: ${sanitizedError(error)}`);
    });
  }

  return {
    sendPermissionCard,
    expirePermissionCards,
    resolvePermissionFromTelegram,
    cancelPendingPermission,
  };
}
