/**
 * narrowing-gated-assertions-guard.test.ts — DISCRIMINATION CONTROLS for
 * `scripts/check-narrowing-gated-assertions.mjs` (EI-19374102245723119).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT OPTIONAL
 * A guard that has never failed is a guard nobody has tested. This one is worse than
 * most if it silently stops working, because its output is a REASSURANCE: "✓ all N
 * gates are armed" is exactly what a broken scanner that matches nothing also prints.
 * The guard's own history proves the risk is real rather than theoretical — the first
 * two line-scanner passes at this class produced, in order, 11 false positives and
 * then a confident FALSE ZERO. Both looked like clean results.
 *
 * So every case below is a permanently-resident control, not a one-off probe:
 *
 *   CAN IT FIRE?    a deliberately-vacuous fixture MUST be caught. If this ever goes
 *                   green the guard has become decorative.
 *   CAN IT STAY QUIET?  each of the four arming forms MUST NOT be flagged. These are
 *                   the false-positive class that gets a guard switched off.
 *   THE THREE PITFALLS  one control each, named, so a future "simplification" back to
 *                   a line/brace scanner fails HERE instead of in production:
 *                     · object-matcher arming   (`toMatchObject({ ok: … })`)
 *                     · `} else {` brace cancel (else-branch arming)
 *                     · braceless single-statement `if` — the shape BOTH real defects
 *                       took, and the one that produced the false zero.
 *
 * Fixtures are written to a temp dir OUTSIDE the repo and the guard is pointed at them
 * with `--file`. Nothing here mutates the working tree: git-sync commits the whole tree
 * on a schedule, so a probe that edited a tracked file could be committed mid-mutation
 * even if nothing went wrong and no handler failed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = resolve(ROOT, 'scripts/check-narrowing-gated-assertions.mjs');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'narrowing-guard-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the guard against one fixture. Returns its exit code — 1 means "flagged". */
function judge(name: string, source: string, extraArgs: string[] = []): { code: number; out: string } {
  const file = join(dir, name);
  writeFileSync(file, source, 'utf8');
  try {
    const out = execFileSync('node', [GUARD, '--file', file, ...extraArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const flagged = (src: string, name = `f${Math.random().toString(36).slice(2)}.test.ts`) =>
  judge(name, src).code === 1;

describe('check-narrowing-gated-assertions — can it fire at all', () => {
  it('CATCHES a vacuous braced gate (the guard is not decorative)', () => {
    const r = judge('vacuous-braced.test.ts', `
      import { it, expect } from 'vitest';
      it('x', () => {
        const r = doThing();
        if (r.ok) {
          expect(r.value).toBe('x');
        }
      });
    `);
    expect(r.code).toBe(1);
    expect(r.out).toContain('r.ok');
  });

  /**
   * PITFALL 3 — the shape BOTH real defects took. A scanner keyed on `{` never even
   * considers this site, which is precisely how the first pass reported zero vacuous
   * sites while two live ones sat in the tree.
   */
  it('CATCHES a vacuous BRACELESS gate — the shape that produced the false zero', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          if (r.ok) expect(r.value).toBe('x');
        });
      `),
    ).toBe(true);
  });
});

describe('check-narrowing-gated-assertions — the four arming forms stay quiet', () => {
  it('DIRECT: expect(r.ok) before the narrow is not flagged', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.value).toBe('x');
        });
      `),
    ).toBe(false);
  });

  it('BAIL: an early `if (!r.ok) return` is not flagged', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          if (!r.ok) return;
          if (r.ok) expect(r.value).toBe('x');
        });
      `),
    ).toBe(false);
  });

  /**
   * PITFALL 1 — `expect(r).toMatchObject({ ok: false })` arms the narrow just as well as
   * `expect(r.ok)`. A scanner that only looks for the latter reports this armed site as
   * vacuous; that was one of the false positives on the first pass.
   */
  it('MATCHER: expect(r).toMatchObject({ ok }) is not flagged (pitfall 1)', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          expect(r).toMatchObject({ ok: true, id: 1 });
          if (r.ok) expect(r.value).toBe('x');
        });
      `),
    ).toBe(false);
  });

  /**
   * PITFALL 2 — brace depth never returns to zero on a `} else {` line, so a character
   * walk runs straight past the else and cannot see that it asserts too.
   */
  it('ELSE: an asserting else branch is not flagged (pitfall 2)', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          if (r.ok) {
            expect(r.value).toBe('x');
          } else {
            expect(r.error).toBe('boom');
          }
        });
      `),
    ).toBe(false);
  });
});

describe('check-narrowing-gated-assertions — scope and suppression', () => {
  it('honours the narrowing-gate-ok pragma on the line above', () => {
    expect(
      flagged(`
        import { it, expect } from 'vitest';
        it('x', () => {
          const r = doThing();
          // narrowing-gate-ok: the absent branch is covered by the sibling case
          if (r.ok) expect(r.value).toBe('x');
        });
      `),
    ).toBe(false);
  });

  /**
   * SCOPE: an optional-FIELD truthiness guard is a different class — skipping when the
   * field is absent is often the intended behaviour — so it must not gate by default.
   * `--all-discriminants` is how that separate, unmeasured population gets surveyed
   * without loosening this gate; if these two ever agree, the scope split has collapsed.
   */
  it('does NOT gate on a non-result discriminant by default, but --all-discriminants sees it', () => {
    const src = `
      import { it, expect } from 'vitest';
      it('x', () => {
        const section = load();
        if (section.projectId) expect(section.projectId).toMatch(/p/);
      });
    `;
    expect(judge('scoped-default.test.ts', src).code).toBe(0);
    expect(judge('scoped-wide.test.ts', src, ['--all-discriminants']).code).toBe(1);
  });
});

describe('check-narrowing-gated-assertions — wiring', () => {
  it('is reachable as an npm script, so it can be run as a gate', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const entries = Object.entries(pkg.scripts).filter(([, v]) =>
      v.includes('check-narrowing-gated-assertions.mjs'),
    );
    expect(entries.length).toBeGreaterThan(0);
  });

  /**
   * ANTI-VACUITY FOR THIS FILE ITSELF: every control above runs the guard through the
   * same `judge()` seam, so if that seam silently stopped invoking anything, all of them
   * would report code 0 and the "stays quiet" cases would still pass. This asserts the
   * seam can produce BOTH outcomes, which is the one thing those cases cannot show.
   */
  it('the judge() seam actually executes the guard (both verdicts reachable)', () => {
    const vacuous = judge('seam-vacuous.test.ts', `
      import { it, expect } from 'vitest';
      it('x', () => { const r = doThing(); if (r.ok) expect(r.v).toBe(1); });
    `);
    const armed = judge('seam-armed.test.ts', `
      import { it, expect } from 'vitest';
      it('x', () => { const r = doThing(); expect(r.ok).toBe(true); if (r.ok) expect(r.v).toBe(1); });
    `);
    expect([vacuous.code, armed.code]).toEqual([1, 0]);
    expect(vacuous.out).toMatch(/narrowing-gated-assertions/);
  });
});
