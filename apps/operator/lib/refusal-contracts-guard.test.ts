/**
 * refusal-contracts-guard.test.ts — the detection predicate behind
 * `scripts/check-refusal-contracts.mjs` (WI-10005192).
 *
 * ## What the guard is for
 *
 * A fail-closed authority gate that refuses WITHOUT saying what would lift the
 * refusal turns a recoverable state into tribal knowledge. EI-23766133296678780
 * gave the identity gate a `RefusalContract` (what would lift it, who can make that
 * true, the values compared); this guard is the ratchet that stops the NEXT refusal
 * from being written without one.
 *
 * ## Why the controls below are PERMANENT
 *
 * The whole-tree scan runs green against a shrink-only baseline, which proves only
 * the no-false-positive direction. A guard that has only ever passed is a guard
 * nobody has tested: if the predicate silently stopped matching, the scan would keep
 * printing ✔ while the population grew unseen. So the known-positive fixtures live
 * here forever instead of being produced by mutating a real file — which also avoids
 * every in-tree mutation hazard (no git-sync sweep race, no restore step; see
 * CLAUDE.md § "Proving a guard is falsifiable").
 *
 * ## Why the whole-tree run is in this file
 *
 * The meta-guard `lint:guard-reachability` requires a new `lint:*` to be reachable
 * from a blocking path. The scan over the REAL tree below is that path — and it sits
 * in @papercusp/web beside `no-hand-rolled-module-pin-guard.test.ts`, whose
 * placement was measured to be selected by both operator-core and apps/operator
 * changes (the two roots this guard scans).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findRefusalSites, scanTree } from '../../../scripts/check-refusal-contracts.mjs';

interface Site {
  line: number;
  code: string;
  hasContract: boolean;
}

/** A refusal built the way the repo builds them — a `code` naming a refusal, no lift condition. */
const UNCONTRACTED_REFUSAL = `
export function gate(): { ok: false; code: string; message: string } {
  return { ok: false, code: 'capability_unsatisfied', message: 'nope' };
}
`;

describe('refusal-contracts — predicate (known-positive controls)', () => {
  it('FLAGS a refusal literal that carries no lift condition', () => {
    const sites: Site[] = findRefusalSites(UNCONTRACTED_REFUSAL);
    expect(sites).toHaveLength(1);
    expect(sites[0].code).toBe('capability_unsatisfied');
    expect(sites[0].hasContract).toBe(false);
  });

  it('flags every refusal-shaped code spelling, not just one', () => {
    const codes = [
      'claim_refused',
      'write_denied',
      'capability_unsatisfied',
      'fleet_scope_violation',
      'item_blocked',
      'forbidden',
      'transition_not_allowed',
    ];
    for (const code of codes) {
      const sites: Site[] = findRefusalSites(`const r = { ok: false, code: '${code}' };`);
      expect(sites.map((s) => s.code)).toEqual([code]);
    }
  });

  it('reports the 1-based line of the literal, so a violation is actionable', () => {
    const src = `\n\n\nconst r = { code: 'claim_refused' };\n`;
    const sites: Site[] = findRefusalSites(src);
    expect(sites[0].line).toBe(4);
  });

  it('counts each construction site separately (two literals => two sites)', () => {
    const src = `
      const a = { code: 'claim_refused' };
      const b = { code: 'claim_refused' };
    `;
    expect(findRefusalSites(src)).toHaveLength(2);
  });

  it('finds a refusal literal nested inside another expression', () => {
    const src = `
      export function f(x: boolean) {
        return x ? { ok: true } : { ok: false, code: 'write_denied', detail: { nested: 1 } };
      }
    `;
    expect((findRefusalSites(src) as Site[]).map((s) => s.code)).toEqual(['write_denied']);
  });
});

describe('refusal-contracts — the contract (what makes a site pass)', () => {
  it('a `refusal` key states the lift condition', () => {
    const src = `
      const r = {
        ok: false,
        code: 'capability_unsatisfied',
        refusal: { observed: {}, liftsWhen: 'x', whoCanMakeItTrue: 'y' },
      };
    `;
    const sites: Site[] = findRefusalSites(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasContract).toBe(true);
  });

  it('a `liftsWhen` key states the lift condition', () => {
    const src = `const r = { code: 'claim_refused', liftsWhen: 'the holder releases it' };`;
    const sites: Site[] = findRefusalSites(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasContract).toBe(true);
  });

  it('a quoted contract key counts too (JSON-shaped literals)', () => {
    const src = `const r = { 'code': 'claim_refused', 'liftsWhen': 'later' };`;
    const sites: Site[] = findRefusalSites(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasContract).toBe(true);
  });

  it('a contract key on a DIFFERENT literal does not satisfy this one', () => {
    const src = `
      const a = { code: 'claim_refused' };
      const b = { liftsWhen: 'never attached to a' };
    `;
    const sites: Site[] = findRefusalSites(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].hasContract).toBe(false);
  });
});

describe('refusal-contracts — predicate (known-negative controls)', () => {
  it('does NOT flag a code that names no refusal', () => {
    expect(findRefusalSites(`const r = { ok: true, code: 'created' };`)).toEqual([]);
  });

  it('does NOT flag a `code:` field declared in an interface / type literal', () => {
    // THE precision anchor. A grep over `code: '…'` reported ~190 hits against the
    // AST's 51 construction sites — this is most of the difference: a type literal is
    // a different node kind from an object literal, so the parse separates them.
    const src = `
      export interface Refused {
        ok: false;
        code: 'capability_unsatisfied';
      }
      type Alias = { code: 'write_denied' };
    `;
    expect(findRefusalSites(src)).toEqual([]);
  });

  it('does NOT flag a comparison against a refusal code', () => {
    const src = `if (result.code === 'capability_unsatisfied') { retry(); }`;
    expect(findRefusalSites(src)).toEqual([]);
  });

  it('does NOT match refusal prose in a comment or doc string', () => {
    const src = `
      /** returns { code: 'claim_refused' } when the holder is live */
      // const r = { code: 'write_denied' };
      export const x = 1;
    `;
    expect(findRefusalSites(src)).toEqual([]);
  });

  it('does NOT flag a computed (non-literal) code — it cannot be classified', () => {
    const src = `const r = { code: someVariable, other: 'claim_refused' };`;
    expect(findRefusalSites(src)).toEqual([]);
  });
});

describe('refusal-contracts — the tree', () => {
  it('has no refusal site beyond the measured baseline (no NEW uncontracted refusal)', () => {
    const { violations } = scanTree();
    expect(
      violations.map(
        (v: { key: string; baseline: number; actual: number }) =>
          `${v.key} baseline ${v.baseline} now ${v.actual}`,
      ),
    ).toEqual([]);
  });

  it('the baseline is not stale — every entry still has the sites it claims', () => {
    // SHRINK-ONLY: giving a site its contract (or deleting it) must lower the
    // baseline. A stale entry is not cosmetic — it is headroom a future uncontracted
    // refusal at that path/code could silently spend.
    const { stale } = scanTree();
    expect(
      stale.map(
        (s: { key: string; baseline: number; actual: number }) =>
          `${s.key} baseline ${s.baseline} now ${s.actual}`,
      ),
    ).toEqual([]);
  });

  it('loaded a baseline (a missing file must not read as an empty, passing one)', () => {
    expect(scanTree().baselineLoaded).toBe(true);
  });

  it('the ratchet CAN fail: an empty baseline turns every uncontracted site into a violation', () => {
    // Falsifiability without touching the tree — the baseline is an injected argument.
    // If `violations` were computed so as to always be [], the real-tree test above
    // would stay green forever; this is the control that notices.
    const { uncontracted, violations } = scanTree({ baseline: {} });
    expect(uncontracted.size).toBeGreaterThan(0);
    expect(violations).toHaveLength(uncontracted.size);
  });

  it('the ratchet is SHRINK-ONLY: a baseline larger than the live count is reported stale', () => {
    const { uncontracted, stale } = scanTree();
    const [anyKey] = [...(uncontracted as Map<string, number>).keys()];
    const inflated = Object.fromEntries(
      [...(uncontracted as Map<string, number>)].map(([k, n]) => [k, n]),
    );
    inflated[anyKey] += 1;
    expect(stale).toEqual([]);
    expect(
      (scanTree({ baseline: inflated }).stale as Array<{ key: string }>).map((s) => s.key),
    ).toEqual([anyKey]);
  });

  it('positive controls: the scan SEES the population and at least one contracted site', () => {
    // If the predicate silently stopped matching, `violations` would stay [] forever
    // and the guard would keep printing a clean bill. These two floors are what make
    // a blind scan fail. They are floors, not exact counts: an exact count would drift
    // every time a peer adds a (contracted) refusal, and would pass for the wrong
    // reason if a site moved instead of being fixed.
    const { sites } = scanTree();
    expect(sites.length).toBeGreaterThanOrEqual(40);
    expect(sites.some((s: Site) => s.hasContract)).toBe(true);
  });

  it('the identity gate runtime denial is a contract-bearing site (the slice this guard generalises)', () => {
    // EI-23766133296678780: identity-grants-port.ts `denial()` is the gate that
    // already states its lift condition. If it ever loses its contract the baseline
    // would have to GROW to absorb it — this names the regression directly.
    //
    // Deliberately `some`, not `every`: the SAME file also holds the install-time
    // `failure()` builder inside validateIdentityInstallGrants, which still returns
    // a refusal with no lift condition. That is a real, measured gap the baseline
    // carries (shrink it by attaching `identityRefusalContract(cause)` there) — an
    // `every` here would assert it away and turn the guard's own finding into a
    // permanently red test.
    const { sites } = scanTree();
    const identity = (sites as Array<Site & { rel: string }>).filter((s) =>
      s.rel.endsWith('identity-grants-port.ts'),
    );
    expect(identity.length).toBeGreaterThan(0);
    expect(identity.some((s) => s.hasContract)).toBe(true);
  });

  it('every site it reports carries a refusal-shaped code (no mystery hits)', () => {
    const { sites } = scanTree();
    for (const s of sites as Site[]) {
      expect(s.code).toMatch(/(refus|denied|unsatisfied|violation|blocked|forbidden|not_allowed)/);
    }
  });
});
