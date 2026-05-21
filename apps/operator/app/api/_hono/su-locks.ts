/**
 * /api/su-locks/* — read-only routes about the SU-locks substrate.
 *
 * Currently one route:
 *   GET /api/su-locks/hook-health — surface the OMP tool_call hook's
 *     persisted health marker so the /coord UI can show
 *     "enforcement offline" when the hook is failing open (operator
 *     unreachable). Marker is written by recordHookHealth() in
 *     scripts/hooks/omp/coord-hook.ts (file-locking #3). The hook
 *     process and the operator share one marker per host user at
 *     ~/.papercusp/locks-cache/hook-health.json.
 *
 * The route is open to loopback callers (the UI fetches it
 * unauthenticated, like the rest of /api/coord/*) — no sensitive
 * content in the file, only timestamps.
 */

import { Hono } from 'hono';
import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';

export const suLocks = new Hono();

interface HookHealthRecord {
  last_ok_ts?: string;
  last_error_ts?: string;
  last_error_kind?: 'operator_unreachable' | 'mcp_error';
  last_error_message?: string;
  last_block_ts?: string;
}

function hookHealthPath(): string {
  const override = process.env.PAPERCUSP_HOOK_HEALTH_PATH;
  if (override) return override;
  const home = process.env.HOME ?? '/tmp';
  return resolve(home, '.papercusp/locks-cache/hook-health.json');
}

/**
 * `ok` is true iff:
 *   - the marker file exists,
 *   - it has a last_ok_ts,
 *   - AND there is no last_error_ts more recent than last_ok_ts.
 *
 * Returns the full record alongside `ok` so the UI can render
 * specific copy (e.g. "operator unreachable 3m ago").
 */
suLocks.get('/hook-health', async (c) => {
  const path = hookHealthPath();
  let record: HookHealthRecord | null = null;
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') record = parsed;
  } catch {
    // Missing or unreadable. No marker yet → ok=true (nothing has
    // failed to record), `record=null` signals "no signal".
    return c.json({ ok: true, record: null });
  }
  if (record === null) return c.json({ ok: true, record: null });

  const okTs = record.last_ok_ts ? Date.parse(record.last_ok_ts) : NaN;
  const errTs = record.last_error_ts ? Date.parse(record.last_error_ts) : NaN;

  const errMoreRecent =
    Number.isFinite(errTs) && (!Number.isFinite(okTs) || errTs > okTs);
  return c.json({ ok: !errMoreRecent, record });
});
