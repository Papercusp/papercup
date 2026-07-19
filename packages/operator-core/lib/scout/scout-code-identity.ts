/**
 * scout-code-identity.ts — the RUNNING scout ideation code's content identity
 * (WI-5397: blender:success-metrics runningGeneration.sha reports the DEPLOYED sha,
 * not the code the scout host is actually running).
 *
 * BACKGROUND: the scout bg-host runs `npx tsx bin/hono-host.ts` directly against the
 * SHARED STAGING WORKING TREE (no bundling, no file-watch, WorkingDirectory=apps/operator)
 * — a tree continuously edited unstaged by the whole fleet. A git sha (deployed OR HEAD)
 * therefore never uniquely identifies "the code this process is executing": the tree
 * moves out from under a long-lived process between commits, and the process itself
 * never re-reads a file after tsx first resolves it. The only honest identity is a
 * CONTENT hash of the specific source files this process actually holds in memory.
 *
 * SCOPE: the curated file set is exactly the modules that decide a scout tick's
 * error-vs-capacity classification — the code the cycle-error-rate release bar is
 * judging (WI-4475 / WI-5391). Extend {@link SCOUT_CODE_IDENTITY_FILES} when a future
 * fix changes which code governs that classification; the hash is deliberately narrow
 * (not "every scout file") so an unrelated edit elsewhere doesn't spuriously zero the
 * soak-aggregation denominator (see {@link ./tick-ledger}'s readScoutTicksByCodeHash).
 *
 * MEMOIZED ON FIRST CALL, not at this module's own import — {@link currentScoutCodeHash}
 * is called from inside `scheduler.ts`'s tick-recording path (the first real activity
 * after a scout tick's cadence/fire gates pass), which is at-or-after whichever instant
 * the target files actually loaded in THIS process (their exact load instant relative
 * to hono-host boot was NOT conclusively resolved during WI-5397's build — the empirical
 * "loads lazily at first tick" claim from an earlier design pass could not be reproduced
 * against the current import graph, which traces as fully static/eager from
 * blueprint-steps/index.ts — but it does not matter: once computed the hash is frozen
 * for the process's lifetime, same as the code it describes).
 */
import { fileURLToPath } from 'node:url';
import { computeCombinedSourceHash } from './src-hash';

/** The modules whose CONTENT determines a scout tick's error/no-capacity
 *  classification — the code {@link ../agent-tools/scout/success-metrics}'s
 *  cycle-error-rate bar is judging. Order is part of the hash's identity; only
 *  ever APPEND, never reorder existing entries (reordering would change every
 *  future hash for byte-identical code, spuriously breaking the soak union). */
export const SCOUT_CODE_IDENTITY_FILES = ['./capacity-errors.ts', './scheduler.ts', './quality-metrics.ts'] as const;

let cached: string | null | undefined; // undefined = not yet computed this process

function resolvePaths(): string[] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return SCOUT_CODE_IDENTITY_FILES.map((rel) => dir + rel.replace(/^\.\//, ''));
}

/** The running scout code's identity — sha256(first 16 hex) over
 *  {@link SCOUT_CODE_IDENTITY_FILES}' concatenated CURRENT bytes, computed once and
 *  cached for this process's lifetime. Null when any file is unreadable (a bundled
 *  build with no on-disk source, a permissions issue, ...) — never a partial hash. */
export function currentScoutCodeHash(): string | null {
  if (cached === undefined) cached = computeCombinedSourceHash(resolvePaths());
  return cached;
}

/** Test-only — clear the memo so a test can force recomputation. */
export function _resetScoutCodeHashForTest(): void {
  cached = undefined;
}
