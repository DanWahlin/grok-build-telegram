import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAssistantDelta,
  dismissBubble,
  finalizeStreamDrafts,
  getStreamDrafts,
  resetTelegramRuntimeForTests,
  sendMessage,
  scheduleAssistantDeltaFlush,
  setTelegramRuntimeForTests,
  startTyping,
  trackToolCall,
  updateToolCall,
} from "./telegram.js";
import {
  clearActivePrompt,
  saveAccess,
  startActivePrompt,
} from "./state.js";
import { createTestConfig } from "./test-support.js";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function stubTelegramApi(calls: ApiCall[]): void {
  let messageId = 100;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop() ?? "";
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: messageId++ } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }));
}

describe("Telegram delivery runtime", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "grok-tg-runtime-"));
  });

  afterEach(() => {
    resetTelegramRuntimeForTests();
    clearActivePrompt();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("finalizes the first chunk in the draft and sends every remaining chunk", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, {
      SEND_PACE_MS: 0,
      STREAM_EDIT_INTERVAL_MS: 1,
    });
    setTelegramRuntimeForTests("test-token", config);
    stubTelegramApi(calls);

    appendAssistantDelta("preview");
    scheduleAssistantDeltaFlush([42], config);
    await vi.advanceTimersByTimeAsync(1);

    const content = `${"a".repeat(4_096)}${"b".repeat(900)}`;
    await finalizeStreamDrafts(content, [42], config);

    const deliveries = calls.filter(({ method }) =>
      method === "sendMessage" || method === "editMessageText");
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]?.payload.text).toBe("preview");
    expect(deliveries[1]?.method).toBe("editMessageText");
    expect(deliveries[1]?.payload.text).toBe("a".repeat(4_096));
    expect(deliveries[2]?.payload.text).toBe("b".repeat(900));
  });

  it("creates, edits, and deletes a tool bubble only for the active authorized chat", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, { SEND_PACE_MS: 0 });
    setTelegramRuntimeForTests("test-token", config);
    saveAccess(config, { allowedUsers: ["42"], pending: {} });
    startActivePrompt(42, 1, 42);
    stubTelegramApi(calls);

    trackToolCall("tool-1", "Run command", { command: "npm test" });
    await vi.advanceTimersByTimeAsync(300);
    updateToolCall("tool-1", "completed");
    await vi.advanceTimersByTimeAsync(300);
    await dismissBubble();

    expect(calls.map(({ method }) => method)).toEqual([
      "sendMessage",
      "editMessageText",
      "deleteMessage",
    ]);
    expect(calls[0]?.payload.chat_id).toBe(42);
    expect(calls[0]?.payload.text).toContain("npm test");
  });

  it("resets draft state when a later final chunk cannot be delivered", async () => {
    const config = createTestConfig(stateDir, { SEND_PACE_MS: 0 });
    setTelegramRuntimeForTests("test-token", config);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      callCount += 1;
      if (callCount === 2) return new Response("delivery failed", { status: 500 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }));
    }));

    await expect(finalizeStreamDrafts("x".repeat(5_000), [42], config)).rejects.toThrow(
      /Telegram API sendMessage failed/,
    );
    expect(getStreamDrafts().size).toBe(0);
    expect(errorLog).toHaveBeenCalled();
  });

  it("honors configured send pacing and typing intervals", async () => {
    vi.useFakeTimers();
    const calls: ApiCall[] = [];
    const config = createTestConfig(stateDir, {
      SEND_PACE_MS: 120,
      TYPING_INTERVAL_MS: 200,
      TYPING_DEBOUNCE_MS: 10_000,
      MAX_TYPING_SESSION_MS: 550,
    });
    setTelegramRuntimeForTests("test-token", config);
    stubTelegramApi(calls);

    const first = sendMessage(42, "one");
    const second = sendMessage(42, "two");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119);
    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    calls.length = 0;
    startTyping([42]);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.filter(({ method }) => method === "sendChatAction")).toHaveLength(3);
  });
});
