import {
  chunkMessage,
  finalizeExistingPermissionText,
  markdownToTelegramHtml,
  permissionKeyboard,
  permissionSelection,
  resolvedPermissionText,
  stalePromptKeyboard,
  describeTool,
} from "./telegram.js";
import { describe, expect, it, vi } from "vitest";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { sanitizePermissionText } from "./redact.js";
import {
  createLockData,
  isAllowed,
  lockOwnedByCurrentProcess,
  enqueuePrompt,
  clearPromptQueue,
  setPendingPermission,
  getPendingPermission,
  cancelPendingPermissionState,
  resetRuntimeStateForTests,
  type AccessState,
} from "./state.js";
import { buildGrokChildEnv } from "./acp-client.js";
import { parseEnvironment, resolveGrokBinary } from "./config.js";
import { assertRuntimePathsOutsideBuildOutput } from "./path-safety.js";
import {
  buildPromptBlocks,
  formatPlanText,
  downloadTelegramFileBytes,
  writeInboxFile,
  cleanupInboxFiles,
  isAllowedMime,
  defaultMimeAllowlist,
  captureRootIdentity,
  validateRootIdentity,
  ensureInboxDir,
} from "./media.js";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Telegram rendering", () => {
  it("chunks text without losing content", () => {
    const text = `${"a".repeat(12)}\n\n${"b".repeat(12)}`;
    const chunks = chunkMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n").replace(/\n+/g, "\n")).toContain("a".repeat(12));
    expect(chunks.join("\n\n")).toContain("b".repeat(12));
  });

  it("escapes untrusted HTML while preserving supported markdown", () => {
    expect(markdownToTelegramHtml("**safe** <script>x</script>"))
      .toContain("<b>safe</b> &lt;script&gt;x&lt;/script&gt;");
  });

  it("only renders links with explicitly safe schemes", () => {
    const rendered = markdownToTelegramHtml(
      "[web](https://example.com) [bot](tg://user?id=42) [mail](mailto:a@example.com) [bad](javascript:alert(1)) [data](data:text/html,x) [vb](vbscript:msgbox(1))",
    );
    expect(rendered).toContain('<a href="https://example.com">web</a>');
    expect(rendered).toContain('<a href="tg://user?id=42">bot</a>');
    expect(rendered).toContain('<a href="mailto:a@example.com">mail</a>');
    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).not.toContain('href="data:');
    expect(rendered).not.toContain('href="vbscript:');
    expect(rendered).toContain("bad (javascript:alert(1)");
  });

  it("redacts secrets from tool progress descriptions", () => {
    expect(describeTool(
      "Run command",
      { command: "TOKEN=xai-secret npm test" },
    )).not.toContain("xai-secret");
    expect(describeTool("Run command", "API_KEY=xai-secret npm test"))
      .not.toContain("xai-secret");
  });
});

describe("Telegram permission rendering", () => {
  const options: PermissionOption[] = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];

  it("exposes one-time and durable ACP choices instead of collapsing them", () => {
    expect(permissionKeyboard("request-1", options)).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Allow once", callback_data: "grok:o:request-1:0" },
          { text: "✅ Allow for session", callback_data: "grok:o:request-1:1" },
        ],
        [{ text: "❌ Reject once", callback_data: "grok:o:request-1:2" }],
      ],
    });
  });

  it("selects the exact durable option chosen by the owner", () => {
    expect(permissionSelection(options, 1)).toEqual({
      decision: { outcome: { outcome: "selected", optionId: "always" } },
      label: "✅ Allowed for session",
    });
  });

  it("renders resolved and stale cards as final states", () => {
    expect(resolvedPermissionText("Edit `src/app.ts`", "✅ Allowed once"))
      .toBe("✅ Allowed once\n\nEdit `src/app.ts`\n\nDecision recorded.");
    expect(finalizeExistingPermissionText(
      "⚠️ Grok Build needs approval\n\nRun tests\n\nTap a button or reply approve/reject.",
      "⌛ Approval expired",
    )).toBe("⌛ Approval expired\n\nRun tests\n\nNo action was approved.");
  });
});

describe("redaction", () => {
  it("redacts Telegram and API-like credentials", () => {
    const result = sanitizePermissionText(
      "TOKEN=secret-value 123456789:ABCDEFGHIJKLMNOPQRSTUVWX «redacted:ghp_…» Bearer abcdefghijklmnop DATABASE_URL=postgres://user:pass@example/db",
    );
    expect(result).not.toContain("secret-value");
    expect(result).not.toContain("ABCDEFGHIJKLMNOP");
    expect(result).not.toContain("ghp_abc");
    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("user:pass");
    expect(result).toContain("[REDACTED]");
  });
});

describe("Grok subprocess environment", () => {
  it("disables Claude-compatible MCPs and hooks without leaking bridge secrets", () => {
    const childEnv = buildGrokChildEnv({
      HOME: "/root",
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      XAI_API_KEY: "xai-secret",
      GROK_CLAUDE_MCPS_ENABLED: "true",
      GROK_CLAUDE_HOOKS_ENABLED: "true",
    });

    expect(childEnv.HOME).toBe("/root");
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.GROK_CLAUDE_MCPS_ENABLED).toBe("false");
    expect(childEnv.GROK_CLAUDE_HOOKS_ENABLED).toBe("false");
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(childEnv.XAI_API_KEY).toBeUndefined();
  });
});

describe("access and locks", () => {
  it("authorizes immutable numeric IDs as strings", () => {
    const access: AccessState = { allowedUsers: ["42"], pending: {} };
    expect(isAllowed(access, 42)).toBe(true);
    expect(isAllowed(access, 43)).toBe(false);
  });

  it("atomically cancels and clears a pending permission", () => {
    const resolve = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    setPendingPermission({
      id: "permission-1",
      kind: "tool",
      summary: "Run command",
      startedAt: new Date().toISOString(),
      timer,
      resolve,
      messages: [],
      connectionGeneration: 1,
      promptEpoch: 1,
    });

    const cancelled = cancelPendingPermissionState();

    expect(cancelled?.id).toBe("permission-1");
    expect(getPendingPermission()).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
    resetRuntimeStateForTests();
  });

  it("does not let stale connection or prompt generations cancel a current permission", () => {
    const resolve = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    setPendingPermission({
      id: "permission-current",
      kind: "tool",
      summary: "Run current command",
      startedAt: new Date().toISOString(),
      timer,
      resolve,
      messages: [],
      connectionGeneration: 7,
      promptEpoch: 11,
    });

    expect(cancelPendingPermissionState(6, 11)).toBeNull();
    expect(cancelPendingPermissionState(7, 10)).toBeNull();
    expect(getPendingPermission()?.id).toBe("permission-current");
    expect(resolve).not.toHaveBeenCalled();

    expect(cancelPendingPermissionState(7, 11)?.id).toBe("permission-current");
    expect(getPendingPermission()).toBeNull();
    expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: "cancelled" } });
    resetRuntimeStateForTests();
  });

  it("recognizes a lock owned by this process", () => {
    const lock = createLockData("test-session");
    expect(lockOwnedByCurrentProcess(lock, "test-session")).toBe(true);
    expect(lockOwnedByCurrentProcess(lock, "other-session")).toBe(false);
  });
});

describe("media and prompt blocks", () => {
  it("rejects a session root whose pathname is replaced", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-root-"));
    try {
      const rootPath = join(parent, "root");
      const movedPath = join(parent, "moved");
      const outsidePath = join(parent, "outside");
      mkdirSync(rootPath);
      mkdirSync(outsidePath);
      const identity = captureRootIdentity(rootPath);
      renameSync(rootPath, movedPath);
      symlinkSync(outsidePath, rootPath);
      expect(() => validateRootIdentity(identity)).toThrow(/identity changed/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked inbox control file", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-inbox-control-"));
    try {
      const root = captureRootIdentity(parent);
      const dir = ensureInboxDir(root);
      const outside = join(parent, "outside.txt");
      writeFileSync(outside, "sentinel");
      rmSync(join(dir, ".gitignore"), { force: true });
      symlinkSync(outside, join(dir, ".gitignore"));

      expect(() => ensureInboxDir(root)).toThrow();
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a hard-linked inbox control file before truncation", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-inbox-hardlink-"));
    try {
      const root = captureRootIdentity(parent);
      const dir = ensureInboxDir(root);
      const outside = join(parent, "outside.txt");
      writeFileSync(outside, "sentinel");
      rmSync(join(dir, ".gitignore"), { force: true });
      linkSync(outside, join(dir, ".gitignore"));

      expect(() => ensureInboxDir(root)).toThrow(/singly linked/);
      expect(readFileSync(outside, "utf8")).toBe("sentinel");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("repairs permissive inbox directory permissions", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-inbox-mode-"));
    try {
      const root = captureRootIdentity(parent);
      const dir = join(parent, ".tg-inbox");
      mkdirSync(dir, { mode: 0o777 });
      chmodSync(dir, 0o777);

      ensureInboxDir(root);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects reads and cleanup after the inbox directory is swapped", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-inbox-swap-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const root = captureRootIdentity(parent);
      const file = writeInboxFile(root, "note.txt", Buffer.from("trusted"));
      const inbox = join(parent, ".tg-inbox");
      const moved = join(parent, "moved-inbox");
      const outside = join(parent, "outside");
      renameSync(inbox, moved);
      mkdirSync(outside);
      const outsideFile = join(outside, file.name);
      writeFileSync(outsideFile, "outside");
      symlinkSync(outside, inbox);

      expect(() => buildPromptBlocks({ text: "inspect", files: [file], capabilities: {} }))
        .toThrow();
      cleanupInboxFiles([file]);
      expect(existsSync(outsideFile)).toBe(true);
      expect(readFileSync(outsideFile, "utf8")).toBe("outside");
    } finally {
      warning.mockRestore();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects same-inode attachment tampering after admission", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-inbox-content-"));
    try {
      const file = writeInboxFile(captureRootIdentity(parent), "note.txt", Buffer.from("trusted"));
      writeFileSync(file.path, "changed", { mode: 0o600 });

      expect(() => buildPromptBlocks({ text: "inspect", files: [file], capabilities: {} }))
        .toThrow(/content changed/);
      cleanupInboxFiles([file]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stops chunked Telegram downloads at the configured byte limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    try {
      await expect(downloadTelegramFileBytes("fake-token", "file.bin", 5, 1_000))
        .rejects.toThrow(/File too large/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds image content blocks when the agent advertises image prompts", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-blocks-"));
    try {
      const file = writeInboxFile(captureRootIdentity(dir), "shot.png", Buffer.from("fake-png"));
      file.mime = "image/png";
      const { blocks } = buildPromptBlocks({
        text: "what is this?",
        files: [file],
        capabilities: { image: true },
      });
      expect(blocks.some((b) => b.type === "image")).toBe(true);
      expect(blocks.some((b) => b.type === "text" && b.text.includes("what is this"))).toBe(true);
      cleanupInboxFiles([file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retires the admitted opened file without touching a swapped pathname", () => {
    const parent = mkdtempSync(join(tmpdir(), "grok-tg-cleanup-swap-"));
    try {
      const root = captureRootIdentity(parent);
      const file = writeInboxFile(root, "note.txt", Buffer.from("trusted"));
      const retiredPath = join(parent, ".tg-inbox", "retired-original");
      renameSync(file.path, retiredPath);
      writeFileSync(file.path, "replacement");

      cleanupInboxFiles([file]);

      expect(readFileSync(file.path, "utf8")).toBe("replacement");
      const retired = statSync(retiredPath);
      expect(retired.size).toBe(0);
      expect(retired.mode & 0o777).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps fallback resource links bound to the admitted file descriptor", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-descriptor-link-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const file = writeInboxFile(captureRootIdentity(dir), "note.txt", Buffer.from("trusted"));
      const { blocks } = buildPromptBlocks({ text: "inspect", files: [file], capabilities: {} });
      const link = blocks.find((block) => block.type === "resource_link");
      expect(link?.type).toBe("resource_link");
      if (!link || link.type !== "resource_link") throw new Error("resource link missing");
      const descriptorPath = new URL(link.uri).pathname;

      renameSync(join(dir, ".tg-inbox"), join(dir, ".tg-inbox-moved"));
      expect(readFileSync(descriptorPath, "utf8")).toBe("trusted");

      cleanupInboxFiles([file]);
      expect(() => readFileSync(descriptorPath)).toThrow();
    } finally {
      warning.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to resource_link when image capability is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-link-"));
    try {
      const file = writeInboxFile(captureRootIdentity(dir), "shot.png", Buffer.from("fake-png"));
      file.mime = "image/png";
      const { blocks } = buildPromptBlocks({
        text: "inspect",
        files: [file],
        capabilities: {},
      });
      expect(blocks.some((b) => b.type === "resource_link")).toBe(true);
      expect(blocks.every((b) => b.type !== "image")).toBe(true);
      cleanupInboxFiles([file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects disallowed MIME types", () => {
    expect(isAllowedMime("image/png", defaultMimeAllowlist())).toBe(true);
    expect(isAllowedMime("application/x-msdownload", defaultMimeAllowlist())).toBe(false);
  });

  it("formats plan entries for Telegram", () => {
    expect(formatPlanText([
      { content: "Explore", status: "completed" },
      { content: "Implement", status: "in_progress" },
    ])).toContain("Explore");
  });
});

describe("prompt queue and stale keyboard", () => {
  it("enforces queue capacity", () => {
    resetRuntimeStateForTests();
    const first = enqueuePrompt({
      chatId: 1,
      userId: 1,
      messageId: 1,
      text: "a",
      replyContext: null,
      inboxFiles: [],
    }, 1);
    const second = enqueuePrompt({
      chatId: 1,
      userId: 1,
      messageId: 2,
      text: "b",
      replyContext: null,
      inboxFiles: [],
    }, 1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    clearPromptQueue();
    resetRuntimeStateForTests();
  });

  it("exposes cancel/keep buttons for stalled prompts", () => {
    expect(stalePromptKeyboard("prompt-1")).toEqual({
      inline_keyboard: [[
        { text: "Cancel", callback_data: "grok:s:prompt-1:cancel" },
        { text: "Keep waiting", callback_data: "grok:s:prompt-1:keep" },
      ]],
    });
  });
});

describe("public repository safety defaults", () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: "123456789:test-token-not-real",
    GROK_CWD: process.cwd(),
  };

  it("caps shutdown-related configuration at the supported safety budget", () => {
    expect(() => parseEnvironment({ ...baseEnv, API_TIMEOUT_MS: "30001" })).toThrow();
    expect(() => parseEnvironment({ ...baseEnv, CANCEL_WAIT_MS: "30001" })).toThrow();
    expect(() => parseEnvironment({ ...baseEnv, TELEGRAM_RETRY_MAX: "6" })).toThrow();
    expect(parseEnvironment({
      ...baseEnv,
      API_TIMEOUT_MS: "30000",
      CANCEL_WAIT_MS: "30000",
      TELEGRAM_RETRY_MAX: "5",
    })).toMatchObject({
      API_TIMEOUT_MS: 30_000,
      CANCEL_WAIT_MS: 30_000,
      TELEGRAM_RETRY_MAX: 5,
    });
  });

  it("resolves Grok from the current user's home without a root-specific path", () => {
    const checked: string[] = [];
    const resolved = resolveGrokBinary("grok", "/home/example", (candidate) => {
      checked.push(candidate);
      return candidate === "/home/example/.grok/bin/grok";
    });
    expect(resolved).toBe("/home/example/.grok/bin/grok");
    expect(checked).not.toContain("/root/.grok/bin/grok");
  });

  it("rejects runtime state or agent workspaces inside build output", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-clean-guard-"));
    const buildOutput = join(root, "dist");
    const safeState = join(root, "state");
    const safeCwd = join(root, "workspace");
    mkdirSync(buildOutput);
    mkdirSync(safeState);
    mkdirSync(safeCwd);
    const buildAlias = join(root, "build-alias");
    symlinkSync(buildOutput, buildAlias);
    try {
      expect(() => assertRuntimePathsOutsideBuildOutput(
        join(buildOutput, "state"),
        safeCwd,
        buildOutput,
      )).toThrow(/STATE_DIR/);
      expect(() => assertRuntimePathsOutsideBuildOutput(
        safeState,
        join(buildOutput, "workspace"),
        buildOutput,
      )).toThrow(/GROK_CWD/);
      expect(() => assertRuntimePathsOutsideBuildOutput(
        join(buildAlias, "state"),
        safeCwd,
        buildOutput,
      )).toThrow(/STATE_DIR/);
      expect(() => assertRuntimePathsOutsideBuildOutput(
        safeState,
        safeCwd,
        buildOutput,
      )).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps package cleanup away from runtime identity and state", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { private?: boolean; scripts?: { clean?: string } };
    expect(packageJson.private).toBe(true);
    expect(packageJson.scripts?.clean).toBe("tsx scripts/clean.ts");
    expect(packageJson.scripts?.clean).not.toMatch(/state|access\.json|lock\.json|health\.json/i);
  });
});
