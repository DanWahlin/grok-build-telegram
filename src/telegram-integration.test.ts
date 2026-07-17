import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramBot, resetTelegramRuntimeForTests } from "./telegram.js";
import { saveAccess } from "./state.js";
import type { Config } from "./config.js";
import { createTestConfig } from "./test-support.js";

function makeConfig(stateDir: string): Config {
  return createTestConfig(stateDir, { SEND_PACE_MS: 0 });
}

function makeDeps(config: Config) {
  return {
    config,
    onPrompt: vi.fn(async () => {}),
    onCancel: vi.fn(async () => true),
    onNewSession: vi.fn(async () => true),
    onStatus: vi.fn(async () => {}),
  };
}

describe("Telegram authorization and prompt dispatch", () => {
  it("rejects group prompts before dispatching to ACP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-auth-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      const deps = makeDeps(config);
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      const replies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { text?: string };
        if (payload.text) replies.push(payload.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }));

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          text: "run tests",
          chat: { id: -10, type: "group", title: "dev" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);

      expect(deps.onPrompt).not.toHaveBeenCalled();
      expect(replies).toContain("This bridge only works in private chats.");
      resetTelegramRuntimeForTests();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detaches a private prompt so later updates remain processable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-async-"));
    try {
      const config = makeConfig(dir);
      saveAccess(config, { allowedUsers: ["42"], pending: {} });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const deps = { ...makeDeps(config), onPrompt: vi.fn(() => blocked) };
      const bot = createTelegramBot(config, deps);
      (bot as any).botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
        new Response(JSON.stringify({
          ok: true,
          result: String(input).endsWith("/setMessageReaction") ? true : { message_id: 1 },
        }))));

      const handled = bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 0,
          text: "long task",
          chat: { id: 42, type: "private", first_name: "Dan" },
          from: { id: 42, is_bot: false, first_name: "Dan" },
        },
      } as any);
      await expect(Promise.race([
        handled.then(() => "handled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ])).resolves.toBe("handled");
      expect(deps.onPrompt).toHaveBeenCalledOnce();
      release();
      resetTelegramRuntimeForTests();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
