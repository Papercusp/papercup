/**
 * sentinel-output-buffer — Phase D voice-OUT relay for the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). The Sentinel calls the `voice:say` MCP
 * tool → `pushSentinelSay`; the webview voice runtime drains via
 * `drainSentinelSays` (GET /api/operator/sentinel-output poll) → `speak()`/TTS.
 *
 * ⚠ KNOWN LIMITATION (2026-06-22): this is a PROCESS-LOCAL in-memory FIFO, so it
 * only bridges a push+poll that hit the SAME operator process. Full voice-OUT
 * needs a CROSS-process store because the Sentinel's MCP operator (green `:3070`)
 * and the webview's operator differ — see plan Phase D. A PG-backed version
 * (table `harness_shared.sentinel_says` + migration) is the fix, but it was
 * deferred: the dev `:5432` DB is drifted from the committed schema, so a local
 * `pull-schema` can't cleanly regenerate `generated.ts`, and committing a
 * migration without that regen fails CI's drift gate (blocks deploys). Do the PG
 * swap on a clean DB. Async signatures are kept here so that swap is drop-in.
 * LOCAL APP USER ONLY (owner constraint) — not the P2P voice-channel system.
 */
const MAX = 32;
const buffer: string[] = [];

/** Append a spoken line (from the Sentinel's `voice:say`). No-ops on blank. */
export async function pushSentinelSay(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  buffer.push(t);
  while (buffer.length > MAX) buffer.shift();
}

/** Return + clear all buffered spoken lines (the webview drains on poll). */
export async function drainSentinelSays(): Promise<string[]> {
  const out = buffer.slice();
  buffer.length = 0;
  return out;
}
