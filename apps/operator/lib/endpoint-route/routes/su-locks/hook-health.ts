/**
 * GET /api/su-locks/hook-health — Phase E13 (endpoint-unification-2026-05-21).
 * Ported off the legacy `_hono/su-locks.ts` Hono sub-app onto `defineTool`.
 *
 * Surfaces the lock-enforcement hooks' persisted health markers so the
 * `/coord` UI can show "enforcement offline" when a hook is failing
 * open. ALL THREE clients write the same `last-error.json` /
 * `last-success.json` into `~/.papercusp/locks-cache/` (override:
 * `PAPERCUSP_LOCKS_CACHE_DIR`): OMP's `coord-hook.ts` (`tool_call` /
 * `tool_result`) and the Claude/Codex `cc/` hooks (`pretooluse` /
 * `posttooluse`). One marker set = one machine-wide health signal.
 *
 * `auth: 'public'` — the legacy sub-app carried no auth middleware; the
 * UI fetches it unauthenticated and it is loopback-protected by the host
 * bind. Posture preserved verbatim.
 */
import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

interface HookErrorRecord {
  ts: string;
  // OMP hook: 'tool_call' | 'tool_result'. Claude/Codex cc/ hooks:
  // 'pretooluse' | 'posttooluse'. Same marker file, either source.
  handler: 'tool_call' | 'tool_result' | 'pretooluse' | 'posttooluse';
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

export default defineTool({
  method: 'GET',
  path: '/su-locks/hook-health',
  auth: 'public',
  async handler() {
    const dir = locksCacheDir();
    const errorRec = (await readJsonFile(resolve(dir, 'last-error.json'))) as HookErrorRecord | null;
    const successRec = await readJsonFile(resolve(dir, 'last-success.json'));

    const lastSuccessTs =
      successRec && typeof successRec.ts === 'string' ? successRec.ts : null;
    const lastError =
      errorRec && typeof errorRec.ts === 'string' ? errorRec : null;

    // `healthy` is true iff there is no error more recent than the last
    // success — no error ever recorded, or a success since the last error.
    let healthy = true;
    if (lastError) {
      const errMs = Date.parse(lastError.ts);
      const okMs = lastSuccessTs ? Date.parse(lastSuccessTs) : NaN;
      healthy = Number.isFinite(okMs) && okMs >= errMs;
    }

    return Response.json({
      healthy,
      last_success_ts: lastSuccessTs,
      last_error: lastError,
    });
  },
});
