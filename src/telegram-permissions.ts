import type {
  InlineKeyboardMarkup,
} from "grammy/types";
import type {
  PermissionOption,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const PERMISSION_LABELS: Record<PermissionOption["kind"], string> = {
  allow_once: "✅ Allowed once",
  allow_always: "✅ Allowed for session",
  reject_once: "❌ Rejected once",
  reject_always: "⛔ Always rejected",
};

const PERMISSION_BUTTON_LABELS: Record<PermissionOption["kind"], string> = {
  allow_once: "✅ Allow once",
  allow_always: "✅ Allow for session",
  reject_once: "❌ Reject once",
  reject_always: "⛔ Always reject",
};

export function permissionKeyboard(
  id: string,
  options: PermissionOption[],
): InlineKeyboardMarkup {
  const allows: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  const rejects: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  options.forEach((option, index) => {
    const button = {
      text: PERMISSION_BUTTON_LABELS[option.kind],
      callback_data: `grok:o:${id}:${index}`,
    };
    if (option.kind.startsWith("allow_")) allows.push(button);
    else rejects.push(button);
  });
  if (rejects.length === 0) {
    rejects.push({ text: "❌ Reject", callback_data: `grok:c:${id}` });
  }
  return { inline_keyboard: [allows, rejects].filter((row) => row.length > 0) };
}

export function stalePromptKeyboard(promptId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Cancel", callback_data: `grok:s:${promptId}:cancel` },
      { text: "Keep waiting", callback_data: `grok:s:${promptId}:keep` },
    ]],
  };
}

export function permissionSelection(
  options: PermissionOption[],
  index: number,
): { decision: RequestPermissionResponse; label: string } | null {
  const option = options[index];
  if (!option) return null;
  return {
    decision: { outcome: { outcome: "selected", optionId: option.optionId } },
    label: PERMISSION_LABELS[option.kind],
  };
}

export function permissionSelectionByKind(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): { decision: RequestPermissionResponse; label: string } | null {
  const option = kinds
    .map((kind) => options.find((candidate) => candidate.kind === kind))
    .find((candidate): candidate is PermissionOption => candidate !== undefined);
  if (!option) return null;
  return {
    decision: { outcome: { outcome: "selected", optionId: option.optionId } },
    label: PERMISSION_LABELS[option.kind],
  };
}

export function pendingPermissionText(summary: string): string {
  return `⚠️ Grok Build needs approval\n\n${summary}\n\nChoose an option below or reply approve/reject.`;
}

export function resolvedPermissionText(summary: string, label: string): string {
  return `${label}\n\n${summary}\n\nDecision recorded.`;
}

export function expiredPermissionText(summary: string): string {
  return `⌛ Approval expired\n\n${summary}\n\nNo action was approved.`;
}

export function finalizeExistingPermissionText(text: string | undefined, label: string): string {
  const summary = String(text || "Permission request")
    .replace(/^⚠️ Grok Build needs approval\s*/u, "")
    .replace(/\s*(?:Tap a button|Choose an option below).*$/su, "")
    .trim() || "Permission request";
  return label === "⌛ Approval expired"
    ? expiredPermissionText(summary)
    : resolvedPermissionText(summary, label);
}
