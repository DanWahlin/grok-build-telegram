import type { Config } from "./config.js";
import {
  getActivePrompt,
  getPlanMessageId,
  setPlanMessageId,
  getThoughtDraft,
  setThoughtDraft,
  getVerboseMode,
  type ActivePromptState,
} from "./state.js";
import {
  editFormattedMessage,
  sendFormattedMessage,
  editMessageReplyMarkup,
} from "./telegram.js";
import { sanitizedError } from "./redact.js";

export interface BridgeUi {
  clearStalePromptCard: (active: ActivePromptState | null) => Promise<void>;
  upsertPlanMessage: (chatId: number, text: string, promptId: string) => Promise<void>;
  updateThoughtStream: (chatId: number, delta: string, promptId: string) => Promise<void>;
}

/** Plan, thought-stream, and stale-prompt-card rendering bound to the bridge config. */
export function createBridgeUi(config: Config): BridgeUi {
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

  async function upsertPlanMessage(chatId: number, text: string, promptId: string): Promise<void> {
    if (getActivePrompt()?.id !== promptId) return;
    const existing = getPlanMessageId(chatId);
    if (existing) {
      try {
        await editFormattedMessage(chatId, existing, text);
        return;
      } catch (error: unknown) {
        if (!(error instanceof Error && /message to edit not found/i.test(error.message))) {
          console.warn(`[TG] Plan edit failed: ${sanitizedError(error)}`);
        }
        if (getActivePrompt()?.id === promptId) setPlanMessageId(chatId, null);
      }
    }
    if (getActivePrompt()?.id !== promptId) return;
    try {
      const sent = await sendFormattedMessage(chatId, text);
      if (getActivePrompt()?.id === promptId) setPlanMessageId(chatId, sent.message_id);
    } catch (error: unknown) {
      console.warn(`[TG] Plan send failed: ${sanitizedError(error)}`);
    }
  }

  async function updateThoughtStream(chatId: number, delta: string, promptId: string): Promise<void> {
    if (!getVerboseMode() || getActivePrompt()?.id !== promptId) return;
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
        if (getActivePrompt()?.id !== promptId) return;
        draft.messageId = sent.message_id;
      }
      if (getActivePrompt()?.id !== promptId) return;
      draft.lastEditAt = now;
      setThoughtDraft(chatId, draft);
    } catch (error: unknown) {
      console.warn(`[TG] Thought stream update failed: ${sanitizedError(error)}`);
    }
  }

  return { clearStalePromptCard, upsertPlanMessage, updateThoughtStream };
}
