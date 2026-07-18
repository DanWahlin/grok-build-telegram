import { CHUNK_MAX } from "./config.js";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  const holds: string[] = [];
  function hold(html: string) {
    const i = holds.length;
    holds.push(html);
    return `\x00${i}\x00`;
  }
  let t = md;

  t = t.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    code = code.replace(/\n$/, "");
    const cls = lang ? ` class="language-${lang}"` : "";
    return hold(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  const renderLink = (text: string, url: string, image: boolean): string => {
    const label = image ? `[${text || "image"}]` : text;
    if (!isSafeLink(url)) return hold(`${escapeHtml(label)} (${escapeHtml(url)})`);
    return hold(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`);
  };
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) =>
    renderLink(alt, url, true));
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
    renderLink(text, url, false));

  t = escapeHtml(t);

  t = t.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  t = t.replace(/~~(.+?)~~/g, "<s>$1</s>");
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(/(?:^&gt;[ ]?.*$\n?)+/gm, (block) => {
    const lines = block.trimEnd().split("\n").map((l) => l.replace(/^&gt;[ ]?/, ""));
    return `<blockquote>${lines.join("\n")}</blockquote>\n`;
  });
  t = t.replace(/^-{3,}$/gm, "\u2500".repeat(20));
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => holds[parseInt(i)] || "");
  return t;
}

function isSafeLink(url: string): boolean {
  try {
    return ["http:", "https:", "tg:", "mailto:"].includes(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function chunkMessage(text: string, maxLen = CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
