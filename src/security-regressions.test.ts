import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  buildHealthSnapshot,
  completePairing,
  ensureStateDir,
  readLock,
  reloadAccess,
  removeLock,
  saveJsonAtomic,
  startPairing,
  type AccessState,
} from "./state.js";
import {
  resetTelegramRuntimeForTests,
  sendMessage,
  setTelegramRuntimeForTests,
  startTyping,
} from "./telegram.js";
import { createTestConfig } from "./test-support.js";

function configFor(dir: string) {
  return createTestConfig(dir, { LOCK_STALE_AFTER_MS: 1_000 });
}

describe("Telegram outbound queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTelegramRuntimeForTests("test-token", createTestConfig("/tmp"));
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
    await vi.advanceTimersByTimeAsync(100);
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

  it("falls back safely when state JSON has the wrong shape", () => {
    const config = configFor(dir);
    ensureStateDir(config);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ allowedUsers: "42", pending: [] }));
    writeFileSync(join(dir, "lock.json"), JSON.stringify({ pid: "not-a-number" }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(reloadAccess(config)).toEqual({ allowedUsers: [], pending: {} });
    expect(readLock(config)).toBeNull();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("populates bot identity and matching health timestamp fields", () => {
    const config = configFor(dir);
    const snapshot = buildHealthSnapshot(config, "test", {
      connected: true,
      botName: "Grok Bridge",
      botUsername: "grok_bridge_bot",
      lastInboundPromptAt: "2026-01-02T03:04:05.000Z",
      lastAcpEventAt: "2026-01-02T03:04:06.000Z",
      lastToolEventAt: "2026-01-02T03:04:07.000Z",
    });

    expect(snapshot.botName).toBe("Grok Bridge");
    expect(snapshot.botUsername).toBe("grok_bridge_bot");
    expect(snapshot.lastInboundPromptAt).toBe("2026-01-02T03:04:05.000Z");
    expect(snapshot.lastAcpEventAt).toBe("2026-01-02T03:04:06.000Z");
    expect(snapshot.lastToolEventAt).toBe("2026-01-02T03:04:07.000Z");

    const partialUpdate = buildHealthSnapshot(config, "acp-update", { connected: true });
    expect(partialUpdate.botName).toBe("Grok Bridge");
    expect(partialUpdate.botUsername).toBe("grok_bridge_bot");
    expect(partialUpdate.lastInboundPromptAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
