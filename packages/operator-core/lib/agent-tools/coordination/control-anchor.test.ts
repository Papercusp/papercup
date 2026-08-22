import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { deriveClaimScope } from './control-anchor';
import {
  CONTROL_ANCHOR_MAX_TOKENS,
  CONTROL_TRANSITION_MAX_TOKENS,
  CONTROL_TRANSITION_SCHEMA,
  decideControlTransitionDelivery,
  estimateControlAnchorTokens,
  normalizeControlAnchorState,
  persistControlAnchor,
  renderControlAnchor,
  type ControlAnchorState,
} from './control-anchor';

function state(overrides: Partial<ControlAnchorState> = {}): ControlAnchorState {
  return {
    modes: ['ideate', 'auto', 'auto'],
    loop: { active: true, intervalSec: 60 },
    carry: 'warm',
    route: { kind: 'self' },
    scope: {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      plan: 'agent-operability-improvements-implementation-2026-07-13',
      items: ['P-014', 'P-013', 'P-013'],
    },
    ...overrides,
  };
}

function inMemoryPersistSql() {
  let generation = 0;
  let current: ControlAnchorState | null = null;
  let updatedAt = '2026-07-13T18:00:00.000Z';
  let tick = 0;
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const next = JSON.parse(String(values[2])) as ControlAnchorState;
    if (current == null || JSON.stringify(current) !== JSON.stringify(next)) {
      generation += 1;
      current = next;
      updatedAt = `2026-07-13T18:00:0${tick++}.000Z`;
    }
    return [{
      control_generation: generation,
      control_state: current,
      control_updated_at: updatedAt,
      control_transition: null,
    }];
  }) as unknown as Sql;
  return sql;
}

describe('CTRL anchor wakeSource (WI-7302 part 2)', () => {
  it('OMITS wakeSource entirely when the leg did not resolve — absent is UNKNOWN', () => {
    // Never normalize an unresolved leg into 'none': that is a positive,
    // escalation-worthy claim ("nothing will ever wake this session") and a
    // degraded query must not be able to manufacture it.
    const out = normalizeControlAnchorState(state());
    expect('wakeSource' in out).toBe(false);
  });

  it('carries a resolved wakeSource through normalization', () => {
    expect(normalizeControlAnchorState({ ...state(), wakeSource: 'none' })).toMatchObject({
      wakeSource: 'none',
    });
    expect(normalizeControlAnchorState({ ...state(), wakeSource: 'event' })).toMatchObject({
      wakeSource: 'event',
    });
  });

  it('preserves the durable released lifecycle marker in the compact anchor', () => {
    expect(
      normalizeControlAnchorState({
        ...state(),
        lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' } },
      }),
    ).toMatchObject({
      lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' } },
    });
  });

  it('stays inside the anchor token budget with wakeSource present', () => {
    // The anchor is re-delivered on every post-compaction orient, which is why
    // the prose warning lives on the recovery block and only a short enum
    // lives here.
    const withField = estimateControlAnchorTokens(
      normalizeControlAnchorState({ ...state(), wakeSource: 'none' }),
    );
    expect(withField).toBeLessThan(CONTROL_ANCHOR_MAX_TOKENS);
  });
});

describe('compact durable CTRL anchor', () => {
  it('canonicalizes duplicated modes/items so equivalent reads are byte-stable', () => {
    expect(normalizeControlAnchorState(state())).toMatchObject({
      modes: ['auto', 'ideate'],
      scope: { items: ['P-013', 'P-014'] },
    });
  });

  it('holds generation on an unchanged reconciliation and increments on semantic change', async () => {
    const sql = inMemoryPersistSql();
    const a = await persistControlAnchor(
      { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state() },
      sql,
    );
    const b = await persistControlAnchor(
      { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state() },
      sql,
    );
    const c = await persistControlAnchor(
      {
        ownerId: 'su-x',
        workspaceId: 'papercusp-workspace',
        state: state({ carry: 'cold' }),
      },
      sql,
    );
    expect([a.generation, b.generation, c.generation]).toEqual([1, 1, 2]);
    expect(b.updatedAt).toBe(a.updatedAt);
    expect(c.updatedAt).not.toBe(b.updatedAt);
  });

  it('carries provenance, a full-resync rule, and an enforced serialized token budget', () => {
    const anchor = renderControlAnchor({
      ownerId: 'su-x',
      generation: 9,
      state: state({
        scope: {
          ...state().scope,
          items: Array.from({ length: 40 }, (_, i) => `P-${String(i).padStart(3, '0')}`),
        },
      }),
      updatedAt: '2026-07-13T18:00:00.000Z',
    });
    expect(anchor.state.scope.items).toHaveLength(12);
    expect(anchor.state.scope.itemsMore).toBe(28);
    expect(anchor.resync).toEqual({
      on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
      verb: 'coord:orient',
      args: { afterCompaction: true },
      rule: 'replace-full-never-merge-behind',
    });
    expect(anchor.provenance.source).toBe('harness_shared.session_briefs.control_state');
    expect(anchor.budget.estimatedTokens).toBe(estimateControlAnchorTokens(anchor));
    expect(anchor.budget.estimatedTokens).toBeLessThanOrEqual(CONTROL_ANCHOR_MAX_TOKENS);
  });

  it('delivers only an exact next-generation transition and preserves mutation provenance', () => {
    const transition = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      previousGeneration: 4,
      generation: 5,
      state: state({ carry: 'cold' }),
      provenance: {
        origin: 'owner' as const,
        actorId: 'su-x',
        source: 'mode:set' as const,
        ownerDirected: true,
        recordedAt: '2026-07-13T18:01:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-x',
      deliveredGeneration: 4,
      generation: 5,
      state: transition.state,
      transition,
      updatedAt: transition.provenance.recordedAt,
    });
    expect(delivery).toMatchObject({
      kind: 'transition',
      reason: 'next-generation',
      previousGeneration: 4,
      generation: 5,
      provenance: { origin: 'owner', actorId: 'su-x', ownerDirected: true },
    });
    expect(delivery.budget.estimatedTokens).toBeLessThanOrEqual(CONTROL_TRANSITION_MAX_TOKENS);
  });

  it('rejects generation-behind payloads and full-resyncs from current anchor state', () => {
    const current = state({ carry: 'cold', modes: ['auto'] });
    const stale = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      previousGeneration: 2,
      generation: 3,
      state: state({ carry: 'warm', modes: ['ideate'] }),
      provenance: {
        origin: 'agent' as const,
        actorId: 'su-old',
        source: 'loop:arm' as const,
        ownerDirected: false,
        recordedAt: '2026-07-13T18:00:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-x',
      deliveredGeneration: 2,
      generation: 5,
      state: current,
      transition: stale,
      updatedAt: '2026-07-13T18:02:00.000Z',
    });
    expect(delivery).toMatchObject({
      kind: 'full-resync',
      reason: 'generation-mismatch',
      previousGeneration: 2,
      generation: 5,
      state: { carry: 'cold', modes: ['auto'] },
      provenance: { origin: 'system', source: 'control-anchor:reconcile' },
    });
    expect(delivery.state).not.toEqual(stale.state);
  });
});

describe('deriveClaimScope — an agent must not lose its own lane to a lapsed lease', () => {
  const claim = (item: string, lease_valid: boolean) => ({
    harness_slug: 'papercusp',
    plan_slug: 'retire-mug-kettle-su-only-2026-08-09',
    item_id: item,
    lease_valid,
  });

  it('REGRESSION (2026-08-10): a lapsed-but-unreleased claim still yields plan AND items', () => {
    // The exact production failure. A session driving this plan respawned and
    // reported `scope: { plan: null, items: [] }` while its P-034 claim row was
    // still present and unreleased — the 1200s lease had lapsed 13h earlier.
    // Filtering self-scope by expires_ts emptied `items`, and `plan` then fell
    // through to null. The agent lost its mission and had to ask the owner.
    const scope = deriveClaimScope([claim('P-034', false)], null, null);

    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
    expect(scope.harness).toBe('papercusp');
    // Still ours, but the lease is cold — surfaced so a caller re-claims
    // before editing rather than assuming peers are locked out.
    expect(scope.lapsed).toEqual(['P-034']);
  });

  it('a live lease is not reported as lapsed', () => {
    const scope = deriveClaimScope([claim('P-034', true)], null, null);
    expect(scope.items).toEqual(['P-034']);
    expect(scope.lapsed).toEqual([]);
  });

  it('the session brief wins for the plan when it has one', () => {
    const scope = deriveClaimScope(
      [claim('P-034', false), { ...claim('P-999', true), plan_slug: 'other-plan' }],
      'retire-mug-kettle-su-only-2026-08-09',
      'papercusp',
    );
    // Only the briefed plan's items form the lane — a stray claim on another
    // plan must not leak in.
    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
  });

  it('falls back to the held claim lane when a stale brief plan has no matching claim', () => {
    const scope = deriveClaimScope(
      [{ ...claim('P-005', true), plan_slug: 'rem-dream-recombination-2026-08-17' }],
      'dream-cycle-operator-control',
      'papercusp',
    );

    expect(scope).toEqual({
      harness: 'papercusp',
      plan: 'rem-dream-recombination-2026-08-17',
      items: ['P-005'],
      lapsed: [],
    });
  });

  it('with no brief, the lane is a SINGLE plan — claims across plans do not merge', () => {
    // Before the fix the no-brief branch passed every row through, so an agent
    // holding items on two plans got a lane whose items did not all belong to
    // the plan reported beside them.
    const scope = deriveClaimScope(
      [claim('P-034', false), { ...claim('P-999', true), plan_slug: 'other-plan' }],
      null,
      null,
    );
    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
  });

  it('no claims and no brief is an empty lane, not a crash', () => {
    expect(deriveClaimScope([], null, null)).toEqual({
      harness: null,
      plan: null,
      items: [],
      lapsed: [],
    });
  });
});
