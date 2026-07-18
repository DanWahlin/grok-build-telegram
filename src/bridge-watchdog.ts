import type { Config } from "./config.js";
import { ageMs, formatAge, nowIso } from "./utils.js";
import { sanitizedError } from "./redact.js";
import { getActivePrompt, getPendingPermission, type ActivePromptState } from "./state.js";
import {
  sendMessage,
  editMessageReplyMarkup,
  stopTyping,
  resetStreamDraftState,
  dismissBubble,
  stalePromptKeyboard,
} from "./telegram.js";

export interface Watchdog {
  runWatchdog: (ap: ActivePromptState) => Promise<void>;
}

/**
 * Stale-prompt and progress-notice watchdog logic bound to the bridge config.
 * `reportHealth` records a forced health snapshot for the given reason.
 */
export function createWatchdog(
  config: Config,
  reportHealth: (reason: string) => void,
): Watchdog {
  async function maybeProgressNotice(
    ap: ActivePromptState,
    age: number | null,
  ): Promise<void> {
    if (getActivePrompt()?.id !== ap.id) return;
    if (age == null || age < config.PROGRESS_NOTICE_AFTER_MS) return;
    if (ap.progressNoticeCount >= config.PROGRESS_NOTICE_MAX_ITERATIONS) return;
    const lastAge = ap.lastProgressNoticeAt ? ageMs(ap.lastProgressNoticeAt) : Infinity;
    if ((lastAge || 0) < config.PROGRESS_NOTICE_INTERVAL_MS) return;
    ap.progressNoticeCount += 1;
    ap.lastProgressNoticeAt = nowIso();
    const iteration = Math.min(
      config.PROGRESS_NOTICE_MAX_ITERATIONS,
      Math.max(1, Math.ceil(age / config.PROGRESS_NOTICE_ITERATION_MS)),
    );
    const detail = getPendingPermission() ? "waiting permission" : "working";
    if (getActivePrompt()?.id !== ap.id) return;
    await sendMessage(
      ap.chatId,
      `⏳ Still working... ${formatAge(age)} — ${detail} (${iteration}/${config.PROGRESS_NOTICE_MAX_ITERATIONS})`,
    );
  }

  async function runWatchdog(ap: ActivePromptState): Promise<void> {
    if (getActivePrompt()?.id !== ap.id || ap.cancelling) return;
    const age = ageMs(ap.startedAt);
    const activityAge = ageMs(ap.lastActivityAt ?? ap.startedAt);
    await maybeProgressNotice(ap, age);
    if (getActivePrompt()?.id !== ap.id) return;
    if (
      activityAge != null
      && activityAge > config.PROMPT_STALE_AFTER_MS
      && !ap.warningSent
    ) {
      ap.warningSent = true;
      stopTyping();
      resetStreamDraftState();
      await dismissBubble();
      if (getActivePrompt()?.id !== ap.id) return;
      try {
        const sent = await sendMessage(
          ap.chatId,
          `⚠️ ACP appears stalled (${formatAge(activityAge)} without activity).`,
          { reply_markup: stalePromptKeyboard(ap.id) },
        );
        if (getActivePrompt()?.id === ap.id) {
          ap.staleMessageId = sent.message_id;
        } else {
          await editMessageReplyMarkup(ap.chatId, sent.message_id, null);
        }
      } catch (error: unknown) {
        console.warn(`[WATCHDOG] Stale notice failed: ${sanitizedError(error)}`);
      }
      reportHealth("stalled");
    }
  }

  return { runWatchdog };
}
