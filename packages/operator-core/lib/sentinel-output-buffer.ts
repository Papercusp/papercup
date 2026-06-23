/**
 * sentinel-output-buffer — Phase D voice-OUT relay for the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). The Sentinel calls the `voice:say` MCP
 * tool, which `pushSentinelSay`s its spoken line; the webview voice runtime
 * drains it (`GET /api/operator/sentinel-output` → `drainSentinelSays`) and runs
 * each line through the local `speak()`/TTS.
 *
 * PG-backed (table `harness_shared.sentinel_says`, migration 381) — NOT an
 * in-memory FIFO: the Sentinel's MCP operator and the webview's operator are
 * SEPARATE processes (e.g. green `:3070` vs the local `:3270`), so a module-local
 * array could never bridge them; PG does. (Also the storage policy mandates PG.)
 * Best-effort: a transient PG error degrades to a no-op / empty drain rather than
 * breaking voice. LOCAL APP USER ONLY (owner constraint) — not the P2P channels.
 */
import { Pool } from 'pg';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: getHarnessAdminUrl(), max: 2 });
  return pool;
}

/** Append a spoken line (from the Sentinel's `voice:say`). No-ops on blank. */
export async function pushSentinelSay(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  try {
    const p = getPool();
    await p.query('INSERT INTO harness_shared.sentinel_says(text) VALUES($1)', [t]);
    // Bound: drop lines never drained (voice off) so the table can't grow without limit.
    await p.query("DELETE FROM harness_shared.sentinel_says WHERE created_at < now() - interval '10 minutes'");
  } catch (e) {
    console.error('[sentinel-output-buffer] push failed:', e);
  }
}

/** Return + clear all buffered spoken lines, oldest-first (the webview drains on poll). */
export async function drainSentinelSays(): Promise<string[]> {
  try {
    const { rows } = await getPool().query(
      'WITH d AS (DELETE FROM harness_shared.sentinel_says RETURNING id, text) SELECT text FROM d ORDER BY id',
    );
    return rows.map((r: { text: string }) => r.text);
  } catch (e) {
    console.error('[sentinel-output-buffer] drain failed:', e);
    return [];
  }
}
