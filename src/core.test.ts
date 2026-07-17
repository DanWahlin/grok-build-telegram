import { chunkMessage, markdownToTelegramHtml } from "./telegram.js";
import { describe, expect, it } from "vitest";
import { sanitizePermissionText } from "./redact.js";
import { createLockData, isAllowed, lockOwnedByCurrentProcess, type AccessState } from "./state.js";
import { buildGrokChildEnv } from "./acp-client.js";

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
