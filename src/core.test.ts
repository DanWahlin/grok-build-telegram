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
  resetRuntimeStateForTests,
  type AccessState,
} from "./state.js";
import { buildGrokChildEnv } from "./acp-client.js";
import {
  buildPromptBlocks,
  formatPlanText,
  resolveSafePath,
  resolveSafeArtifactPath,
  artifactFitsLimit,
  readSafeArtifactFile,
  extractPathsFromUnknown,
  downloadTelegramFileBytes,
  writeInboxFile,
  cleanupInboxFiles,
  isAllowedMime,
  defaultMimeAllowlist,
} from "./media.js";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

  it("recognizes a lock owned by this process", () => {
    const lock = createLockData("test-session");
    expect(lockOwnedByCurrentProcess(lock, "test-session")).toBe(true);
    expect(lockOwnedByCurrentProcess(lock, "other-session")).toBe(false);
  });
});

describe("media and prompt blocks", () => {
  it("keeps resolved paths inside the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-path-"));
    try {
      const inside = join(dir, "note.txt");
      writeFileSync(inside, "hi");
      expect(resolveSafePath(inside, dir)).toBe(inside);
      expect(resolveSafePath("/etc/passwd", dir)).toBeNull();
      expect(resolveSafePath(join(dir, "../outside.txt"), dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revalidates outbound artifacts and blocks sensitive or replaced paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-artifact-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "grok-tg-artifact-outside-"));
    try {
      const report = join(dir, "report.pdf");
      const secret = join(dir, ".env");
      const outside = join(outsideDir, "outside.pdf");
      const swapped = join(dir, "swapped.pdf");
      writeFileSync(report, "report");
      writeFileSync(secret, "TOKEN=secret");
      writeFileSync(outside, "outside");
      symlinkSync(outside, swapped);

      expect(resolveSafeArtifactPath(report, dir)).toBe(report);
      expect(resolveSafeArtifactPath(secret, dir)).toBeNull();
      expect(resolveSafeArtifactPath(swapped, dir)).toBeNull();
      expect(artifactFitsLimit(report, 6)).toBe(true);
      expect(artifactFitsLimit(report, 5)).toBe(false);
      expect(readSafeArtifactFile(report, dir, 6).bytes.toString()).toBe("report");
      expect(() => readSafeArtifactFile(report, dir, 5)).toThrow(/Artifact too large/);
      expect(() => readSafeArtifactFile(swapped, dir, 100)).toThrow(/outside the active CWD/);
      expect(extractPathsFromUnknown({ path: report }, dir)).toEqual([report]);
      expect(extractPathsFromUnknown({ message: `saved ${report}` }, dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
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
      const file = writeInboxFile(dir, "shot.png", Buffer.from("fake-png"));
      file.mime = "image/png";
      const { blocks } = buildPromptBlocks({
        text: "what is this?",
        files: [file],
        capabilities: { image: true },
      });
      expect(blocks.some((b) => b.type === "image")).toBe(true);
      expect(blocks.some((b) => b.type === "text" && b.text.includes("what is this"))).toBe(true);
      cleanupInboxFiles([file.path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to resource_link when image capability is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tg-link-"));
    try {
      const file = writeInboxFile(dir, "shot.png", Buffer.from("fake-png"));
      file.mime = "image/png";
      const { blocks } = buildPromptBlocks({
        text: "inspect",
        files: [file],
        capabilities: {},
      });
      expect(blocks.some((b) => b.type === "resource_link")).toBe(true);
      expect(blocks.every((b) => b.type !== "image")).toBe(true);
      cleanupInboxFiles([file.path]);
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
