import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  completePairing,
  ensureStateDir,
  readLock,
  removeLock,
  saveJsonAtomic,
  startPairing,
  type AccessState,
} from "./state.js";
import {
  resetTelegramRuntimeForTests,
  sendMessage,
  setTelegramTokenForTests,
  startTyping,
} from "./telegram.js";
import type { Config } from "./config.js";

function configFor(dir: string): Config {
  return {
    stateDir: dir,
    PAIRING_EXPIRY_MS: 300_000,
    LOCK_STALE_AFTER_MS: 1_000,
  } as Config;
}

describe("Telegram outbound queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTelegramTokenForTests("test-token");
  });

  afterEach(() => {
    resetTelegramRuntimeForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps typing traffic and ordinary sends moving through one queue", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      methods.push(String(input).split("/").pop() ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    startTyping([42]);
    const sent = sendMessage(42, "hello");
    await vi.runAllTimersAsync();
    await sent;

    expect(methods).toContain("sendChatAction");
    expect(methods).toContain("sendMessage");
  });
});

describe("pairing and state hardening", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grok-tg-test-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("preserves a pairing code while counting failed attempts", () => {
    const config = configFor(dir);
    ensureStateDir(config);
    const access: AccessState = { allowedUsers: [], pending: {} };
    const code = startPairing(config, access, 42);

    expect(completePairing(config, access, 42, 99, "WRONG1")).toBe(false);
    expect(access.pending["42"]?.code).toBe(code);
    expect(access.pending["42"]?.attempts).toBe(1);
    expect(completePairing(config, access, 42, 99, code)).toBe(true);
    expect(access.allowedUsers).toEqual(["99"]);
  });

  it("forces state directory and files to owner-only modes", () => {
    const config = configFor(dir);
    chmodSync(dir, 0o777);
    ensureStateDir(config);
    const file = join(dir, "example.json");
    saveJsonAtomic(file, { ok: true });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ok: true });
  });

  it("acquires the poller lock exclusively", () => {
    const config = configFor(dir);
    ensureStateDir(config);
    acquireLock(config, "first");
    expect(readLock(config)?.sessionId).toBe("first");
    expect(() => acquireLock(config, "second")).toThrow(/already locked/);
    removeLock(config, "first");
  });
});
