import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import {
  childExitBarrier,
  createAcpClient,
  terminateChildProcess,
  verifyProcessCwdIdentity,
} from "./acp-client.js";
import {
  captureRootIdentity,
  cleanupInboxFiles,
  writeInboxFile,
} from "./media.js";

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

  it("caps simultaneous pending pairing challenges", () => {
    const config = createTestConfig(dir, { LOCK_STALE_AFTER_MS: 1_000, PAIRING_PENDING_MAX: 2 });
    ensureStateDir(config);
    const access: AccessState = { allowedUsers: [], pending: {} };
    startPairing(config, access, 1);
    startPairing(config, access, 2);
    access.pending["1"]!.timestamp = 1;
    access.pending["2"]!.timestamp = 2;
    startPairing(config, access, 3);

    expect(Object.keys(access.pending).sort()).toEqual(["2", "3"]);
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

describe("ACP process ownership", () => {
  it("invalidates a deferred reconnect when shutdown begins", async () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-connect-shutdown-"));
    try {
      const config = createTestConfig(parent);
      const root = captureRootIdentity(parent);
      let releaseSpawn!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseSpawn = resolve; });
      const spawnMock = vi.fn();
      const client = createAcpClient(config, {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(async () => ({
          outcome: { outcome: "cancelled" as const },
        })),
        onEvent: vi.fn(),
        getExpectedRootIdentity: () => root,
      }, {
        beforeSpawn: async () => {
          markEntered();
          await blocked;
        },
        spawn: spawnMock as unknown as typeof spawn,
      });

      const connecting = client.connect();
      await entered;
      const shuttingDown = client.shutdown();
      releaseSpawn();
      await expect(connecting).rejects.toThrow(/superseded by shutdown/);
      await expect(shuttingDown).resolves.toBeUndefined();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("bounds hung ACP initialization so serialized shutdown can terminate the child", async () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-init-timeout-"));
    try {
      const marker = join(parent, "child-started");
      const executable = join(parent, "fake-grok");
      writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
      chmodSync(executable, 0o700);
      const config = createTestConfig(parent, {
        API_TIMEOUT_MS: 30,
        GROK_BIN: executable,
        grokBin: executable,
      });
      const root = captureRootIdentity(parent);
      const client = createAcpClient(config, {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } })),
        onEvent: vi.fn(),
        getExpectedRootIdentity: () => root,
      });

      const connecting = client.connect();
      const deadline = Date.now() + 2_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(marker)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const started = Date.now();
      const shuttingDown = client.shutdown();

      await expect(connecting).rejects.toThrow(/timed out|superseded/i);
      await expect(shuttingDown).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(500);
      const childPid = Number(readFileSync(marker, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails promptly when the Grok executable cannot be spawned", async () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-spawn-error-"));
    try {
      const config = createTestConfig(parent, {
        GROK_BIN: "/definitely/missing/grok",
        grokBin: "/definitely/missing/grok",
      });
      const root = captureRootIdentity(parent);
      const client = createAcpClient(config, {
        onSessionUpdate: vi.fn(),
        onPermissionRequest: vi.fn(async () => ({
          outcome: { outcome: "cancelled" as const },
        })),
        onEvent: vi.fn(),
        getExpectedRootIdentity: () => root,
      });

      await expect(client.connect()).rejects.toThrow(/ENOENT|spawn/i);
      await expect(client.shutdown()).resolves.toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not treat a child error event as proven process exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await once(child, "spawn");
    child.on("error", () => undefined);
    const exited = childExitBarrier(child);
    let settled = false;
    void exited.then(() => { settled = true; });

    child.emit("error", new Error("kill failed"));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.kill("SIGKILL");
    await exited;
    expect(settled).toBe(true);
  });

  it("requires proven child exit after escalating to SIGKILL", async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") queueMicrotask(resolveExit);
      return true;
    });

    await expect(terminateChildProcess({ kill }, exited, 1, 25)).resolves.toBeUndefined();
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects ownership release when exit cannot be proven", async () => {
    const kill = vi.fn(() => true);
    await expect(terminateChildProcess({ kill }, new Promise<void>(() => undefined), 1, 1))
      .rejects.toThrow(/did not exit after SIGKILL/);
  });

  it("keeps attachment descriptors readable by the ACP child process", async () => {
    if (process.platform !== "linux") return;
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-child-descriptor-"));
    const file = writeInboxFile(captureRootIdentity(parent), "note.txt", Buffer.from("trusted"));
    try {
      if (file.descriptorFd === null) throw new Error("descriptor missing");
      const descriptorPath = `/proc/${process.pid}/fd/${file.descriptorFd}`;
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", descriptorPath],
        { stdio: ["ignore", "pipe", "pipe"], shell: false },
      );
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
      expect(code).toBe(0);
      expect(Buffer.concat(stdout).toString("utf8")).toBe("trusted");
    } finally {
      cleanupInboxFiles([file]);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("proves the spawned process is running in the authorized directory identity", async () => {
    if (process.platform !== "linux") return;
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-process-cwd-"));
    const allowed = join(parent, "allowed");
    const other = join(parent, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: allowed,
      stdio: "ignore",
      shell: false,
    });
    try {
      await once(child, "spawn");
      expect(() => verifyProcessCwdIdentity(child.pid, captureRootIdentity(allowed))).not.toThrow();
      expect(() => verifyProcessCwdIdentity(child.pid, captureRootIdentity(other)))
        .toThrow(/outside the authorized CWD identity/);
    } finally {
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
