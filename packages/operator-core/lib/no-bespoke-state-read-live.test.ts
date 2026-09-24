/**
 * no-bespoke-state-read-live.test.ts — the gate's LIVE VERDICT
 * (agent-state-plane-verification-2026-07-27, P-008 clause 3 / P-009).
 *
 * ⚠ WHAT THIS ADDS THAT `no-bespoke-state-read-guard.test.ts` DOES NOT.
 * That file locks the detection PREDICATE, exhaustively and in both directions, and
 * its own header is precise about the boundary: "the guard runs green on the clean
 * tree, which only proves the no-false-positive direction". Everything it asserts is
 * a function of a SYNTHETIC `defineTool` literal it wrote itself. Nothing in it ever
 * runs the gate against the real tree.
 *
 * So the composition is untested. `findOffenders()` is `git ls-files SCAN_DIRS` ->
 * read -> parse -> classify -> judge -> subtract BASELINE, and a fault in ANY link
 * before the predicate produces the same output as a clean tree: zero offenders,
 * exit 0, a confident green. A moved directory, a typo in `SCAN_DIRS`, an
 * over-broad `isExcluded`, a `git ls-files` that returns nothing because the cwd
 * resolved somewhere unexpected — each one silently converts the fleet's primary
 * adoption gate (D-016: "a detector without a floor is prose exhortation in a
 * costume") into a no-op that still reports success.
 *
 * ⚠ AND THAT IS WHY THE ORDER OF THE TWO LEGS BELOW IS LOAD-BEARING.
 * "The live offender list is empty" is the assertion P-008 asks for, and on its own
 * it is satisfied PERFECTLY by a gate that has stopped scanning. An empty result is
 * the shared output of "nothing is wrong" and "nothing was examined" — the two
 * states are indistinguishable from the verdict alone, so the verdict alone cannot
 * be the test. Capability is therefore PROVEN FIRST, against measured floors, and
 * only then is the silence asserted. Same discipline the three legs of
 * `holder-context.test.ts` apply to their tree walk, for the same reason.
 *
 * Measured live, 2026-08-22: 48+ candidate tools in scope across the two scan roots,
 * 45 grandfathered, 1+ cell lens, 3 reasoned collection/read-door exemptions, 0 offenders.
 * Floors below are set well under those numbers — they exist to catch a COLLAPSE,
 * not to pin a census that legitimately grows as the fleet adds tools.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
// prettier-ignore — ENFORCES the "ONE line" rule below, which was previously only DOCUMENTED:
// prettier wants to reflow this import into a multi-line list, which is exactly what unguards the
// specifier (measured 2026-08-03 — this file was prettier-dirty and one `--write` from TS7016).
// It sits above the pair because @ts-ignore must own the slot nearest the import; verified that
// prettier-ignore still applies across the two intervening directive comments.
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its real scan + predicates. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { findOffenders, isStateReadCandidate, SCAN_DIRS, BASELINE } from '../../../scripts/check-no-bespoke-state-read.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Scan {
  offenders: { file: string; name: string; rule: string; detail: string }[];
  exemptions: { file: string; name: string; reason: string }[];
  lenses: { file: string; name: string; cell: string }[];
  definitions: {
    file: string;
    name: string;
    capability: string | null;
    lens: string | null;
    exemption: string | null;
  }[];
  stale: string[];
  redundant: string[];
  scanned: number;
}

let scan: Scan;
beforeAll(() => {
  scan = findOffenders() as Scan;
});

/**
 * Every way a scan can be too collapsed to trust, as data rather than as assertions.
 *
 * Stated once, as a pure function, so the SAME conditions that gate the live verdict
 * can be pointed at a deliberately-broken scan and watched to fail (the last describe
 * block). An assertion written inline can only ever be observed passing on a healthy
 * tree, which is the exact property P-009 says is not a test.
 */
function capabilityFailures(s: Scan): string[] {
  const out: string[] = [];
  if (s.scanned <= 30) out.push(`only ${s.scanned} state-read tools classified`);
  if (!s.lenses.some((l) => l.name === 'dev:pipeline_position')) out.push('the @cell-lens marker parser found nothing');
  if (s.exemptions.length < 3) out.push(`only ${s.exemptions.length} @not-a-cell exemptions parsed`);
  if (BASELINE.size === 0) out.push('the grandfather set is empty');
  if (s.definitions.length === 0) out.push('findOffenders() did not expose parsed definitions');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEG 1 — CAPABILITY. Prove the gate is looking before believing what it reports.
// ─────────────────────────────────────────────────────────────────────────────

describe('the live gate is actually scanning', () => {
  /**
   * The gate's INPUT, measured independently of the gate. `SCAN_DIRS` is the one
   * declaration of what territory the gate polices, and it is two roots in two
   * different packages — so a move or a rename silently halves the coverage while
   * every remaining assertion stays green. Each root is checked SEPARATELY: a
   * combined count is dominated by the 918-file root and would not notice the
   * 24-file one disappearing entirely.
   */
  it.each([
    ['packages/operator-core/lib/agent-tools', 400],
    ['packages/agent-mcp/src/tools', 10],
  ])('scan root %s still exists and holds tool sources', (dir, floor) => {
    // COVERAGE, not string identity. `SCAN_DIRS` may legitimately name an
    // ANCESTOR of this root — 651c0dceed (2026-08-03) widened
    // 'packages/agent-mcp/src/tools' to 'packages/agent-mcp/src', which polices
    // a strict SUPERSET. An exact-match assertion reports that BROADENING as a
    // coverage loss and fails with "the gate has stopped policing it", which is
    // the opposite of what happened; the property worth guarding is that some
    // scan root still walks this territory. (That commit updated the sibling
    // assertion in no-bespoke-state-read-guard.test.ts and missed this one.)
    const covering = (SCAN_DIRS as string[]).filter((root) => dir === root || dir.startsWith(`${root}/`));
    expect(
      covering,
      `${dir} is covered by no SCAN_DIRS root — the gate has stopped policing it, and will ` +
        `report a clean tree for every violation committed there. ` +
        `SCAN_DIRS = ${JSON.stringify(SCAN_DIRS)}`,
    ).not.toHaveLength(0);

    const files = execSync(`git ls-files ${dir}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    })
      .split('\n')
      .filter((f) => /\.ts$/.test(f) && !/\.(test|spec)\./.test(f));

    expect(
      files.length,
      `${dir} yielded ${files.length} tracked tool sources. The gate reads exactly this ` +
        `list; if it is empty or collapsed, findOffenders() returns zero offenders for ` +
        `a reason that has nothing to do with the tree being clean.`,
    ).toBeGreaterThan(floor);
  });

  /**
   * The gate's OUTPUT reach. `scanned` counts DISTINCT tool names that tripped the
   * state-read signature — so it is non-zero only if the walk, the read, the parse
   * AND the predicate all worked. This is the single number that most directly
   * falsifies "the green is real".
   */
  it('recognises a healthy population of state-read tools, and parses what they declare', () => {
    expect(
      capabilityFailures(scan),
      `the gate classified ${scan.scanned} state-read tools across ${SCAN_DIRS.length} ` +
        `roots (48 when this was written). A collapse here means the pipeline broke ` +
        `upstream of the verdict, and the verdict is therefore meaningless.`,
    ).toEqual([]);
  });

  /**
   * Parsing reaches INSIDE the literal, not merely to its name — the part of the
   * pipeline a synthetic-fixture test can never exercise, since it supplies its own
   * source text and so proves only that the parser handles text the test wrote.
   */
  it('still parses the declarations real tools carry', () => {
    expect(scan.exemptions.map((e) => e.name).sort()).toEqual([
      'loop:status',
      'processes:list',
      'rubrics:amend-status',
      'state:read',
      'testing:run-status',
      'triggers:status',
    ]);
    expect(scan.lenses.map((l) => l.cell)).toContain('git.pipelinePosition');
    expect(scan.definitions.map((definition) => definition.name)).toContain('blender:success-metrics');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG 2 — THE VERDICT. Only meaningful because LEG 1 passed.
// ─────────────────────────────────────────────────────────────────────────────

describe('the live offender list is exactly the true positives', () => {
  /** P-008 clause 3. The list is empty, and LEG 1 is what makes that a fact. */
  it('is empty', () => {
    expect(
      scan.offenders.map((o) => `${o.name} [${o.rule}] ${o.file}`),
      'the gate has live offenders. Each is either a real undeclared state read (add a ' +
        '@cell-lens or a reasoned @not-a-cell) or a false positive — and a false positive ' +
        'here is the more urgent bug, because it is how an adoption gate loses the fleet.',
    ).toEqual([]);
  });

  /**
   * WI-6464, pinned against the REAL tree rather than a fixture. The bug was that the
   * gate inferred "is this a read?" from the tool's NAME, so two mutations shipped as
   * offenders and the one genuine read was buried in the noise. The fix consults the
   * DECLARED effect. This asserts the fix on the live definitions — the guard test's
   * equivalent case builds the literal by hand, so it cannot notice if the real tools'
   * declared capabilities drift away from what it assumed.
   */
  it('does not read a control-capability MUTATION as a state read — WI-6464', () => {
    expect(isStateReadCandidate({ name: 'processes:freeze', capability: 'processes:control' })).toBe(false);
    expect(isStateReadCandidate({ name: 'processes:limit', capability: 'processes:control' })).toBe(false);
  });

  /**
   * ...and the other direction, which is the half a blanket exemption would have
   * broken: the genuine read in the SAME group is still caught, and has been disposed
   * of rather than ignored. `processes:list` carries a reasoned single-door
   * `@not-a-cell` — ground (ii) of the gate's own contract, not a rubber stamp.
   */
  it('still catches the genuine read in the same group, and it is dispositioned', () => {
    expect(isStateReadCandidate({ name: 'processes:list', capability: 'intel:read' })).toBe(true);

    const disposed = scan.exemptions.concat(scan.lenses as never[]).map((r) => r.name);
    expect(
      disposed,
      'processes:list is a live state read with no declaration — the one true positive ' +
        'WI-6464 identified has regressed to undeclared.',
    ).toContain('processes:list');
  });

  /**
   * Hygiene the gate reports but does not fail on. A stale entry cannot cause a wrong
   * answer, so it must not red the fleet's build — but left unwatched the shrink-only
   * baseline accumulates dead weight, which is how a temporary grandfather set becomes
   * a permanent exemption list.
   */
  it('carries no dead weight in the shrink-only baseline', () => {
    expect(scan.stale, `baseline entries whose tool no longer trips the signature: ${scan.stale.join(', ')}`).toEqual(
      [],
    );
    expect(
      scan.redundant,
      `tools both grandfathered AND declared — drop the baseline entry: ${scan.redundant.join(', ')}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEG 3 — MUTATION. Watch LEG 1 fail, or it is not a test (P-009).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE ACCEPTANCE TEST FOR A DETECTOR IS "DOES IT RE-DERIVE A KNOWN DEFECT",
 * NEVER "DOES IT PASS."
 *
 * LEG 1 exists to make LEG 2's silence meaningful, and on a healthy tree it can only
 * ever be observed passing — which is precisely the shape of a check that has quietly
 * stopped checking. Each row below is a scan that a BROKEN gate would really produce,
 * and the assertion is that LEG 1's conditions reject it. Without this block,
 * loosening a floor to quiet a red would be indistinguishable from fixing one.
 *
 * Note what is NOT mutated: the shared script itself. This tree is edited
 * concurrently by the whole fleet and git-sync commits it wholesale on a timer, so a
 * transient edit to `SCAN_DIRS` risks committing a SILENTLY DISABLED gate — a
 * mutation whose blast radius is worse than the bug it demonstrates. Pointing the
 * real conditions at synthetic collapsed inputs proves the same property, repeatably,
 * and leaves nothing to restore.
 */
describe('MUTATION — the capability leg rejects a gate that stopped scanning', () => {
  const healthy = (): Scan => ({
    offenders: [],
    exemptions: [
      { file: 'a.ts', name: 'processes:list', reason: 'x'.repeat(40) },
      { file: 'b.ts', name: 'state:read', reason: 'y'.repeat(40) },
      { file: 'd.ts', name: 'triggers:status', reason: 'z'.repeat(40) },
    ],
    lenses: [{ file: 'c.ts', name: 'dev:pipeline_position', cell: 'git.pipelinePosition' }],
    definitions: [
      { file: 'a.ts', name: 'processes:list', capability: 'intel:read', lens: null, exemption: 'x'.repeat(40) },
      { file: 'b.ts', name: 'state:read', capability: 'intel:read', lens: null, exemption: 'y'.repeat(40) },
      { file: 'd.ts', name: 'triggers:status', capability: 'intel:read', lens: null, exemption: 'z'.repeat(40) },
      {
        file: 'c.ts',
        name: 'dev:pipeline_position',
        capability: 'intel:read',
        lens: 'git.pipelinePosition',
        exemption: null,
      },
    ],
    stale: [],
    redundant: [],
    scanned: 48,
  });

  it('accepts a healthy scan — otherwise every row below passes vacuously', () => {
    expect(capabilityFailures(healthy())).toEqual([]);
  });

  it.each([
    ['git ls-files returned nothing', { scanned: 0 }],
    ['the walk collapsed to a single directory', { scanned: 4 }],
    ['isExcluded grew over-broad and ate the corpus', { scanned: 30 }],
    ['the @cell-lens parser stopped matching', { lenses: [] }],
    ['the @not-a-cell parser stopped matching', { exemptions: [] }],
  ])('rejects a scan where %s', (_why, broken) => {
    expect(capabilityFailures({ ...healthy(), ...(broken as Partial<Scan>) }).length).toBeGreaterThan(0);
  });

  /**
   * ⚠ AND THE POINT OF THE WHOLE FILE, STATED AS AN ASSERTION: on every one of those
   * broken scans the P-008 verdict — "the offender list is empty" — is still TRUE.
   * The verdict cannot tell "nothing is wrong" from "nothing was examined"; only the
   * capability leg can, which is why it runs first and why it is mutation-tested here.
   */
  it('...while the offender-list verdict stays GREEN on every one of them', () => {
    for (const broken of [{ scanned: 0 }, { scanned: 4 }, { lenses: [] }, { exemptions: [] }]) {
      const s: Scan = { ...healthy(), ...(broken as Partial<Scan>) };
      expect(s.offenders).toEqual([]);
      expect(capabilityFailures(s).length).toBeGreaterThan(0);
    }
  });
});
