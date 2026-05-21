/**
 * /api/su-locks/* — read-only routes about the SU-locks substrate.
 *
 * GET /api/su-locks/hook-health — surface the OMP tool_call hook's
 *   persisted health markers so the /coord UI can show "enforcement
 *   offline" when the hook is failing open (operator unreachable).
 *
 *   Per the file-locking plan §3, the hook writes two markers into
 *   ~/.papercusp/locks-cache/ (override dir: PAPERCUSP_LOCKS_CACHE_DIR):
 *     - last-error.json   { ts, handler, phase, detail, operator_url }
 *     - last-success.json { ts }
 *   Written by recordHookError() / recordHookSuccess() in
 *   scripts/hooks/omp/coord-hook.ts. The hook process and the
 *   operator share one marker set per host user.
 *
 *   Response shape (plan §3 step 2): { healthy, last_success_ts,
 *   last_error }.
 *
 * The route is open to loopback callers (the UI fetches it
 * unauthenticated, like the rest of /api/coord/*) — no sensitive
 * content in the files, only timestamps + an operator URL.
 */

import { Hono } from 'hono';
import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';

export const suLocks = new Hono();

interface HookErrorRecord {
  ts: string;
  handler: 'tool_call' | 'tool_result';
  phase: 'connect' | 'http' | 'parse';
  detail: string;
  operator_url: string;
}

function locksCacheDir(): string {
  const override = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  if (override) return override;
  const home = process.env.HOME ?? '/tmp';
  return resolve(home, '.papercusp/locks-cache');
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // missing or malformed
  }
}

/**
 * `healthy` is true iff there is no error more recent than the last
 * success — i.e. either no error has ever been recorded, or a
 * successful hook call has happened since the last error.
 */
suLocks.get('/hook-health', async (c) => {
  const dir = locksCacheDir();
  const errorRec = (await readJsonFile(
    resolve(dir, 'last-error.json'),
  )) as HookErrorRecord | null;
  const successRec = await readJsonFile(resolve(dir, 'last-success.json'));

  const lastSuccessTs =
    successRec && typeof successRec.ts === 'string' ? successRec.ts : null;
  const lastError =
    errorRec && typeof errorRec.ts === 'string' ? errorRec : null;

  let healthy = true;
  if (lastError) {
    const errMs = Date.parse(lastError.ts);
    const okMs = lastSuccessTs ? Date.parse(lastSuccessTs) : NaN;
    // Unhealthy when the error is the most recent signal: either no
    // success recorded at all, or the error is newer than the success.
    healthy = Number.isFinite(okMs) && okMs >= errMs;
  }

  return c.json({
    healthy,
    last_success_ts: lastSuccessTs,
    last_error: lastError,
  });
});
