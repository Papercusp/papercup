/**
 * account-pool-write-path.test.ts — WI-38164 recurrence guard.
 *
 * The account pool is one whole-document JSONB row that BOTH the owner's Deploy Accounts
 * page and the fleet's hottest writer (the inference gateway, a usage window per account
 * per ~30s) rewrite. The class of bug this guards is not a logic error anyone would spot
 * in review — it is `load()` … `write()` as two separate statements. Every one of those
 * pairs is a window in which another writer's change is read, not carried, and then
 * overwritten. That silently deleted owner-registered accounts twice in one evening.
 *
 * `account-pool-concurrency.integration.test.ts` proves the CURRENT write path cannot lose
 * an update. This test guards the perimeter instead: it fails if a NEW blind
 * whole-document writer appears, which the concurrency test could never notice because it
 * only exercises the writers that exist today. Cheap, no DB, runs in the gated unit suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/operator-core/lib/deployment → up 4 = monorepo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOTS = ['packages', 'apps', 'libs', 'scripts'];
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'dist-host', '.next', '.git', 'coverage', '.vitest-tmp',
  '_retired', 'src-tauri', 'build', 'out',
]);
const SOURCE_FILE = /\.[cm]?tsx?$/;

/** The ONE module allowed to touch the pool row directly — it owns the transaction. */
const STORE = 'packages/operator-core/lib/deployment/account-pool-store.ts';

function collect(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable (dangling submodule) — never fail the walk
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) collect(join(dir, e.name), out);
    } else if (SOURCE_FILE.test(e.name) && !e.name.includes('.test.')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/**
 * Comments stripped before matching. This guard is about what the code CALLS, and the
 * files most likely to name the banned symbols are the ones documenting why they are
 * banned — including the store's own header. A guard that reds on its own explanation
 * teaches people to delete the explanation.
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const sources = SCAN_ROOTS.flatMap((r) => collect(join(REPO_ROOT, r))).map((abs) => {
  const text = readFileSync(abs, 'utf8');
  return { path: relative(REPO_ROOT, abs).replaceAll('\\', '/'), text, code: stripComments(text) };
});

describe('account pool write path (WI-38164)', () => {
  it('scans a plausible number of source files (the walk itself is not silently empty)', () => {
    // Without this, a broken REPO_ROOT makes every assertion below vacuously pass.
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((f) => f.path === STORE)).toBe(true);
  });

  it('the comment stripper does not blind the scan to real code', () => {
    // Calibration for the stripper above: a banned call must still be found when it is
    // CODE, and must be ignored when it is prose. Without this the negative assertions
    // below could pass because the stripper ate everything.
    const probe = stripComments(
      ['// saveAccountPool(pool) in a line comment', '/* saveAccountPool(pool) in a block */', 'await saveAccountPool(pool);'].join('\n'),
    );
    expect(probe).toMatch(/\bsaveAccountPool\s*\(/); // the real call survives
    expect(probe.match(/saveAccountPool/g)).toHaveLength(1); // both comments were dropped
  });

  it('nothing outside the store writes the operator_account_pool row directly', () => {
    // writeOperatorState is the BLIND whole-document write. Against this table it is the
    // bug: it cannot carry a concurrent writer's change. updateOperatorState (SELECT …
    // FOR UPDATE) is the only correct door, and account-pool-store owns it.
    const blind = sources
      .filter((f) => f.path !== STORE)
      .filter((f) => /writeOperatorState\s*\(\s*['"`]operator_account_pool['"`]/.test(f.code))
      .map((f) => f.path);
    expect(blind, 'use updateAccountPool(mutator) — a blind write here loses concurrent registrations').toEqual([]);
  });

  it('the store itself writes the pool ONLY through the transactional updateOperatorState', () => {
    const store = sources.find((f) => f.path === STORE)!;
    expect(store.code).toContain('updateOperatorState');
    // The bug was literally this import. Keeping it out is what makes the blind write
    // unavailable rather than merely discouraged.
    expect(store.code, 'account-pool-store must not use the blind whole-document writer').not.toMatch(
      /\bwriteOperatorState\b/,
    );
  });

  it('exposes no whole-document save door — updateAccountPool(mutator) is the only write', () => {
    const store = sources.find((f) => f.path === STORE)!;
    // `saveAccountPool(pool)` took an already-read snapshot, so every caller of it was a
    // lost-update waiting to happen; it was deleted rather than fixed, because a correct
    // caller of it cannot be written. If it comes back, so does the bug.
    expect(store.code).not.toMatch(/export\s+(async\s+)?function\s+saveAccountPool\b/);
    const callers = sources.filter((f) => /\bsaveAccountPool\s*\(/.test(f.code)).map((f) => f.path);
    expect(callers, 'saveAccountPool is gone — write through updateAccountPool(mutator)').toEqual([]);
  });

  it('no scale-out / deploy-binding dep re-introduces a savePool snapshot seam', () => {
    // These injected deps used to be `savePool(pool)`, and their callers held that pool
    // across a network allocate / a full teardown+redeploy loop — the widest windows in
    // the file. They are `mutatePool(mutator)` now; a rename back is a regression.
    const store = sources.find((f) => f.path === STORE)!;
    expect(store.code).toMatch(/mutatePool:\s*\(/);
    expect(store.code).not.toMatch(/^\s*savePool[?]?:/m);
  });
});
