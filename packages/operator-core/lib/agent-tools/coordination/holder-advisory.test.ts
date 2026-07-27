import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveHolderAdvisory,
  resolveHolderAdvisoryMap,
  holderContextReader,
  HOLDER_CONTEXT_SCHEMA,
  HOLDER_ADVISORY_DISTINCT_CAP,
} from './holder-advisory';
import {
  projectHolderContext,
  type HolderContextSources,
  type HolderGoalRecord,
} from '../../coord/holder-context';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';
import { AGENT_GOAL_CELL } from '../../cell-registrations';

/**
 * holder-advisory.test.ts — P-027's suite (plan `unified-agent-state-plane-2026-07-27`).
 *
 * The acceptance, verbatim: "each of the four names the holder's goal at the
 * moment of refusal, and a test asserts the advisory NEVER alters the underlying
 * grant/refuse verdict."
 *
 * The second clause is the load-bearing one and it is what most of this file is
 * about. An enrichment that can flip a verdict is not an enrichment — it is a
 * silent change to the claim rail, arriving through a code path nobody reviews as
 * one. So the tests below drive the advisory into every failure mode it has (a
 * throwing store, an absent reader, an unregistered cell, a holder with no goal)
 * and require the SAME answer out every time.
 */

const NOW = Date.parse('2026-07-27T18:00:00.000Z');
const reader = { ownerId: 'su-reader', role: 'su' } as never;

/** The goal cell must be registered, or the goal leg fails CLOSED by design. */
beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(AGENT_GOAL_CELL as CellSpec);
});

function sourcesFor(goals: Record<string, HolderGoalRecord>, keys: string[] = []): HolderContextSources {
  return {
    holderGoal: async (holder) => goals[holder] ?? null,
    holderAssumptionKeys: async () => keys,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The wire schema cannot drift behind the projection
// (moved here from _holder-lens.test.ts with the schema itself, P-027)
// ─────────────────────────────────────────────────────────────────────────────

describe('HOLDER_CONTEXT_SCHEMA tracks the projection', () => {
  /**
   * ⚠ THE FAILURE THIS PREVENTS IS SILENT. A tool's zod `result` STRIPS undeclared
   * keys, so a schema lagging the projection does not error — it deletes the new
   * field from every response. D-093 adding two fields is exactly such a moment,
   * and without this the amendment could have shipped invisible on
   * `work_items:list` while every other test stayed green.
   */
  it("declares exactly the projection's key set", () => {
    const ctx = projectHolderContext({ itemId: 'WI-1', acquiredTs: null }, ['k'], NOW);
    expect(ctx).not.toBeNull();
    expect(Object.keys(HOLDER_CONTEXT_SCHEMA.shape).sort()).toEqual(
      Object.keys(ctx as object).sort(),
    );
  });

  it('accepts a real projection unchanged', () => {
    const ctx = projectHolderContext(
      { itemId: 'WI-1', intent: 'do the thing', acquiredTs: null, agreement: 'sole', competing: [] },
      ['k'],
      NOW,
    );
    expect(HOLDER_CONTEXT_SCHEMA.parse(ctx)).toEqual(ctx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveHolderAdvisory — one holder, one subject
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveHolderAdvisory', () => {
  it('names the holder goal at the moment of refusal', async () => {
    const ctx = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      subjectRef: 'WI-500',
      nowMs: NOW,
      sources: sourcesFor({ 'su-holder': { itemId: 'WI-900', intent: 'shipping the parser' } }),
    });
    expect(ctx?.goalRef).toBe('WI-900');
    expect(ctx?.goalText).toBe('shipping the parser');
  });

  /**
   * ⚠ D-094, THE DEFECT THAT ONLY LIVE DATA FOUND. A holder-level `competing` list
   * rendered against a subject must never name that subject: telling a peer
   * refused on WI-500 that the holder is "also competing on WI-500" is a confident
   * wrong answer, and it fires on exactly the multi-item holders the field exists
   * to serve. P-030 found it on 3 of 18 real rows; this is the friction-point half.
   */
  it('subtracts the subject from competing (D-094)', async () => {
    const ctx = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      subjectRef: 'WI-500',
      nowMs: NOW,
      sources: sourcesFor({
        'su-holder': { itemId: 'WI-900', competing: ['WI-500', 'WI-777'] },
      }),
    });
    expect(ctx?.competing).toEqual(['WI-777']);
    expect(ctx?.competing).not.toContain('WI-500');
  });

  it('leaves competing intact when no subject is given (a lock path is not an item ref)', async () => {
    const ctx = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      nowMs: NOW,
      sources: sourcesFor({ 'su-holder': { itemId: 'WI-900', competing: ['WI-500', 'WI-777'] } }),
    });
    expect(ctx?.competing).toEqual(['WI-500', 'WI-777']);
  });

  /**
   * ⚠ P-026 RULE (f) — the whole reason this returns null instead of throwing.
   * Every caller is a REFUSAL path: a claim conflict, a lock queue read, a release
   * request. An advisory that can reject turns "you cannot have this item" into
   * "your tool call failed", which is strictly worse than saying nothing.
   */
  it('a throwing source costs the advisory, never the caller', async () => {
    const ctx = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      subjectRef: 'WI-500',
      sources: {
        holderGoal: async () => {
          throw new Error('pg down');
        },
        holderAssumptionKeys: async () => {
          throw new Error('facts store down');
        },
      },
    });
    expect(ctx).toBeNull();
  });

  it('fails CLOSED without an identified reader', async () => {
    const ctx = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader: null,
      sources: sourcesFor({ 'su-holder': { itemId: 'WI-900', intent: 'secret work' } }),
    });
    expect(ctx).toBeNull();
  });

  it('a blank holder is a no-op, not an error', async () => {
    expect(await resolveHolderAdvisory({ holder: '  ', reader })).toBeNull();
    expect(await resolveHolderAdvisory({ holder: null, reader })).toBeNull();
  });

  /**
   * ⚠ D-056 — a refusal must be INDISTINGUISHABLE from an absence. If "you may not
   * read this holder's goal" looked different from "this holder has no goal", the
   * difference would be a probe oracle for state the reader may not see.
   */
  it('an undisclosable goal is byte-identical to no goal at all', async () => {
    const noGoal = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      nowMs: NOW,
      sources: sourcesFor({}),
    });
    __resetCellRegistryForTests(); // goal cell unregistered ⇒ the gate refuses
    const refused = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      nowMs: NOW,
      sources: sourcesFor({ 'su-holder': { itemId: 'WI-900', intent: 'secret work' } }),
    });
    expect(refused).toEqual(noGoal);
    expect(refused?.goalRef ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveHolderAdvisoryMap — many holders, one resolution each
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveHolderAdvisoryMap', () => {
  it('resolves ONE time per distinct holder', async () => {
    let calls = 0;
    const advisory = await resolveHolderAdvisoryMap(['su-a', 'su-a', 'su-b', 'su-a'], reader, {
      nowMs: NOW,
      sources: {
        holderGoal: async (h) => {
          calls += 1;
          return { itemId: `WI-${h}` };
        },
        holderAssumptionKeys: async () => [],
      },
    });
    expect(calls).toBe(2);
    expect(advisory.forRow('su-a')?.goalRef).toBe('WI-su-a');
    expect(advisory.forRow('su-b')?.goalRef).toBe('WI-su-b');
  });

  /**
   * ⚠ THE PER-ROW SUBTRACTION IS THE POINT OF THE `forRow` INDIRECTION. One
   * holder's context lands on SEVERAL rows of the same list, and D-094's defect is
   * only visible when it does — a finished map of contexts could not express
   * "correct at the holder level, wrong on this row".
   */
  it('re-projects per row, so one holder is never its own rival on any of them', async () => {
    const advisory = await resolveHolderAdvisoryMap(['su-a'], reader, {
      nowMs: NOW,
      sources: sourcesFor({ 'su-a': { itemId: 'WI-1', competing: ['WI-1', 'WI-2', 'WI-3'] } }),
    });
    expect(advisory.forRow('su-a', 'WI-2')?.competing).toEqual(['WI-1', 'WI-3']);
    expect(advisory.forRow('su-a', 'WI-3')?.competing).toEqual(['WI-1', 'WI-2']);
    // …and the holder-level truth is unchanged for a row that is not in the list.
    expect(advisory.forRow('su-a', 'WI-9')?.competing).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('caps the distinct fan-out and reports what it did not attempt', async () => {
    const advisory = await resolveHolderAdvisoryMap(['su-a', 'su-b', 'su-c'], reader, {
      nowMs: NOW,
      distinctCap: 2,
      sources: sourcesFor({
        'su-a': { itemId: 'WI-1' },
        'su-b': { itemId: 'WI-2' },
        'su-c': { itemId: 'WI-3' },
      }),
    });
    expect(advisory.forRow('su-a')?.goalRef).toBe('WI-1');
    expect(advisory.forRow('su-c')).toBeNull();
    expect([...advisory.omitted]).toEqual(['su-c']);
  });

  it('the default cap is above the measured live holder population', () => {
    // Measured 2026-07-27: 17 distinct holders across the WHOLE work_items table.
    expect(HOLDER_ADVISORY_DISTINCT_CAP).toBeGreaterThan(17);
  });

  it('a null reader leaves every row undecorated rather than failing', async () => {
    const advisory = await resolveHolderAdvisoryMap(['su-a'], null, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-1' } }),
    });
    expect(advisory.forRow('su-a')).toBeNull();
    expect([...advisory.omitted]).toEqual([]);
  });

  it('tolerates an empty / all-blank holder list', async () => {
    const advisory = await resolveHolderAdvisoryMap([null, '', '  '], reader);
    expect(advisory.forRow('su-a')).toBeNull();
    expect([...advisory.omitted]).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ACCEPTANCE: the advisory never alters a grant/refuse verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each of the four injection points computes its verdict FIRST and then attaches
 * the advisory to the already-decided result. That ordering is the invariant, and
 * it is what these tests pin: the same verdict must come out whether the advisory
 * resolves richly, returns null, or its store is on fire.
 *
 * ⚠ WHY A SHAPED SIMULATION RATHER THAN THE REAL TOOLS. Driving the genuine
 * handlers needs PG, the cell registry, a claim spec and a live identity — an
 * integration concern. What can be tested purely, and is the thing that actually
 * breaks, is the CONTRACT the call sites rely on: that the advisory is a
 * spreadable value which is absent when there is nothing to say and never throws.
 * A call site that stops honouring that ordering is caught by the shape assertions
 * in each tool's own suite; this file guarantees the value it is handed can never
 * be the reason a verdict moves.
 */
describe('ACCEPTANCE — the advisory never changes the verdict', () => {
  const refuse = () => ({ ok: false as const, error: 'claim_conflict', holder: 'su-holder' });

  const withAdvisory = async (sources: HolderContextSources | undefined, rdr: unknown) => {
    const verdict = refuse(); // decided BEFORE the advisory, always
    const holderContext = await resolveHolderAdvisory({
      holder: verdict.holder,
      reader: rdr as never,
      subjectRef: 'WI-500',
      nowMs: NOW,
      sources,
    });
    return { ...verdict, ...(holderContext ? { holderContext } : {}) };
  };

  it('is byte-identical with a rich advisory, no advisory, and a burning store', async () => {
    const rich = await withAdvisory(
      sourcesFor({ 'su-holder': { itemId: 'WI-900', intent: 'shipping the parser' } }),
      reader,
    );
    const none = await withAdvisory(sourcesFor({}), reader);
    const noReader = await withAdvisory(
      sourcesFor({ 'su-holder': { itemId: 'WI-900' } }),
      null,
    );
    const onFire = await withAdvisory(
      {
        holderGoal: async () => {
          throw new Error('pg down');
        },
        holderAssumptionKeys: async () => {
          throw new Error('down');
        },
      },
      reader,
    );

    // The advisory landed in exactly one of them…
    expect(rich.holderContext?.goalRef).toBe('WI-900');
    expect(none).not.toHaveProperty('holderContext');
    expect(noReader).not.toHaveProperty('holderContext');
    expect(onFire).not.toHaveProperty('holderContext');

    // …and the VERDICT is identical in all four.
    for (const r of [rich, none, noReader, onFire]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe('claim_conflict');
      expect(r.holder).toBe('su-holder');
    }
  });

  /**
   * ⚠ NON-VACUITY (D-076). If `refuse()` ever stopped producing a refusal, every
   * assertion above would still pass while testing nothing at all. Pin the fixture
   * itself, so a gate that has stopped gating cannot look healthy.
   */
  it('the fixture really is a refusal', () => {
    expect(refuse().ok).toBe(false);
    expect(refuse().error).toBe('claim_conflict');
  });

  /**
   * ⚠ THE ADVISORY IS ADDITIVE-ONLY. A call site spreads it over an already-built
   * result, so it must never be able to overwrite a key the verdict owns. If the
   * projection ever grew an `ok`/`error`/`holder` field this would start failing —
   * which is the point.
   */
  it('cannot collide with the verdict keys it is spread beside', () => {
    const projected = projectHolderContext({ itemId: 'WI-1' }, [], NOW) as object;
    for (const verdictKey of ['ok', 'error', 'holder', 'id', 'hint', 'result']) {
      expect(Object.keys(projected)).not.toContain(verdictKey);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guarded reader seam
// ─────────────────────────────────────────────────────────────────────────────

describe('holderContextReader', () => {
  /**
   * ⚠ THE REGRESSION THIS SEAM EXISTS FOR, broken by the WIRING rather than the
   * derivation. `resolveAgentIdentity` THROWS for a caller it cannot attribute,
   * and several tools carrying this advisory declare `requirePrincipal: false` —
   * an unattributed caller is explicitly legitimate for them. Resolving the reader
   * unguarded therefore turns "we cannot name you, so no reader-relative state"
   * into "your claim refusal failed": an enrichment failing the operation it
   * decorates, the one thing P-026 rule (f) forbids.
   */
  it('returns null for an unattributable ctx instead of throwing', () => {
    expect(() => holderContextReader({} as never)).not.toThrow();
    expect(holderContextReader({} as never)).toBeNull();
    expect(holderContextReader({ role: 'su' } as never)).toBeNull();
  });
});
