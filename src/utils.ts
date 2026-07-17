import { randomBytes } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function messageSafeRandom(): string {
  return randomBytes(8).toString("hex");
}

export function parseTimeMs(value: string | null | undefined): number | null {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : null;
}

export function ageMs(value: string | null | undefined): number | null {
  const ts = parseTimeMs(value);
  return ts == null ? null : Math.max(0, Date.now() - ts);
}

export function formatAge(value: string | number | null | undefined): string {
  const ms = typeof value === "number" ? value : ageMs(typeof value === "string" ? value : null);
  if (ms == null) return "never";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
