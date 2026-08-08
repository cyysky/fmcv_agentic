/** Shared date formatting for the UI (Round 89): local-time display for
 *  human-facing timestamps, with the raw ISO string as a safe fallback when
 *  the input is missing or unparseable. Single source of truth so pages
 *  (cron, agent) stop formatting the same value differently. */

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}
