import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachHolderContext,
  rowHasLiveHolder,
  holderLensReader,
  HOLDER_CONTEXT_SCHEMA,
  HOLDER_LENS_DISTINCT_CAP,
} from './_holder-lens';
import {
  projectHolderContext,
  type HolderContextSources,
  type HolderGoalRecord,
} from '../../coord/holder-context';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';
import { AGENT_GOAL_CELL } from '../../cell-registrations';

/**
 * _holder-lens.test.ts — P-030's suite (plan `unified-agent-state-plane-2026-07-27`).
 *
 * The acceptance: "a reader listing claimed work items sees each holder's goal +
 * staleness WITHOUT attempting a claim, and a deliberate bypass of
 * `getCell(cell, reader)` here turns P-028's suite RED."
 *
 * The GATE half lives with the projection (`coord/holder-context.test.ts`) — the
 * lens has no goal read of its own to bypass, which is exactly the point of it
 * being a lens. What lives HERE is the lens's own contract: which rows it
 * decorates, that the row always survives, that the shape reaching the wire
 * matches the projection, and that it cannot fail the read it decorates.
 *
 * ⚠ NO MODULE MOCKING. The IO legs are INJECTED (`opts.sources`), the same split
 * P-026 uses, so this suite exercises the real lens against real projections
 * without a database — and a change to the source CONTRACT breaks it loudly
 * rather than being absorbed by a stub that no longer matches.
 */

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const reader = { ownerId: 'su-reader' };

// ⚠ The cell gate is real, so the suite must register the cell or every assertion
// about a disclosed goal would pass vacuously against a closed gate.
beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(AGENT_GOAL_CELL);
});

/** Injected goal leg: a fixed record per holder, nothing else. */
function sourcesFor(
  goalByOwner: Record<string, Partial<HolderGoalRecord> | null>,
  onCall?: () => void,
): HolderContextSources {
  return {
    holderGoal: async (owner: string) => {
      onCall?.();
      const g = goalByOwner[owner];
      return g ? { intent: null, acquiredTs: new Date(NOW - 60_000).toISOString(), ...g } as HolderGoalRecord : null;
    },
    holderAssumptionKeys: async () => [],
  };
}

const row = (id: string, assignee: string | null, state: string) => ({ id, assignee, state });

// ─────────────────────────────────────────────────────────────────────────────
// Which rows get a holder at all
// ─────────────────────────────────────────────────────────────────────────────

describe('rowHasLiveHolder — live claims only', () => {
  it('accepts a held, non-terminal row', () => {
    expect(rowHasLiveHolder({ assignee: 'su-a', state: 'open' })).toBe(true);
    expect(rowHasLiveHolder({ assignee: 'su-a', state: 'wip' })).toBe(true);
  });

  it('rejects an unheld row', () => {
    expect(rowHasLiveHolder({ assignee: null, state: 'open' })).toBe(false);
    expect(rowHasLiveHolder({ assignee: '   ', state: 'open' })).toBe(false);
  });

  /**
   * ⚠ EVERY family's close, not a hand-listed subset. `passed` is the FEATURE
   * family's normal close and `resolved` the ISSUE family's — a lens that only
   * knew `done`/`closed` would decorate finished rows (5,073 of them, measured
   * 2026-07-27) with their holder's CURRENT, unrelated goal, reading as "this is
   * what they are doing about this item".
   */
  it('rejects a terminal row in either family dialect', () => {
    for (const state of ['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped']) {
      expect(rowHasLiveHolder({ assignee: 'su-a', state }), state).toBe(false);
    }
  });

  /** An unknown/blank state fails toward SHOWING — the harmless direction. Failing
   *  toward hiding would silently blank the field for a whole family the moment its
   *  vocabulary widened. */
  it('treats an unrecognised or blank state as non-terminal', () => {
    expect(rowHasLiveHolder({ assignee: 'su-a', state: '' })).toBe(true);
    expect(rowHasLiveHolder({ assignee: 'su-a', state: 'some-new-state' })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-056 — the row ALWAYS stays; only the holder field varies
// ─────────────────────────────────────────────────────────────────────────────

describe('D-056 — visibility never leaks through the shape of the list', () => {
  it('decorates held live rows and leaves the rest untouched, in order', async () => {
    const rows = await attachHolderContext(
      [row('WI-1', 'su-a', 'open'), row('WI-2', null, 'open'), row('WI-3', 'su-a', 'done')],
      reader,
      { sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }), nowMs: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(['WI-1', 'WI-2', 'WI-3']);
    expect(rows[0].holder?.goalRef).toBe('WI-6407');
    expect(rows[1].holder).toBeUndefined();
    expect(rows[2].holder).toBeUndefined();
  });

  it('carries the staleness the acceptance names, alongside the goal', async () => {
    const rows = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    // "each holder's goal + staleness, without attempting a claim" — D-060.
    expect(rows[0].holder?.goalRef).toBe('WI-6407');
    expect(rows[0].holder?.stale).toBe(false);
    expect(rows[0].holder?.declaredAt).toBeTruthy();
  });

  /**
   * ⚠ THE ROW SURVIVES A REFUSAL. A reader the cell gate refuses gets the same ROW
   * SET as one it admits — only the `holder` field differs. Dropping the row would
   * leak the cell's visibility through the shape of the list, the failure D-056
   * states directly.
   */
  it('keeps every row when the goal cell refuses this reader', async () => {
    __resetCellRegistryForTests();
    registerCell({ ...AGENT_GOAL_CELL, visibility: { kind: 'owner', ref: 'su-else' } } as CellSpec);

    const rows = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBeUndefined();
    // …and NOT marked. A marker distinguishing "refused" from "none declared"
    // would be a probe oracle for state the reader may not see.
    expect(rows[0].holderOmitted).toBeUndefined();
  });

  it('a refused row is indistinguishable from a holder with no goal', async () => {
    const noGoal = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({ 'su-a': null }),
      nowMs: NOW,
    });
    __resetCellRegistryForTests();
    registerCell({ ...AGENT_GOAL_CELL, visibility: { kind: 'owner', ref: 'su-else' } } as CellSpec);
    const refused = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    expect(refused).toEqual(noGoal);
  });

  it('passes rows through untouched when the reader is unidentified', async () => {
    const rows = await attachHolderContext([row('WI-1', 'su-a', 'open')], { ownerId: '  ' }, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    expect(rows[0].holder).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-092 / D-093 — the disclosure reaches the row
// ─────────────────────────────────────────────────────────────────────────────

describe('D-093 — a divergent holder is disclosed on the row', () => {
  /**
   * ⚠ THE DEFECT THE LIVE EXERCISE FOUND, AND NO FIXTURE WOULD HAVE.
   *
   * `competing` is a HOLDER-level fact. Projected onto a row it becomes a
   * ROW-level claim, and for a multi-item holder the raw list names the very row
   * the reader is looking at as a rival to itself: on `WI-6410`, with the goal
   * resolved to `EI-1881…`, it read "…and they are also competing on WI-6410".
   * Measured live 2026-07-27: 3 of 18 decorated rows — every multi-item holder,
   * i.e. exactly the population the field exists to serve.
   */
  it('never names the row itself among its own competing claims', async () => {
    const rows = await attachHolderContext(
      [row('WI-6410', 'su-a', 'open'), row('EI-1881', 'su-a', 'open')],
      reader,
      {
        sources: sourcesFor({
          'su-a': {
            itemId: 'EI-1881',
            agreement: 'divergent',
            competing: ['WI-6410', 'some-plan#P-007'],
          },
        }),
        nowMs: NOW,
      },
    );
    // On WI-6410 the row's own ref is dropped; the genuine rival survives.
    expect(rows[0].holder?.competing).toEqual(['some-plan#P-007']);
    // …and the real signal is intact: the goal is NOT this row.
    expect(rows[0].holder?.goalRef).toBe('EI-1881');

    // On the goal's OWN row, WI-6410 is a genuine competing claim and stays.
    expect(rows[1].holder?.competing).toEqual(['WI-6410', 'some-plan#P-007']);
  });

  it('leaves competing untouched when the row is not among them', async () => {
    const rows = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({
        'su-a': { itemId: 'WI-1', agreement: 'divergent', competing: ['some-plan#P-402'] },
      }),
      nowMs: NOW,
    });
    expect(rows[0].holder?.competing).toEqual(['some-plan#P-402']);
  });

  it('renders agreement and competing, not just goalRef', async () => {
    const rows = await attachHolderContext([row('WI-1', 'su-a', 'open')], reader, {
      sources: sourcesFor({
        'su-a': { itemId: 'WI-6407', agreement: 'divergent', competing: ['WI-6410'] },
      }),
      nowMs: NOW,
    });
    expect(rows[0].holder?.goalRef).toBe('WI-6407');
    expect(rows[0].holder?.agreement).toBe('divergent');
    expect(rows[0].holder?.competing).toEqual(['WI-6410']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wire schema cannot drift behind the projection
// ─────────────────────────────────────────────────────────────────────────────

describe('HOLDER_CONTEXT_SCHEMA tracks the projection', () => {
  /**
   * ⚠ THE FAILURE THIS PREVENTS IS SILENT. A tool's zod `result` STRIPS undeclared
   * keys, so a schema lagging the projection does not error — it deletes the new
   * field from every response. D-093 adding two fields is exactly such a moment,
   * and without this the amendment could have shipped invisible on
   * `work_items:list` while every other test stayed green.
   */
  it('declares exactly the projection\'s key set', () => {
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
// Bounds + totality
// ─────────────────────────────────────────────────────────────────────────────

describe('the fan-out is bounded and the read cannot fail', () => {
  it('resolves each DISTINCT holder once, however many rows they hold', async () => {
    let calls = 0;
    const rows = await attachHolderContext(
      [row('A', 'su-a', 'open'), row('B', 'su-a', 'open'), row('C', 'su-a', 'wip')],
      reader,
      { sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }, () => (calls += 1)), nowMs: NOW },
    );
    expect(calls).toBe(1);
    expect(rows.every((r) => r.holder?.goalRef === 'WI-6407')).toBe(true);
  });

  /** The cap marks the rows it skipped — a fact about the READ, never about
   *  access, so it is safe to state explicitly. */
  it('marks rows beyond the distinct-holder cap without dropping them', async () => {
    const rows = await attachHolderContext(
      [row('A', 'su-a', 'open'), row('B', 'su-b', 'open')],
      reader,
      {
        sources: sourcesFor({ 'su-a': { itemId: 'WI-1' }, 'su-b': { itemId: 'WI-2' } }),
        distinctCap: 1,
        nowMs: NOW,
      },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].holder?.goalRef).toBe('WI-1');
    expect(rows[1].holder).toBeUndefined();
    expect(rows[1].holderOmitted).toBe('cap');
  });

  it('the default cap is above the measured live holder population', () => {
    // Measured 2026-07-27: 17 distinct holders across the WHOLE work_items table.
    // The cap exists for a fleet an order of magnitude larger, not for today's.
    expect(HOLDER_LENS_DISTINCT_CAP).toBeGreaterThan(17);
  });

  /**
   * ⚠ P-026 RULE (f). This decorates an ORDINARY read — a dead facts store or an
   * unreachable PG must cost the `holder` field and nothing else. A lens that can
   * reject turns a backlog listing into an outage.
   */
  it('a throwing source costs the field, never the rows', async () => {
    const rows = await attachHolderContext([row('A', 'su-a', 'open')], reader, {
      sources: {
        holderGoal: async () => {
          throw new Error('pg down');
        },
        holderAssumptionKeys: async () => {
          throw new Error('pg down');
        },
      },
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBeUndefined();
  });

  /**
   * ⚠ THE INPUT ROWS ARE CACHE-OWNED. `work_items:list`/`get` apply this lens to
   * the rows their (deliberately non-principal-scoped) cache RETURNS. Mutating
   * those in place would write one reader's holder context into the shared cached
   * value and serve it to the next reader — a silent cross-reader disclosure that
   * no content assertion could catch.
   */
  it('never mutates the rows it was given', async () => {
    const input = [row('A', 'su-a', 'open')];
    const out = await attachHolderContext(input, reader, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    expect(out[0].holder?.goalRef).toBe('WI-6407');
    expect(input[0]).not.toHaveProperty('holder');
  });

  it('tolerates an empty list', async () => {
    expect(await attachHolderContext([], reader)).toEqual([]);
  });

  /**
   * ⚠ THE REGRESSION THIS FILE ACTUALLY CAUGHT, and it is the rule the whole
   * projection is built around, broken by the wiring rather than the derivation.
   *
   * `resolveAgentIdentity` THROWS for a caller it cannot attribute, and BOTH
   * tools carrying this lens declare `requirePrincipal: false` — an unattributed
   * caller is explicitly legitimate for them. Resolving the reader unguarded
   * therefore turned "we cannot name you, so no reader-relative state" into "your
   * work-item read fails": an enrichment failing the operation it decorates,
   * which is the one thing P-026 rule (f) forbids. Caught by the existing
   * `work_items:get` suite, which is why the guarded seam is a named export
   * instead of two inline calls.
   */
  it('holderLensReader returns null for an unattributable ctx instead of throwing', () => {
    expect(() => holderLensReader({} as never)).not.toThrow();
    expect(holderLensReader({} as never)).toBeNull();
    // …and a null reader is simply a no-op for the read, never a failure.
    expect(holderLensReader({ role: 'su' } as never)).toBeNull();
  });

  it('a null reader leaves every row intact', async () => {
    const rows = await attachHolderContext([row('A', 'su-a', 'open')], null, {
      sources: sourcesFor({ 'su-a': { itemId: 'WI-6407' } }),
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBeUndefined();
  });
});
