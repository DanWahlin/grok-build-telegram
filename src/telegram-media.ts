import type { Message } from "grammy/types";
import { basename } from "node:path";
import type { Config } from "./config.js";
import { sanitizedError } from "./redact.js";
import {
  downloadTelegramFileBytes,
  guessMime,
  isAllowedMime,
  writeInboxFile,
  type InboxFile,
  type RootIdentity,
} from "./media.js";
import { getTelegramToken, getFilePath } from "./telegram-api.js";

interface MediaExtraction {
  files: InboxFile[];
  errors: string[];
}

async function downloadAttachment(
  config: Config,
  root: RootIdentity,
  fileId: string,
  originalName: string,
  telegramMime?: string | null,
  telegramSize?: number,
): Promise<InboxFile> {
  const name = originalName || "attachment";
  const mime = guessMime(name, telegramMime);
  if (!isAllowedMime(mime, config.mimeAllowlist)) {
    throw new Error(`MIME type not allowed: ${mime}`);
  }
  if (telegramSize != null && telegramSize > config.MEDIA_MAX_BYTES) {
    throw new Error(`File too large (${telegramSize} bytes; max ${config.MEDIA_MAX_BYTES})`);
  }
  const remotePath = await getFilePath(fileId);
  const bytes = await downloadTelegramFileBytes(
    getTelegramToken(),
    remotePath,
    config.MEDIA_MAX_BYTES,
    config.API_TIMEOUT_MS,
  );
  const file = writeInboxFile(root, name || basename(remotePath), bytes);
  file.mime = mime;
  return file;
}

export async function extractMediaFromMessage(
  config: Config,
  message: Message,
  root: RootIdentity,
): Promise<MediaExtraction> {
  const files: InboxFile[] = [];
  const errors: string[] = [];

  try {
    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      if (largest?.file_id) {
        files.push(await downloadAttachment(
          config,
          root,
          largest.file_id,
          "photo.jpg",
          "image/jpeg",
          largest.file_size,
        ));
      }
    }
    if (message.document?.file_id) {
      const doc = message.document;
      files.push(await downloadAttachment(
        config,
        root,
        doc.file_id,
        doc.file_name || "document",
        doc.mime_type,
        doc.file_size,
      ));
    }
    if (message.voice?.file_id) {
      files.push(await downloadAttachment(
        config,
        root,
        message.voice.file_id,
        "voice.ogg",
        message.voice.mime_type || "audio/ogg",
        message.voice.file_size,
      ));
    }
    if (message.audio?.file_id) {
      files.push(await downloadAttachment(
        config,
        root,
        message.audio.file_id,
        message.audio.file_name || "audio",
        message.audio.mime_type,
        message.audio.file_size,
      ));
    }
    if (message.video?.file_id) {
      files.push(await downloadAttachment(
        config,
        root,
        message.video.file_id,
        message.video.file_name || "video.mp4",
        message.video.mime_type || "video/mp4",
        message.video.file_size,
      ));
    }
  } catch (error: unknown) {
    errors.push(sanitizedError(error));
  }

  return { files, errors };
}

export function replyContextFromMessage(
  message: Message,
): string | null {
  const reply = message.reply_to_message;
  if (!reply) return null;
  const parts: string[] = [];
  if (reply.text) parts.push(reply.text);
  if (reply.caption) parts.push(reply.caption);
  if (reply.photo) parts.push("[photo]");
  if (reply.document) parts.push(`[document: ${reply.document.file_name || "file"}]`);
  return parts.join("\n").slice(0, 2000) || null;
}

export function messageHasMedia(message: Message): boolean {
  return Boolean(
    message.photo?.length
      || message.document
      || message.voice
      || message.audio
      || message.video,
  );
}
