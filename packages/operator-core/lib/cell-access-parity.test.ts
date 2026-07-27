import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepoFile, readRepoFile } from '@papercusp/test-config';
import {
  registerCell,
  getCell,
  listCells,
  listCellsUnchecked,
  getCellUnchecked,
  canReadCell,
  __resetCellRegistryForTests,
  type CellSpec,
  type CellReader,
} from './cell-registry';
import { readCell, type CellReadEnv } from './cell-read';

/**
 * cell-access-parity.test.ts — THE `canReadCell` PARITY GATE
 * (unified-agent-state-plane-2026-07-27 P-028, D-047 row 7).
 *
 * WHY THIS EXISTS. D-042 binds every cell-reading surface to "CONSUME `canReadCell`,
 * never re-implement it", and until this file its entire enforcement was THAT SENTENCE.
 * D-016 says a sentence is not a tier — it is the prose-exhortation mechanism the
 * 47.1→34.9 evidence-compliance curve indicts.
 *
 * ⚠ IT IS THE MOST DANGEROUS OF THE FOUR UNCOVERED BEHAVIOURS BECAUSE IT LOOKS COVERED
 * AND FAILS SILENTLY. A surface that re-implements the audience check does not throw and
 * does not return an error — it returns MORE DATA. It passes every test that asserts on
 * content, because more content still contains the expected content. The only thing that
 * catches it is a test asserting the surfaces AGREE, which is what this file is.
 *
 * MODELLED ON `agent-tools/coordination/liveness-parity.test.ts`, named in D-038 axis 5
 * as the enforcement model for one-derivation-many-lenses: assert every surface routes
 * through ONE oracle. Here the oracle is `canReadCell(spec, reader)`.
 *
 * ⚠ WHY IT LANDS NOW, AT ONE CONSUMER, RATHER THAN LATER (P-028's ordering rule).
 * With one consumer the invariant is trivially true and the gate is cheap to write. With
 * n consumers each has independently had the chance to bypass it, and the gate must then
 * litigate n existing call sites instead of preventing them. Verified at authoring time:
 * the bypasses have ZERO production callers (leg C proves it mechanically, below). This
 * is why P-028 is a Phase 1 item and not a Phase 5 one.
 *
 * THREE LEGS, because there are three distinct ways to defeat the oracle:
 *   A. BEHAVIOURAL — a surface answers a reader differently from the oracle.
 *   B. ROOT        — someone adds a NEW reader-less accessor to the registry.
 *   C. CALL-SITE   — someone calls an EXISTING unchecked accessor from a new surface.
 * Legs B and C each carry a deliberate violation proving the detector actually fires,
 * which is P-028's stated acceptance criterion.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_A = 'su-owner-a';
const OWNER_B = 'su-owner-b';

/**
 * ⚠ EVENT-SIGNALLED ON PURPOSE, and a successor must not "fix" this to `poll`.
 *
 * `readCell` returns `absent` at GATE 1 (audience) before it ever dispatches. For the
 * IN-audience half of the parity table we need a non-`absent` answer that proves the
 * gate was passed — without standing up a real resolver. An event-signalled cell returns
 * `unknown` at the "no poll resolver" branch, which is exactly that: past gate 1, zero
 * I/O, fully deterministic. Switching these to `poll` would make the suite dispatch real
 * tools and turn a hermetic gate into a flaky one.
 */
const eventCell = (over: Partial<CellSpec> = {}): CellSpec => ({
  cell: 'test.wideCell',
  owner: OWNER_A,
  headline: 'some.headline',
  falsifier: {
    field: 'some.otherField',
    measurement: 'an independent apparatus that shares no input with the headline',
    kills: 'the headline being read as a health verdict when it is only a counter',
  },
  nullable: true,
  unknownHoist: 'someUnknown',
  callerRelativity: { kind: 'global' },
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  /**
   * ⚠ `liveExercised: true` is REQUIRED, not a claim about this fixture. D-038 axis 4
   * refuses any registration on fixture evidence alone ("fixtures cannot catch a fresh,
   * correctly-versioned, confidently-wrong resolver"), so a spec with `false` cannot be
   * registered at all and every fixture in the sibling suites asserts true for the same
   * reason. This object stands in for a real registered cell; the subject under test is
   * the audience gate, not this cell's provenance.
   */
  provenance: {
    obtainedBy: 'a fixture standing in for a registered cell, to exercise the audience gate',
    liveExercised: true,
    evidence:
      'the audience gate itself is exercised live by this suite against the real registry, ' +
      'registrar and readCell path — no resolver is mocked and no dispatch is stubbed',
  },
  resolver: 'packages/operator-core/lib/cell-access-parity.test.ts#fixture',
  changeSignal: { kind: 'event', key: 'test:fixture-cell-changed' },
  shape: '{ some: { headline } }',
  ...over,
});

const WIDE = 'test.wideCell';
const NARROW = 'test.narrowCell';

const readerA: CellReader = { ownerId: OWNER_A };
const readerB: CellReader = { ownerId: OWNER_B };

const env: CellReadEnv = { workspaceId: 'ws-test', harnessSlug: 'papercusp', role: 'su' };

beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(eventCell({ cell: WIDE, visibility: { kind: 'workspace' } }));
  registerCell(eventCell({ cell: NARROW, visibility: { kind: 'owner', ref: OWNER_A } }));
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG A — behavioural parity: every surface agrees with the oracle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A surface probe answers ONE question: did this surface DISCLOSE this cell to this
 * reader? Reducing every surface to that boolean is what makes them comparable — the
 * surfaces return wildly different shapes (a spec, an array, a tagged union), and the
 * audience contract is the one thing all three must agree on.
 */
type SurfaceProbe = {
  name: string;
  disclosed: (cell: string, reader: CellReader) => Promise<boolean> | boolean;
};

const SURFACES: SurfaceProbe[] = [
  {
    name: 'getCell(cell, reader)',
    disclosed: (cell, reader) => getCell(cell, reader) !== undefined,
  },
  {
    name: 'listCells(reader)',
    disclosed: (cell, reader) => listCells(reader).some((s) => s.cell === cell),
  },
  {
    // P-019 makes unreadable indistinguishable from unregistered, so `absent` is the
    // refusal and ANY other status means the audience gate was passed.
    name: 'readCell(cell, reader, env)',
    disclosed: async (cell, reader) => (await readCell(cell, reader, env)).status !== 'absent',
  },
];

describe('LEG A — every cell-read surface agrees with canReadCell', () => {
  const cases: Array<{ cell: string; reader: CellReader; label: string }> = [
    { cell: WIDE, reader: readerA, label: 'workspace cell / owner A' },
    { cell: WIDE, reader: readerB, label: 'workspace cell / owner B' },
    { cell: NARROW, reader: readerA, label: 'owner-scoped cell / the owner' },
    { cell: NARROW, reader: readerB, label: 'owner-scoped cell / a stranger' },
  ];

  for (const { cell, reader, label } of cases) {
    it(`agrees with the oracle: ${label}`, async () => {
      const spec = getCellUnchecked(cell);
      expect(spec, 'fixture registered').toBeDefined();
      const oracle = canReadCell(spec as CellSpec, reader);

      for (const surface of SURFACES) {
        const actual = await surface.disclosed(cell, reader);
        expect(
          actual,
          `${surface.name} disagreed with canReadCell for ${label}: oracle said ` +
            `${oracle ? 'DISCLOSE' : 'REFUSE'} but the surface ${actual ? 'DISCLOSED' : 'REFUSED'}`,
        ).toBe(oracle);
      }
    });
  }

  it('refuses the stranger on every surface, and the refusal is indistinguishable from absent', async () => {
    expect(getCell(NARROW, readerB)).toBeUndefined();
    expect(listCells(readerB).map((s) => s.cell)).not.toContain(NARROW);
    expect((await readCell(NARROW, readerB, env)).status).toBe('absent');

    // The point of P-019: the SAME answer as a cell that was never registered, so a
    // refusal cannot be used to probe for the existence of narrow cells.
    expect((await readCell('test.neverRegistered', readerB, env)).status).toBe('absent');
  });

  /**
   * ⚠ THE DELIBERATE VIOLATION for leg A (P-028 acceptance).
   *
   * A surface that enumerates the registry directly instead of through the oracle. This
   * is not a hypothetical shape — it is precisely what D-042 (a) warns about, and note
   * that it does not error and returns a perfectly well-formed result. It simply returns
   * MORE. The parity check above is what catches it; this test proves that check has
   * teeth rather than passing vacuously.
   */
  it('DELIBERATE VIOLATION: a surface that bypasses the oracle is caught by the parity check', () => {
    const bypassing: SurfaceProbe = {
      name: 'listCellsUnchecked() — a surface that re-implements (i.e. skips) the audience check',
      disclosed: (cell) => listCellsUnchecked().some((s) => s.cell === cell),
    };

    const spec = getCellUnchecked(NARROW) as CellSpec;
    const oracle = canReadCell(spec, readerB); // false — B is not the owner
    const actual = bypassing.disclosed(NARROW, readerB);

    expect(oracle).toBe(false);
    expect(actual).toBe(true); // it leaks, silently and without error
    expect(
      actual === oracle,
      'the bypassing surface must DISAGREE with the oracle — if this ever becomes true, ' +
        'the parity assertions above are vacuous and this gate is not testing anything',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG B — root gate: no NEW reader-less accessor may reach cell data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `CELLS` is module-private, so the ONLY way to reach cell data is an export of
 * cell-registry.ts. That makes this leg a COMPLETE gate rather than a heuristic: if
 * every spec-returning export either takes a `CellReader` or is a named, reasoned
 * bypass, then no unaudited path to cell data exists at all.
 */
const READER_LESS_ALLOWLIST: Record<string, string> = {
  listCellsUnchecked:
    'deliberate admin/inventory bypass, documented at its definition; leg C gates its call sites',
  getCellUnchecked:
    'deliberate admin/inventory bypass, documented at its definition; leg C gates its call sites',
  registerCell: 'a WRITE — it takes the spec as input rather than serving one to a reader',
  validateCellSpec: 'a pure contract check on a caller-supplied spec; reaches no stored data',
};

type ExportedFn = { name: string; params: string; returns: string };

/** Extract exported function signatures from TypeScript source. */
function exportedFunctions(source: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  const re = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*:\s*([^{]+)\{/gm;
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1], params: m[2], returns: m[3].trim() });
  }
  return out;
}

/** A function that hands back stored cell data without taking a reader to check it against. */
function readerLessSpecAccessors(source: string): string[] {
  return exportedFunctions(source)
    .filter((f) => /\bCellSpec\b/.test(f.returns))
    .filter((f) => !/\bCellReader\b/.test(f.params))
    .map((f) => f.name);
}

describe('LEG B — the registry exposes no unaudited path to cell data', () => {
  const registrySource = readRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts');

  it('CELLS is module-private, so the export surface is the whole attack surface', () => {
    expect(registrySource).toMatch(/^const CELLS = new Map/m);
    expect(registrySource).not.toMatch(/^export\s+(const|let)\s+CELLS\b/m);
  });

  it('every reader-less accessor of cell data is on the reasoned allowlist', () => {
    const offenders = readerLessSpecAccessors(registrySource).filter(
      (name) => !(name in READER_LESS_ALLOWLIST),
    );
    expect(
      offenders,
      `these exports hand back CellSpec data without taking a CellReader to check it against: ` +
        `${offenders.join(', ')}. Either take a reader and route through canReadCell, or add an ` +
        `entry to READER_LESS_ALLOWLIST stating why serving this without an audience check is safe.`,
    ).toEqual([]);
  });

  it('the allowlist has not rotted — every entry still exists', () => {
    const actual = new Set(exportedFunctions(registrySource).map((f) => f.name));
    const stale = Object.keys(READER_LESS_ALLOWLIST).filter((n) => !actual.has(n));
    expect(stale, `allowlisted but no longer exported: ${stale.join(', ')}`).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg B (P-028 acceptance). */
  it('DELIBERATE VIOLATION: a new reader-less accessor turns this leg RED', () => {
    const violating = `
export function getCellForDashboard(cell: string): CellSpec | undefined {
  return CELLS.get(cell);
}
`;
    expect(readerLessSpecAccessors(violating)).toContain('getCellForDashboard');

    // ...and the same function WITH a reader is accepted, so the detector keys on the
    // audience parameter rather than merely on the shape of the return type.
    const compliant = `
export function getCellForDashboard(cell: string, reader: CellReader): CellSpec | undefined {
  return getCell(cell, reader);
}
`;
    expect(readerLessSpecAccessors(compliant)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG C — call-site gate: the unchecked accessors stay uncalled
// ─────────────────────────────────────────────────────────────────────────────

const BYPASS_CALL = /\b(getCellUnchecked|listCellsUnchecked)\s*\(/;

/**
 * Files permitted to call an unchecked accessor, each with a reason. A new entry here is
 * a deliberate, reviewable act — which is the whole point of making the bypass loud.
 */
const CALL_SITE_ALLOWLIST: Record<string, string> = {
  'packages/operator-core/lib/cell-registry.ts': 'defines them',
};

function scanForBypassCallSites(rootDir: string, repoRoot: string): string[] {
  const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.turbo']);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (BYPASS_CALL.test(readFileSync(full, 'utf8'))) {
        hits.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  walk(rootDir);
  return hits.sort();
}

describe('LEG C — no production surface calls an unchecked accessor', () => {
  it('every bypass call site is allowlisted', () => {
    // Bounded to operator-core/lib, where every cell surface lives. Measured at ~200ms
    // for 4,088 non-test files, which is why this can be a unit-tier gate at all.
    //
    // ⚠ Anchor on a REPO-UNIQUE path, never on 'package.json': resolveRepoFile walks up
    // from startDir and stops at the FIRST match, and package.json exists at every
    // workspace level, so it resolves to packages/operator-core and the join below then
    // doubles the segment. cell-registry.ts occurs once in the tree, so it cannot.
    const libDir = path.dirname(
      resolveRepoFile(__dirname, 'packages/operator-core/lib/cell-registry.ts'),
    );
    const repoRoot = path.resolve(libDir, '..', '..', '..');
    const offenders = scanForBypassCallSites(libDir, repoRoot).filter(
      (f) => !(f in CALL_SITE_ALLOWLIST),
    );

    expect(
      offenders,
      `these files call getCellUnchecked/listCellsUnchecked, which skips the P-019 audience ` +
        `check: ${offenders.join(', ')}. A surface serving an agent must use getCell(cell, reader) ` +
        `or listCells(reader). If this call genuinely enumerates the registry itself (admin or ` +
        `inventory, never serving a value to an agent), add it to CALL_SITE_ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  /** ⚠ THE DELIBERATE VIOLATION for leg C (P-028 acceptance). */
  it('DELIBERATE VIOLATION: a new surface calling an unchecked accessor is detected', () => {
    expect(BYPASS_CALL.test('const all = listCellsUnchecked();')).toBe(true);
    expect(BYPASS_CALL.test('const one = getCellUnchecked(cell);')).toBe(true);

    // The compliant forms must NOT trip it, or the gate would be unusable noise.
    expect(BYPASS_CALL.test('const one = getCell(cell, reader);')).toBe(false);
    expect(BYPASS_CALL.test('const all = listCells(reader);')).toBe(false);
  });
});
