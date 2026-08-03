/**
 * check-lint-guard-reachability.test.ts — EI-19452618085391226.
 *
 * This suite is deliberately in TWO halves, because a guard-checker can fail in two
 * unrelated ways and only one of them is catchable with fixtures:
 *
 *   1. PURE LOGIC, with a permanent WRONG-IMPLEMENTATION control. The controls are the
 *      point: a classifier that credits any mention as enforcement is the exact mistake
 *      the first draft of this checker made, so it stays in the file forever as a case
 *      the real implementation must beat. A calibration case pins that the real logic
 *      still passes, so the controls cannot go green by the property itself breaking.
 *
 *   2. A REAL-TREE assertion that EXECUTES the checker over this repository. Without
 *      it, this file would be exactly what it exists to detect — a logic-only test that
 *      makes an unenforced guard look covered — and `check-lint-guard-reachability.mjs`
 *      would correctly flag ITSELF. That self-consistency is intentional.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReachabilityCensus,
  classifyGuard,
  resolveImplementationPaths,
  selectGuardScripts,
  ACKNOWLEDGED_UNREACHABLE,
  UNREACHABLE_HIGH_WATERMARK,
  ENFORCING_TEST_RE,
  // @ts-expect-error — untyped .mjs guard script, imported for its pure helpers.
} from '../../../../scripts/check-lint-guard-reachability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = 'scripts/check-lint-guard-reachability.mjs';

/** No corpus mentions anything unless a test says so. */
const corpora = (over: Partial<Record<string, string>> = {}) => ({
  gate: '',
  ci: '',
  test: '',
  hook: '',
  'logic-test': '',
  ...over,
});

describe('selectGuardScripts', () => {
  it('collapses companion invocations onto their base guard', () => {
    // Enforcement is a property of the IMPLEMENTATION, not of how many npm aliases
    // point at it — counting `lint:x` and `lint:x:strict` separately double-counts.
    const picked = selectGuardScripts({
      'lint:x': 'node scripts/x.mjs',
      'lint:x:strict': 'node scripts/x.mjs --strict',
      'lint:x:fix': 'node scripts/x.mjs --fix',
      'lint:x:update': 'node scripts/x.mjs --update',
      'test:affected': 'node scripts/affected.mjs',
    });
    expect(picked).toEqual(['lint:x']);
  });
});

describe('resolveImplementationPaths', () => {
  it('resolves the implementation file across node/tsx/npx invocation forms', () => {
    expect(resolveImplementationPaths('node scripts/check-a.mjs')).toEqual(['scripts/check-a.mjs']);
    expect(resolveImplementationPaths('tsx scripts/check-b.mjs --strict')).toEqual(['scripts/check-b.mjs']);
    expect(resolveImplementationPaths('node apps/operator/scripts/check-c.mjs')).toEqual([
      'apps/operator/scripts/check-c.mjs',
    ]);
  });

  it('returns nothing for a guard with no script file, so it is matched by name alone', () => {
    // `knip --no-config-hints` has no implementation path of ours to search for.
    expect(resolveImplementationPaths('knip --no-config-hints')).toEqual([]);
  });
});

describe('classifyGuard — a mention is not enforcement', () => {
  const scripts = { 'lint:x': 'node scripts/check-x.mjs' };

  it('credits a guard the release gate runs', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ gate: "'lint:x'" }) });
    expect(r.blocking).toBe(true);
    expect(r.tier).toBe('gate');
  });

  it('finds a guard invoked by direct PATH rather than npm name', () => {
    // The under-claim this checker exists to avoid: several guards run from hooks by
    // script path and never by npm name, so searching for the name alone reports a
    // false UNREACHABLE and sends someone to wire an already-covered guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ hook: 'node scripts/check-x.mjs' }),
    });
    expect(r.tiers).toContain('hook');
  });

  it('does NOT count a logic-only unit test as enforcement (the motivating case)', () => {
    // `lint:mock-cast-escape` had a fully green unit test of its helpers throughout the
    // window its real-tree count drifted +45 past baseline. Green detector, rotting guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" }),
    });
    expect(r.blocking).toBe(false);
    expect(r.tier).toBe('logic-test');
  });

  it('does NOT count a hook as enforcement — it nudges one agent and blocks nothing', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ hook: 'scripts/check-x.mjs' }) });
    expect(r.blocking).toBe(false);
  });
});

describe('ENFORCING_TEST_RE — the discriminator', () => {
  it('separates a real-tree execution from a fixture-driven unit test', () => {
    expect(ENFORCING_TEST_RE.test("execFileSync('node', [SCRIPT])")).toBe(true);
    expect(ENFORCING_TEST_RE.test('listTrackedFiles(REPO_ROOT)')).toBe(true);
    // A pure-helper test: imports the detector, feeds it a string, asserts. Enforces nothing.
    expect(ENFORCING_TEST_RE.test("expect(findEscapes('x as never')).toHaveLength(1)")).toBe(false);
  });
});

describe('buildReachabilityCensus', () => {
  it('reports a guard that nothing runs at all', () => {
    const c = buildReachabilityCensus({ scripts: { 'lint:orphan': 'node scripts/check-orphan.mjs' }, corpora: corpora() });
    expect(c.unreachable.map((r: { name: string }) => r.name)).toEqual(['lint:orphan']);
    expect(c.notEnforced).toHaveLength(1);
  });

  it('surfaces a NEW guard as debt without anyone listing it', () => {
    // The anti-drift property: the population comes from the scan, so a guard added
    // today cannot avoid the census by not being mentioned here.
    const c = buildReachabilityCensus({
      scripts: { 'lint:brand-new': 'node scripts/check-brand-new.mjs' },
      corpora: corpora(),
      acknowledged: new Map(),
    });
    expect(c.unacknowledged.map((r: { name: string }) => r.name)).toEqual(['lint:brand-new']);
  });

  it('does not fail a guard whose unenforcement is acknowledged', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:known': 'node scripts/check-known.mjs' },
      corpora: corpora(),
      acknowledged: new Map([['lint:known', 'pending decision']]),
    });
    expect(c.unacknowledged).toHaveLength(0);
    expect(c.notEnforced).toHaveLength(1); // acknowledged is not enforced
  });

  it('catches an allowlist entry for a guard that no longer exists', () => {
    // A stale entry keeps asserting a pending decision about nothing — and silently
    // consumes watermark budget that a real guard would otherwise have to justify.
    const c = buildReachabilityCensus({
      scripts: { 'lint:live': 'node scripts/check-live.mjs' },
      corpora: corpora({ gate: "'lint:live'" }),
      acknowledged: new Map([['lint:deleted-last-month', 'pending decision']]),
    });
    expect(c.staleAcknowledgements).toEqual(['lint:deleted-last-month']);
  });

  it('propagates reachability through an npm-run chain', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:agg': 'npm run lint:leaf', 'lint:leaf': 'node scripts/check-leaf.mjs' },
      corpora: corpora({ gate: "'lint:agg'" }),
    });
    expect(c.notEnforced).toHaveLength(0);
  });

  /* ── permanent WRONG-IMPLEMENTATION controls ───────────────────────────────
   * These stay in the file forever. Each encodes a classifier that looks right and
   * is wrong in a way that already happened; the assertions state what that mistake
   * costs. Without them, every test above also passes on a checker that credits any
   * mention at all as enforcement. */

  it('CONTROL: a classifier that credits ANY mention misses the rotting guard', () => {
    const creditsAnyMention = (corp: Record<string, string>, impl: string) =>
      Object.values(corp).some((t) => t.includes(impl));

    const logicOnly = corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" });

    // The wrong implementation calls this guard covered …
    expect(creditsAnyMention(logicOnly, 'scripts/check-x.mjs')).toBe(true);
    // … while the real one correctly reports it as not enforced. That gap is the bug.
    const real = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: logicOnly });
    expect(real.blocking).toBe(false);
  });

  it('CALIBRATION: the real classifier still credits genuine enforcement', () => {
    // Guards the controls above: if the real implementation ever stopped crediting
    // ANYTHING, every control would pass for the wrong reason.
    const gated = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: corpora({ gate: "'lint:x'" }) });
    expect(gated.blocking).toBe(true);
  });
});

describe('the repository itself (real-tree assertion)', () => {
  // This block is what makes THIS guard enforced rather than merely logic-tested —
  // see the file header. It executes the real checker over the real tree.
  it('has no unenforced lint guard beyond the acknowledged, shrink-only set', () => {
    const run = () => {
      try {
        return { code: 0, out: execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' }) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    };
    const { code, out } = run();
    expect(out).not.toMatch(/STALE allowlist/);
    expect(code, `check-lint-guard-reachability failed:\n${out}`).toBe(0);
  });

  it('keeps the acknowledged set at or under its watermark', () => {
    // Shrink-only. Growing this set is how the rot would quietly return, so the
    // ceiling is asserted here as well as inside the script.
    expect(ACKNOWLEDGED_UNREACHABLE.size).toBeLessThanOrEqual(UNREACHABLE_HIGH_WATERMARK);
  });

  it('gives every acknowledged guard a non-empty reason', () => {
    for (const [name, reason] of ACKNOWLEDGED_UNREACHABLE) {
      expect(String(reason).length, `${name} needs a stated reason`).toBeGreaterThan(10);
    }
  });
});
