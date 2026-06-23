/**
 * sentinel-output-buffer — Phase D voice-OUT relay for the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). The Sentinel's Claude session (via a Stop
 * hook) POSTs its spoken `<say>…</say>` text to `/api/operator/sentinel-output`,
 * which buffers it here; the webview drains it (GET) and calls `speak()`/TTS.
 *
 * LOCAL APP USER ONLY (owner constraint): a small in-memory FIFO for the one
 * local dock — NOT the P2P voice-channel system. Process-local + ephemeral by
 * design (spoken lines are transient; nothing durable belongs here).
 */
const MAX = 32;
const buffer: string[] = [];

/** Append a spoken line (from the Sentinel's Stop hook). No-ops on blank. */
export function pushSentinelSay(text: string): void {
  const t = text.trim();
  if (!t) return;
  buffer.push(t);
  while (buffer.length > MAX) buffer.shift();
}

/** Return + clear all buffered spoken lines (the webview drains on poll). */
export function drainSentinelSays(): string[] {
  const out = buffer.slice();
  buffer.length = 0;
  return out;
}
