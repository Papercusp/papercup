import { existsSync, readFileSync } from 'node:fs';
import { harnessPath } from '@/app/api/_hono/harness-paths';

/**
 * Hook names are derived at runtime from the harness's `run.sh` script
 * by grepping every `run_hook <name>` invocation. The script IS the
 * source of truth — adding a new lifecycle point in run.sh automatically
 * makes it available in the operator UI; nothing here to drift.
 *
 * Cached for 30 seconds. The list re-reads on next call after the TTL,
 * so editing run.sh is picked up without a server restart.
 */
let _cache: { value: string[]; expires: number } | null = null;
const TTL_MS = 30_000;
const BASH_RUN_HOOK_RE = /\brun_hook\s+([a-z][a-z0-9-]+)/gi;
const TS_RUN_HOOK_RE = /\brunHook\(['"]([a-z][a-z0-9-]+)['"]/g;

export function getKnownHooks(): string[] {
  const now = Date.now();
  if (_cache && _cache.expires > now) return _cache.value;
  const found = new Set<string>();
  // TS orchestrator main-loop is the canonical source; run.sh is the
  // legacy fallback (still has identical names).
  const tsMainLoop = `${harnessPath('..')}/orchestrator/src/main-loop.ts`;
  try {
    if (existsSync(tsMainLoop)) {
      const src = readFileSync(tsMainLoop, 'utf8');
      for (const m of src.matchAll(TS_RUN_HOOK_RE)) found.add(m[1]);
    }
  } catch {}
  try {
    const bashPath = harnessPath('run.sh');
    if (existsSync(bashPath)) {
      const src = readFileSync(bashPath, 'utf8');
      for (const m of src.matchAll(BASH_RUN_HOOK_RE)) found.add(m[1]);
    }
  } catch {}
  let hooks: string[] = [...found].sort();
  // Floor: pre-worker is the most fundamental hook; if grep returned
  // nothing the script is missing or unreadable — give the UI something
  // to render rather than an empty list.
  if (hooks.length === 0) hooks = ['pre-worker'];
  _cache = { value: hooks, expires: now + TTL_MS };
  return hooks;
}
