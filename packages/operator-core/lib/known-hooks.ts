import { existsSync, readFileSync } from 'node:fs';
import { harnessPath } from './harness-paths';

/**
 * Hook names are derived at runtime from the TS orchestrator's
 * `main-loop.ts` by matching every `runHook('<name>')` call. The
 * main-loop IS the source of truth — adding a new lifecycle point there
 * automatically makes it available in the operator UI; nothing here to
 * drift. (The legacy bash source, `run.sh`, was retired.)
 *
 * Cached for 30 seconds; re-reads after the TTL so edits are picked up
 * without a server restart.
 */
let _cache: { value: string[]; expires: number } | null = null;
const TTL_MS = 30_000;
const TS_RUN_HOOK_RE = /\brunHook\(['"]([a-z][a-z0-9-]+)['"]/g;

export function getKnownHooks(): string[] {
  const now = Date.now();
  if (_cache && _cache.expires > now) return _cache.value;
  const found = new Set<string>();
  // The TS orchestrator main-loop is the canonical source of hook names.
  const tsMainLoop = `${harnessPath('..')}/orchestrator/src/main-loop.ts`;
  try {
    if (existsSync(tsMainLoop)) {
      const src = readFileSync(tsMainLoop, 'utf8');
      for (const m of src.matchAll(TS_RUN_HOOK_RE)) found.add(m[1]);
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
