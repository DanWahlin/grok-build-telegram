const REDACT_PATTERNS: RegExp[] = [
  /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi,
  /\b(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|KEY|BEARER)\s*[=:]\s*[^\s,;]+/gi,
  /([A-Za-z_][A-Za-z0-9_]*(?:secret|token|password|key|auth)[A-Za-z0-9_]*)\s*=\s*[^\s,;\)]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi,
];

export function sanitizePermissionText(text: string | null | undefined, maxLen = 1800): string {
  let s = String(text || "permission request");
  for (const re of REDACT_PATTERNS) {
    s = s.replace(re, "[REDACTED]");
  }
  // Also strip common sensitive keys in objects when stringified
  s = s.replace(/\b(api[_-]?key|access[_-]?token|private[_-]?key)\b[^,\n]*/gi, "$1=[REDACTED]");
  return s.slice(0, maxLen).trim() || "permission request";
}

export function redactForLog(obj: unknown): string {
  try {
    const s = JSON.stringify(obj, (k, v) => {
      if (typeof k === "string" && /(token|secret|key|password|auth|cookie)/i.test(k)) return "[REDACTED]";
      return v;
    });
    return sanitizePermissionText(s, 2000);
  } catch {
    return "[unstringifiable]";
  }
}
