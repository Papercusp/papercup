/**
 * dependency-writer-census.test.ts — the set of modules that can WRITE a dependency edge,
 * asserted as an exact list, each naming the proof that its edges actually GATE.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-008).
 * @covers INV-04
 *
 * WHY A CENSUS AND NOT JUST MORE TESTS. P-008's obligation is "for EVERY path that writes a
 * dependency edge, prove the edge is effective". The word every is the hard part: a
 * behavioural suite can only prove the writers it happens to know about, so it answers
 * "these writers gate" and silently never answers "these are all the writers". That gap is
 * not hypothetical — it is exactly how D-017 escaped. `syncWorkItemDepEdges` was correct for
 * the family its one original caller fed it, the backfill later widened the input to a
 * second family, and every existing test kept passing because none of them knew a new
 * caller had appeared.
 *
 * So the enumeration itself is asserted here. Add a caller of an edge writer without adding
 * it to EDGE_WRITERS and this test fails, naming the module — which forces the question
 * "what proves ITS edges gate?" at the moment the writer is introduced rather than after an
 * incident. The behavioural half lives in dependency-writer-effectiveness.integration.test.ts.
 *
 * Static on purpose: no database, runs in milliseconds, and — unlike a behavioural test — it
 * fails on a NEW writer, which is the actual failure mode observed.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const LIB_ROOT = resolve(__dirname, '..');

/** Canonical mutation plus every compatibility facade that submits to it. */
const WRITER_FNS = [
  'mutateWorkItemDependencies',
  'mirrorWorkItemBlockingEdge',
  'removeMirroredWorkItemBlockingEdge',
  'syncWorkItemDepEdges',
  'syncFeatureBlockEdges',
] as const;

type WriterRole = 'definition' | 'entry-point';

interface WriterEntry {
  role: WriterRole;
  /** What proves the edges this module writes are EFFECTIVE (gate a real claim door). */
  provenBy: string;
}

/**
 * Every module permitted to call an edge-writer, and what proves its edges gate.
 *
 * `provenBy` is not decoration. A writer whose entry sits here with a vague reference is a
 * writer nobody has proven, and the point of this file is that such a module cannot exist
 * quietly. When adding a caller: add the behavioural proof FIRST, then name it here.
 */
const EDGE_WRITERS: ReadonlyMap<string, WriterEntry> = new Map([
  [
    'dbos/work-item-deps-store.ts',
    {
      role: 'definition',
      provenBy:
        'The store itself — the ONE normal-runtime module holding raw work_item_deps DML. ' +
        'mirror/remove/sync submit typed batches to mutateWorkItemDependencies; the build guard ' +
        'fails if a facade stops doing so or raw DML appears outside a named capability.',
    },
  ],
  [
    'dbos/feature-blockers-edges.ts',
    {
      role: 'definition',
      provenBy:
        'syncFeatureBlockEdges — the authoritative writer (D-010). Effectiveness: ' +
        "dependency-writer-effectiveness.integration.test.ts 'syncFeatureBlockEdges' cases " +
        '(gates, releases on terminality, and REPLACE semantics asserted as behaviour).',
    },
  ],
  [
    'work-items.ts',
    {
      role: 'entry-point',
      provenBy:
        'The work-item LINK door (linkWorkItem / unlinkWorkItem → canonical mirror + remove). ' +
        "Effectiveness: dependency-writer-effectiveness.integration.test.ts 'the link door' " +
        'cases — gates after link, released by terminality AND by unlink.',
    },
  ],
  [
    'issues-engineer.ts',
    {
      role: 'entry-point',
      provenBy:
        'The ISSUE link door (linkIssue / unlinkIssue → canonical mirror/remove). Reached through linkWorkItem for an ' +
        'issue-family source, which is how the tool surface reaches it. Effectiveness: the ' +
        "'issue family' link-door case, asserted through the issue floor (D-002).",
    },
  ],
  [
    'plan-workitem-promotion-run.ts',
    {
      role: 'entry-point',
      provenBy:
        'PROMOTION and BACKFILL through syncFeatureBlockEdges → canonical replace. ' +
        'Promotion + the issue-family backfill: the P-010 cases in ' +
        "plan-workitem-promotion-run.integration.test.ts. The backfill's UNION obligation " +
        '(INV-10): the INV-10 case in dependency-writer-effectiveness.integration.test.ts, ' +
        'with a replace-semantics negative control.',
    },
  ],
  [
    'plan-items/reconcile-linked-work-items.ts',
    {
      role: 'entry-point',
      provenBy:
        'The plan-lane dependency reconciler. Effectiveness: ' +
        "dependency-writer-effectiveness.integration.test.ts 'plan-lane reconciliation' case — " +
        'the canonical promoted row is served before reconciliation, withheld after the real ' +
        'writer runs, and served again only after its plan blocker settles.',
    },
  ],
  [
    'endpoint-route/routes/harness/features.ts',
    {
      role: 'entry-point',
      provenBy:
        'The features HTTP route. It passes (harness, featureId, blockedBy) straight to ' +
        'syncFeatureBlockEdges with no per-endpoint construction of its own, so the writer ' +
        'proof covers it; the pass-through is asserted below so that stays true. It is NOT ' +
        'independently covered if it ever starts building endpoints itself.',
    },
  ],
  [
    'pot-eval/live-ops.ts',
    {
      role: 'entry-point',
      provenBy:
        'The pot-eval live port (syncBlockEdges). Same pass-through shape as the features ' +
        'route and asserted the same way — it forwards ids to syncFeatureBlockEdges.',
    },
  ],
]);

/**
 * Modules allowed to hold raw work_item_deps DML.
 *
 * The store is the one write seam; the fixture factory is a TEST seeder that deliberately
 * writes malformed rows the store's guard would (correctly) refuse, which is the only way to
 * seed the defects the detector must find. Anything else appearing here is a second writer,
 * and a second writer is how a family/ref-form convention drifts out of one place.
 */
const RAW_DML_ALLOWLIST: ReadonlySet<string> = new Set([
  'dbos/work-item-deps-store.ts',
  'testing/dependency-fixture.ts',
]);

const SCAN_SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SCAN_SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.integration.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Drop comment-only lines before matching.
 *
 * Load-bearing here, not tidiness: five modules DISCUSS these writers in prose (the drift
 * monitor explains the repair as "re-run syncWorkItemDepEdges", the invariant registry names
 * them in `binds`, the fixture header explains what syncFeatureBlockEdges used to emit). A
 * naive scan would enrol all of them as writers, and a census that cries wolf on documentation
 * gets its allowlist padded until it means nothing.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('--') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const relLib = (file: string) => relative(LIB_ROOT, file).split(sep).join('/');

const SOURCE_FILES = collectSourceFiles(LIB_ROOT);

/**
 * Call sites only: a `function <name>(` declaration is the definition, not a call.
 *
 * A writer handed BY REFERENCE as an argument (`retry(syncFeatureBlockEdges, h, id, b)`) is an
 * indirect call and counts too. WI-10003675 routed promotion's edge write through a contention
 * retry helper that way, and a direct-call-only regex then reported the module as "no longer
 * CALLS an edge writer" while it still wrote every promotion edge (WI-10003724).
 */
function callsWriter(code: string): boolean {
  const stripped = code
    .replace(/\bfunction\s+(\w+)\s*\(/g, 'function $1_DECL(')
    // Import/export specifier lists are not arguments: `{ a, syncFeatureBlockEdges, b }`.
    .replace(/\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g, '');
  return WRITER_FNS.some(
    (fn) => new RegExp(`\\b${fn}\\s*\\(`).test(stripped) || new RegExp(`[(,]\\s*${fn}\\s*[,)]`).test(stripped),
  );
}

/** The mirror of `callsWriter`: this module is where one of the primitives is DECLARED. */
function definesWriter(code: string): boolean {
  return WRITER_FNS.some((fn) => new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).test(code));
}

describe('dependency edge WRITERS are an enumerated set (P-008)', () => {
  it('scans a non-trivial number of source files (a broken walker must not pass silently)', () => {
    // Same guard as blocking-floor-single-source.test.ts: an empty scan set satisfies every
    // assertion below while checking nothing, which is the "well-formed, plausible, wrong"
    // shape this whole plan exists to make impossible.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('every module that CALLS an edge writer is enumerated, with the proof its edges gate', () => {
    const unenumerated: string[] = [];
    for (const file of SOURCE_FILES) {
      if (!callsWriter(withoutComments(readFileSync(file, 'utf8')))) continue;
      const rel = relLib(file);
      if (!EDGE_WRITERS.has(rel)) unenumerated.push(rel);
    }

    expect(
      unenumerated,
      'These modules write dependency edges but are not in EDGE_WRITERS, so nothing states ' +
        'what proves their edges actually GATE. That is the D-017 shape exactly: a new caller ' +
        'fed the shared writer a family it had never been given, every existing test stayed ' +
        'green because none of them knew the caller existed, and 6 inert edges shipped. Add a ' +
        'behavioural proof (dependency-writer-effectiveness.integration.test.ts) and then name ' +
        'it here.',
    ).toEqual([]);
  });

  it('every enumerated writer still exists and still plays its declared role (no stale entries)', () => {
    // The census must fail in BOTH directions. An entry left behind after its module stopped
    // writing edges is a claim of coverage for a path that no longer exists — it inflates the
    // apparent enumeration and hides the next real gap.
    //
    // Roles are checked differently on purpose: a `definition` module DECLARES a primitive and
    // typically calls none of them, so requiring a call site there would be permanently red.
    // Checking the declaration instead also catches a primitive being MOVED — which relocates
    // the ref-form guard, the one thing every entry-point below is trusting to be there.
    const stale: string[] = [];
    for (const [rel, entry] of EDGE_WRITERS) {
      let code: string;
      try {
        code = readFileSync(join(LIB_ROOT, rel), 'utf8');
      } catch {
        stale.push(`${rel} (file missing)`);
        continue;
      }
      const stripped = withoutComments(code);
      if (entry.role === 'definition') {
        if (!definesWriter(stripped)) stale.push(`${rel} (no longer DEFINES an edge writer)`);
      } else if (!callsWriter(stripped)) {
        stale.push(`${rel} (no longer CALLS an edge writer)`);
      }
    }
    expect(stale, 'EDGE_WRITERS entries that no longer describe a live writer.').toEqual([]);
  });

  it('every entry names a non-trivial proof (an unproven writer cannot sit here quietly)', () => {
    const thin = [...EDGE_WRITERS.entries()].filter(([, e]) => e.provenBy.trim().length < 40).map(([rel]) => rel);
    expect(thin, 'EDGE_WRITERS entries whose provenBy does not name a proof.').toEqual([]);
  });

  it('only the store (and the test fixture) holds raw work_item_deps DML', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      if (!/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+harness_shared\.work_item_deps/i.test(code)) continue;
      const rel = relLib(file);
      if (!RAW_DML_ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      'These modules write work_item_deps rows directly instead of going through the store. ' +
        'The store is where typed candidate analysis, kind↔ref-form enforcement, and serializable ' +
        'commit live, so a direct write can mint an edge that is well-formed and still strand work. ' +
        'Call a canonical store facade instead.',
    ).toEqual([]);
  });
});

/**
 * The census's own negative control.
 *
 * Every assertion above is of the form "this list is empty". A detector that never fires
 * satisfies all of them, forever, while enumerating nothing — the same failure the P-001
 * registry guards against with its typo'd-citation case, and the same one INV-12 states for
 * the endpoint detector: a zero means nothing unless the thing can produce a non-zero.
 */
describe('the census DETECTS a writer (so its empty results mean something)', () => {
  it('a real call site is detected; a prose mention is not', () => {
    expect(callsWriter('await mirrorWorkItemBlockingEdge(src, dst);')).toBe(true);
    expect(callsWriter('await mutateWorkItemDependencies(batch);')).toBe(true);
    expect(callsWriter('  await syncFeatureBlockEdges(harness, id, blockers);')).toBe(true);
    // The exact shape five live modules have: the writer named only in documentation. If this
    // read as a call, the allowlist would have to absorb the drift monitor and the invariant
    // registry, and the census would stop distinguishing writers from readers.
    expect(callsWriter(withoutComments('// repair by re-running syncWorkItemDepEdges(...) for the item'))).toBe(false);
    expect(callsWriter(withoutComments(' * Mirrors syncFeatureBlockEdges(harness, id, [])'))).toBe(false);
  });

  it('a DECLARATION is not counted as a call (definition modules are not self-enrolling)', () => {
    // Without this, every definition module trivially "calls" its own writer and the
    // entry-point/definition distinction — which is what makes the role check meaningful —
    // collapses into a tautology.
    expect(callsWriter('export async function mirrorWorkItemBlockingEdge(blocker, blocked) {')).toBe(false);
    expect(definesWriter('export async function mirrorWorkItemBlockingEdge(blocker, blocked) {')).toBe(true);
    expect(definesWriter('await mirrorWorkItemBlockingEdge(src, dst);')).toBe(false);
  });

  it('a writer passed BY REFERENCE to a wrapper counts as a call (WI-10003724)', () => {
    // The retry-wrapper shape plan-workitem-promotion-run.ts uses since WI-10003675.
    expect(callsWriter('await syncBlockEdgesWithContentionRetry(syncFeatureBlockEdges, h, id, b);')).toBe(true);
    expect(callsWriter('await withRetry(h, mirrorWorkItemBlockingEdge);')).toBe(true);
    // A mere mention that is neither a call nor an argument stays out.
    expect(callsWriter("const label = 'syncFeatureBlockEdges';")).toBe(false);
    expect(callsWriter('import { syncFeatureBlockEdges } from "./dbos/feature-blockers-edges";')).toBe(false);
    expect(callsWriter('import {\n  getFeatureBlockers,\n  syncFeatureBlockEdges,\n  x,\n} from "./dbos/feature-blockers-edges";')).toBe(false);
    expect(callsWriter('export { a, syncWorkItemDepEdges, b } from "./dbos/work-item-deps-store";')).toBe(false);
  });

  it('an UNENUMERATED caller would fail the census (the assertion is reachable)', () => {
    // Simulates the D-017 arrival: a brand-new module that writes edges and is in no list.
    const synthetic = 'lib/some/new-writer.ts';
    const unenumerated = [synthetic].filter(() => callsWriter('await syncWorkItemDepEdges(h, id, b);'));
    expect(unenumerated).toEqual([synthetic]);
    expect(EDGE_WRITERS.has(synthetic)).toBe(false);
  });
});

describe('the two PASS-THROUGH writers stay pass-throughs (or they need their own proof)', () => {
  // Both entries above justify their coverage by "it forwards ids to syncFeatureBlockEdges and
  // builds no endpoints itself". That justification is a claim about the code, so it is asserted
  // rather than trusted: the moment either module starts constructing a ref or a kind, the
  // writer-level proof stops covering it and it needs its own effectiveness test.
  const passThroughs = ['endpoint-route/routes/harness/features.ts', 'pot-eval/live-ops.ts'] as const;

  it.each(passThroughs)('%s builds no dependency endpoint of its own', (rel) => {
    const code = withoutComments(readFileSync(join(LIB_ROOT, rel), 'utf8'));
    // The two ways a caller can start speaking the endpoint vocabulary itself.
    expect(
      /blocked_kind|blocker_kind|blocked_ref|blocker_ref/.test(code),
      `${rel} now names work_item_deps endpoint columns. It is enumerated as a pass-through ` +
        'writer, covered transitively by the syncFeatureBlockEdges proof — that coverage no ' +
        'longer holds if it constructs endpoints. Give it its own effectiveness test.',
    ).toBe(false);
    expect(
      /\bfeatureRef\s*\(/.test(code),
      `${rel} now builds a harness-qualified ref itself. Per D-009 the ref FORM is a function ` +
        'of the endpoint family, and deciding it at a caller is how the two conventions drift ' +
        'apart; leave it to the store (resolveDepEndpoint) and keep this a pass-through.',
    ).toBe(false);
  });
});
