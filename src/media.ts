import {
  mkdirSync,
  writeFileSync,
  readSync,
  lstatSync,
  statSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  ftruncateSync,
  constants,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { sanitizedError } from "./redact.js";
import { messageSafeRandom } from "./utils.js";

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface InboxFile {
  path: string;
  name: string;
  mime: string;
  originalName: string;
  size: number;
  rootPath: string;
  rootDev: bigint;
  rootIno: bigint;
  inboxDev: bigint;
  inboxIno: bigint;
  fileDev: bigint;
  fileIno: bigint;
  sha256: string;
  descriptorFd: number | null;
}

export interface RootIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export function captureRootIdentity(cwd: string): RootIdentity {
  const path = realpathSync(resolve(cwd));
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory() || lstatSync(path, { bigint: true }).isSymbolicLink()) {
    throw new Error("Session CWD must be a real directory");
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

export function validateRootIdentity(root: RootIdentity): void {
  const current = lstatSync(root.path, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== root.dev || current.ino !== root.ino
    || realpathSync(root.path) !== root.path) {
    throw new Error("Session CWD identity changed");
  }
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
};

const DEFAULT_MIME_ALLOW = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/zip",
];

export function defaultMimeAllowlist(): string[] {
  return [...DEFAULT_MIME_ALLOW];
}

export function parseMimeAllowlist(value: string | undefined): string[] {
  if (!value || !value.trim()) return defaultMimeAllowlist();
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function parseCwdAllowlist(value: string | undefined, primaryCwd: string): string[] {
  const paths = new Set<string>();
  paths.add(resolve(primaryCwd));
  if (value) {
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      paths.add(resolve(trimmed));
    }
  }
  return [...paths];
}

export function guessMime(fileName: string, telegramMime?: string | null): string {
  if (telegramMime && telegramMime !== "application/octet-stream") {
    return telegramMime.toLowerCase();
  }
  const ext = extname(fileName).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

export function isAllowedMime(mime: string, allowlist: string[]): boolean {
  const normalized = mime.toLowerCase();
  if (allowlist.includes(normalized)) return true;
  // Allow type/* wildcards in allowlist
  const [type] = normalized.split("/");
  return allowlist.includes(`${type}/*`);
}

interface InboxDirectoryHandle {
  fd: number;
  dir: string;
  descriptorPath: string;
  dev: bigint;
  ino: bigint;
}

function openInboxDirectory(root: RootIdentity): InboxDirectoryHandle {
  validateRootIdentity(root);
  const dir = join(root.path, ".tg-inbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    const current = lstatSync(dir, { bigint: true });
    if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
      || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("Inbox directory identity changed");
    }
    fchmodSync(fd, 0o700);
    const descriptorPath = `/proc/self/fd/${fd}`;
    if (realpathSync(descriptorPath) !== dir) {
      throw new Error("Inbox directory is not bound to the authorized CWD");
    }
    validateRootIdentity(root);
    return { fd, dir, descriptorPath, dev: opened.dev, ino: opened.ino };
  } catch (error: unknown) {
    closeSync(fd);
    throw error;
  }
}

function writeInboxGitignore(handle: InboxDirectoryHandle): void {
  const path = join(handle.descriptorPath, ".gitignore");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error("Inbox .gitignore must be a singly linked regular file");
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, "*\n");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function ensureInboxDir(root: RootIdentity): string {
  const handle = openInboxDirectory(root);
  try {
    writeInboxGitignore(handle);
    return handle.dir;
  } finally {
    closeSync(handle.fd);
  }
}

export function safeInboxFileName(originalName: string): string {
  const base = basename(originalName || "file").replace(/[^\w.\-()+ ]+/g, "_").slice(0, 80);
  const safe = base || "file";
  return `${messageSafeRandom().slice(0, 10)}_${safe}`;
}

function readInboxFile(file: InboxFile): Buffer {
  const root: RootIdentity = { path: file.rootPath, dev: file.rootDev, ino: file.rootIno };
  const handle = openInboxDirectory(root);
  try {
    if (handle.dev !== file.inboxDev || handle.ino !== file.inboxIno) {
      throw new Error("Inbox directory identity changed after admission");
    }
    const fd = file.descriptorFd;
    if (fd === null) throw new Error("Inbox file descriptor is no longer available");
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== file.fileDev || opened.ino !== file.fileIno
      || opened.size !== BigInt(file.size)) {
      throw new Error("Inbox file identity changed after admission");
    }
    const data = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) throw new Error("Inbox file ended before its admitted size");
      offset += count;
    }
    if (createHash("sha256").update(data).digest("hex") !== file.sha256) {
      throw new Error("Inbox file content changed after admission");
    }
    return data;
  } finally {
    closeSync(handle.fd);
  }
}

export function buildPromptBlocks(options: {
  text: string;
  files: InboxFile[];
  capabilities: PromptCapabilities;
}): { blocks: ContentBlock[]; notes: string[] } {
  const blocks: ContentBlock[] = [];
  const notes: string[] = [];
  const text = options.text.trim() || (options.files.length
    ? "User sent media. Please inspect the attached files."
    : "User sent an empty message.");
  blocks.push({ type: "text", text });

  for (const file of options.files) {
    const buf = readInboxFile(file);
    const descriptorPath = file.descriptorFd === null
      ? null
      : `/proc/${process.pid}/fd/${file.descriptorFd}`;
    if (!descriptorPath) throw new Error("Inbox file descriptor is no longer available");
    const b64 = buf.toString("base64");
    if (isImageMime(file.mime) && options.capabilities.image) {
      blocks.push({
        type: "image",
        data: b64,
        mimeType: file.mime,
        uri: `file://${descriptorPath}`,
      });
      notes.push(`Attached image: ${file.originalName} (${descriptorPath})`);
    } else if (isAudioMime(file.mime) && options.capabilities.audio) {
      blocks.push({
        type: "audio",
        data: b64,
        mimeType: file.mime,
      });
      notes.push(`Attached audio: ${file.originalName} (${descriptorPath})`);
    } else if (options.capabilities.embeddedContext) {
      if (file.mime.startsWith("text/") || file.mime === "application/json") {
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${descriptorPath}`,
            mimeType: file.mime,
            text: buf.toString("utf8").slice(0, 200_000),
          },
        });
      } else {
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${descriptorPath}`,
            mimeType: file.mime,
            blob: b64,
          },
        });
      }
      notes.push(`Embedded resource: ${file.originalName} (${descriptorPath})`);
    } else {
      // Baseline: resource_link + path in text so agent can open via tools
      blocks.push({
        type: "resource_link",
        name: file.originalName,
        uri: `file://${descriptorPath}`,
        mimeType: file.mime,
        size: file.size,
        description: `Telegram attachment saved at ${descriptorPath}`,
      });
      notes.push(`Attachment saved for tools: ${descriptorPath}`);
    }
  }

  if (notes.length && options.files.length) {
    // Reinforce paths for agents that ignore resource links
    blocks.push({
      type: "text",
      text: `Attachment paths on disk:\n${notes.map((n) => `- ${n}`).join("\n")}`,
    });
  }

  return { blocks, notes };
}

export function cleanupInboxFiles(files: InboxFile[]): void {
  for (const file of files) {
    const descriptorFd = file.descriptorFd;
    file.descriptorFd = null;
    if (descriptorFd === null) continue;
    try {
      const opened = fstatSync(descriptorFd, { bigint: true });
      if (!opened.isFile() || opened.dev !== file.fileDev || opened.ino !== file.fileIno) {
        throw new Error("Inbox file descriptor identity changed before cleanup");
      }
      // Node does not expose unlinkat(AT_EMPTY_PATH). Erase the admitted opened
      // object instead of unlinking a reusable pathname that can be swapped.
      ftruncateSync(descriptorFd, 0);
      fchmodSync(descriptorFd, 0o000);
    } catch (error: unknown) {
      console.warn(`[MEDIA] Failed to retire inbox file: ${sanitizedError(error)}`);
    } finally {
      try {
        closeSync(descriptorFd);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EBADF") {
          console.warn(`[MEDIA] Failed to close inbox file descriptor: ${sanitizedError(error)}`);
        }
      }
    }
  }
}

export function writeInboxFile(
  root: RootIdentity,
  originalName: string,
  data: Buffer,
): InboxFile {
  const handle = openInboxDirectory(root);
  const name = safeInboxFileName(originalName);
  const descriptorPath = join(handle.descriptorPath, name);
  const path = join(handle.dir, name);
  let fd: number | null = null;
  let retained = false;
  try {
    writeInboxGitignore(handle);
    fd = openSync(
      descriptorPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, data);
    fchmodSync(fd, 0o600);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size !== BigInt(data.length)) {
      throw new Error("Inbox file write did not produce the expected regular file");
    }
    validateRootIdentity(root);
    const mime = guessMime(originalName);
    const result: InboxFile = {
      path,
      name,
      mime,
      originalName: basename(originalName || name),
      size: data.length,
      rootPath: root.path,
      rootDev: root.dev,
      rootIno: root.ino,
      inboxDev: handle.dev,
      inboxIno: handle.ino,
      fileDev: opened.dev,
      fileIno: opened.ino,
      sha256: createHash("sha256").update(data).digest("hex"),
      descriptorFd: fd,
    };
    retained = true;
    return result;
  } catch (error: unknown) {
    if (fd !== null) {
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.isFile()) {
          ftruncateSync(fd, 0);
          fchmodSync(fd, 0o000);
        }
      } catch {
        // The descriptor is still closed below; never unlink a reusable pathname.
      }
    }
    throw error;
  } finally {
    if (fd !== null && !retained) closeSync(fd);
    closeSync(handle.fd);
  }
}

export function formatPlanText(
  entries: Array<{ content: string; status: string; priority?: string }>,
): string {
  if (!entries.length) return "📋 Plan (empty)";
  const lines = entries.map((entry, index) => {
    const icon = entry.status === "completed"
      ? "✅"
      : entry.status === "in_progress"
        ? "▶️"
        : "⬜";
    return `${icon} ${index + 1}. ${entry.content}`;
  });
  return `📋 Plan (${entries.length} steps)\n${lines.join("\n")}`;
}

export function formatPlanUpdateText(plan: {
  type?: string;
  entries?: Array<{ content: string; status: string }>;
  content?: string;
  planId?: string;
}): string {
  if (plan.type === "items" && plan.entries) {
    return formatPlanText(plan.entries);
  }
  if (plan.type === "markdown" && plan.content) {
    return `📋 Plan\n${plan.content.slice(0, 3500)}`;
  }
  if (plan.type === "file" && plan.content) {
    return `📋 Plan file updated\n${plan.content.slice(0, 3500)}`;
  }
  if (plan.entries) return formatPlanText(plan.entries);
  if (plan.content) return `📋 Plan\n${plan.content.slice(0, 3500)}`;
  return "📋 Plan updated";
}

export async function downloadTelegramFileBytes(
  token: string,
  filePath: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`File too large (${contentLength} bytes; max ${maxBytes})`);
  }
  if (!res.body) throw new Error("Telegram file download returned no body");
  const chunks: Buffer[] = [];
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`File too large (${total} bytes received; max ${maxBytes})`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
