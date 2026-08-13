import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WorkItem } from '../../work-items';

vi.mock('../../work-items', async (importOriginal) => ({
  // EI-18672701535825889: keep the real readWorkItemClaimHoldProvenance (+ its readers) —
  // burn_down's claim-hold reason enrichment depends on it, and a bare-object mock silently
  // leaves it `undefined`, TypeErroring on the very row this fix is about.
  ...(await importOriginal<object>()),
  listWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
}));

vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: vi.fn(),
  PRESENCE_STALE_MS: 60_000,
}));

import { getWorkItem, listWorkItems, WORK_ITEMS_MAX_LIMIT } from '../../work-items';
import { listPresence } from '../coordination/presence';
import {
  buildBurnDownResult,
  buildCohortAudit,
  liveOwnersFromPresence,
  applyLaneFence,
} from './burn_down';
import { shapeBurnDown } from './burn_down-shape';
import { P2P_LANE_EXCLUSION_TERMS, P2P_LANE_REJECTED_ANTI_TERMS } from '../../scheduler/p2p-lane-fence';

const mockListWorkItems = vi.mocked(listWorkItems);
const mockGetWorkItem = vi.mocked(getWorkItem);
const mockListPresence = vi.mocked(listPresence);
const tool = (await import('./burn_down')).default;

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'WI-1',
    kind: 'task',
    family: 'issue',
    harness: 'papercusp',
    title: 'title',
    summary: 'summary',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-07-05T20:00:00.000Z',
    updatedAt: '2026-07-05T20:00:00.000Z',
    closedAt: null,
    goalId: null,
    ...overrides,
  };
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: unknown }> }
  ).handler(args, ctx);
}

describe('work_items:burn_down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkItem.mockResolvedValue(null);
  });

  it('classifies terminal, in-flight, parked, and unclaimed rows', () => {
    const result = buildBurnDownResult(
      [
        // EI-18820653360383242: the delta is driven by closedAt, NOT updatedAt.
        item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z', closedAt: '2026-07-05T20:10:00.000Z' }),
        item({ id: 'EI-resolved', state: 'resolved', updatedAt: '2026-07-05T20:20:00.000Z', closedAt: '2026-07-05T20:20:00.000Z' }),
        item({ id: 'WI-live', assignee: 'su-live', takenAt: '2026-07-05T20:01:00.000Z' }),
        item({ id: 'WI-dead', assignee: 'su-dead' }),
        item({ id: 'WI-blocked', state: 'blocked' }),
        item({ id: 'WI-held', payload: { _claimHold: true } }),
        item({ id: 'WI-open' }),
      ],
      new Set(['su-live']),
      {
        harness: 'papercusp',
        generatedAt: '2026-07-05T20:30:00.000Z',
        since: '2026-07-05T20:15:00.000Z',
      },
    );

    expect(result.terminal).toMatchObject({
      total: 2,
      done: 1,
      resolved: 1,
      delta: 1,
    });
    expect(result.inFlight.map((r) => [r.id, r.assigneeLive])).toEqual([
      ['WI-live', true],
      ['WI-dead', false],
    ]);
    expect(result.parked.map((r) => [r.id, r.mechanism, r.aliasedState])).toEqual([
      ['WI-blocked', 'blocked', undefined],
      ['WI-held', 'claimHold', 'open'],
    ]);
    expect(result.unclaimed.map((r) => r.id)).toEqual(['WI-open']);
    expect(result.counts).toEqual({
      total: 7,
      terminal: 2,
      inFlight: 2,
      parked: 2,
      unclaimed: 1,
    });
  });

  it('EI-18672701535825889: claim-hold reason surfaces BOTH provenance conventions, and flags a genuine unattributed hold distinctly', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'WI-lease', payload: { _claimHold: true, held_open_by: 'su-alice', held_open_reason: 'verifying evidence' } }),
        item({ id: 'WI-park', payload: { _claimHold: true, claim_hold_by: 'su-bob', claim_hold_reason: 'D-003 policy-tier gate' } }),
        item({
          id: 'WI-both',
          payload: {
            _claimHold: true,
            held_open_by: 'su-carol',
            held_open_reason: 'active work',
            claim_hold_by: 'su-dan',
            claim_hold_reason: 'also parked earlier',
          },
        }),
        item({ id: 'WI-unattributed', payload: { _claimHold: true } }),
      ],
      new Set(),
      { harness: 'papercusp' },
    );

    const byId = new Map(result.parked.map((r) => [r.id, r.reason]));
    expect(byId.get('WI-lease')).toBe('held open by su-alice: verifying evidence');
    expect(byId.get('WI-park')).toBe('durably parked by su-bob: D-003 policy-tier gate');
    expect(byId.get('WI-both')).toBe(
      'held open by su-carol: active work; durably parked by su-dan: also parked earlier',
    );
    // The near-miss this item documents: a row with NEITHER field is the only genuine
    // "unattributed, safe to triage" case — everything else must say who + why.
    expect(byId.get('WI-unattributed')).toMatch(/UNATTRIBUTED/);
  });

  it('parks needs-human and actively blocked rows instead of counting them unclaimed (WI-4759)', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'EI-needs-human', payload: { needsHuman: true } }),
        item({
          id: 'EI-external-blocker',
          payload: {
            externalBlockers: [{
              kind: 'runtime',
              capability: 'live-dependency',
              capabilitySource: 'explicit',
              ref: 'runtime:test',
              summary: 'test runtime is unavailable',
              status: 'active',
              createdAt: '2026-07-05T20:00:00.000Z',
              createdBy: 'su-test',
              updatedAt: '2026-07-05T20:00:00.000Z',
            }],
          },
        }),
        item({ id: 'EI-unclaimed' }),
      ],
      new Set(),
      { harness: 'papercusp' },
    );

    expect(result.parked.map((row) => [row.id, row.mechanism])).toEqual([
      ['EI-needs-human', 'needs-human'],
      ['EI-external-blocker', 'external-blocker'],
    ]);
    expect(result.unclaimed.map((row) => row.id)).toEqual(['EI-unclaimed']);
    expect(result.counts).toMatchObject({ parked: 2, unclaimed: 1 });
  });

  it('omits closedSince/openedSince when `since` is not passed', () => {
    const result = buildBurnDownResult(
      [item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z' })],
      new Set(),
      { harness: 'papercusp' },
    );
    expect(result.closedSince).toBeUndefined();
    expect(result.openedSince).toBeUndefined();
  });

  it('itemizes closedSince (terminal, closedAt>since) and openedSince (createdAt>since), newest first', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-closed-old',
          state: 'done',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:05:00.000Z',
          closedAt: '2026-07-05T20:05:00.000Z', // before since — not in closedSince
        }),
        item({
          id: 'WI-closed-new',
          state: 'resolved',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:20:00.000Z',
          closedAt: '2026-07-05T20:20:00.000Z',
        }),
        item({
          id: 'WI-closed-newer',
          state: 'dropped',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:25:00.000Z',
          closedAt: '2026-07-05T20:25:00.000Z',
        }),
        item({
          id: 'WI-opened-new',
          state: 'open',
          createdAt: '2026-07-05T20:22:00.000Z',
          updatedAt: '2026-07-05T20:22:00.000Z',
        }),
        item({
          id: 'WI-opened-old',
          state: 'open',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
      new Set(),
      { harness: 'papercusp', since: '2026-07-05T20:15:00.000Z' },
    );
    expect(result.closedSince?.rows.map((r) => r.id)).toEqual(['WI-closed-newer', 'WI-closed-new']);
    expect(result.closedSince?.total).toBe(2);
    expect(result.closedSince?.truncated).toBe(false);
    expect(result.openedSince?.rows.map((r) => r.id)).toEqual(['WI-opened-new']);
    expect(result.openedSince?.total).toBe(1);
  });

  it('caps closedSince/openedSince at DELTA_ROW_CAP and reports truncated + true total', () => {
    const items = Array.from({ length: 35 }, (_, i) =>
      item({
        id: `WI-closed-${i}`,
        state: 'done',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: new Date(Date.parse('2026-07-05T20:15:01.000Z') + i * 1000).toISOString(),
        closedAt: new Date(Date.parse('2026-07-05T20:15:01.000Z') + i * 1000).toISOString(),
      }),
    );
    const result = buildBurnDownResult(items, new Set(), {
      harness: 'papercusp',
      since: '2026-07-05T20:15:00.000Z',
    });
    expect(result.closedSince?.rows).toHaveLength(30);
    expect(result.closedSince?.total).toBe(35);
    expect(result.closedSince?.truncated).toBe(true);
    // newest first: the last-created row (i=34) should be first.
    expect(result.closedSince?.rows[0]?.id).toBe('WI-closed-34');
  });

  // ---------------------------------------------------------------------------
  // EI-18820653360383242 — the regression guard for the defect this column exists
  // to end. A bulk write (a retag, a payload backfill, a sweep) moves updatedAt on
  // rows that closed weeks ago. Read that way, burn-down once reported 3,833 items
  // "closed in one hour" with terminal_owner NULL — indistinguishable from a real
  // fleet-scale mass unattributed close, and it cost two investigation cycles.
  //
  // A recent updatedAt must therefore NOT put a row in closedSince. And a row whose
  // close time is genuinely unknown (closed before migration 698) must be COUNTED
  // as undated rather than guessed at, so a reader can tell "nothing closed in this
  // window" apart from "this window predates the close stamp".
  // ---------------------------------------------------------------------------
  it('excludes a bulk-touched row with a recent updatedAt but no closedAt, and reports it as undated', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-bulk-touched',
          state: 'done',
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-07-05T20:29:00.000Z', // a sweep touched it just now
          closedAt: null, //                        but it actually closed long ago, time unknown
        }),
        item({
          id: 'WI-really-closed',
          state: 'done',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:20:00.000Z',
          closedAt: '2026-07-05T20:20:00.000Z',
        }),
      ],
      new Set(),
      { harness: 'papercusp', since: '2026-07-05T20:15:00.000Z' },
    );

    expect(result.closedSince?.rows.map((r) => r.id)).toEqual(['WI-really-closed']);
    expect(result.terminal.delta).toBe(1);
    // The undated row is neither counted nor silently dropped.
    expect(result.terminal.deltaClosedUndated).toBe(1);
  });

  it('derives live owners from non-stale fresh presence rows', () => {
    const live = liveOwnersFromPresence(
      [
        { ownerId: 'fresh', heartbeatAt: '2026-07-05T20:00:59.000Z' },
        { ownerId: 'old', heartbeatAt: '2026-07-05T19:59:00.000Z' },
        { ownerId: 'flagged-stale', heartbeatAt: '2026-07-05T20:00:59.000Z', stale: true },
        { ownerId: 'bad-date', heartbeatAt: 'not-a-date' },
      ],
      Date.parse('2026-07-05T20:01:00.000Z'),
    );
    expect([...live]).toEqual(['fresh']);
  });

  it('audits every fixed-cohort id with evidence verdict and reopen recommendation', () => {
    const verified = item({
      id: 'WI-verified',
      state: 'done',
      terminalOwner: 'su-1',
      terminalCompletionRef: 'sha:abc',
      terminalCompletionEvidence: {
        verifiedHow: 'unit',
        testsRun: 'npm test',
        testResult: '4/4 green',
      },
    });
    const committedWithoutRef = item({
      id: 'WI-committed-without-ref',
      state: 'done',
      terminalOwner: 'su-1',
      terminalCompletionRef: null,
      completionAuthority: 'committed',
      terminalCompletionEvidence: {
        verifiedHow: 'integration',
        testsRun: 'npm test',
        testResult: '8/8 green',
      },
    });
    const bare = item({
      id: 'WI-bare',
      state: 'resolved',
      terminalOwner: 'su-2',
      terminalCompletionRef: 'done assertion only',
      terminalCompletionEvidence: null,
    });
    const open = item({ id: 'WI-open', state: 'open', assignee: 'su-3' });
    const audit = buildCohortAudit(
      ['WI-verified', 'WI-committed-without-ref', 'WI-bare', 'WI-open', 'WI-missing'],
      [verified, committedWithoutRef, bare, open],
    );
    expect(audit).toMatchObject({ requested: 5, found: 4, missing: 1, reopenRecommended: 1 });
    expect(audit.rows).toEqual([
      expect.objectContaining({
        id: 'WI-verified', bucket: 'terminal', closureKind: 'done',
        evidenceVerdict: 'verified', completionRef: 'sha:abc', reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-committed-without-ref', bucket: 'terminal', closureKind: 'done',
        evidenceVerdict: 'verified', completionRef: null, reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-bare', bucket: 'terminal', closureKind: 'resolved',
        evidenceVerdict: 'missing', reopenRecommended: true,
      }),
      expect.objectContaining({
        id: 'WI-open', bucket: 'in-flight', closureKind: null,
        evidenceVerdict: 'not-applicable', reopenRecommended: false,
      }),
      expect.objectContaining({
        id: 'WI-missing', bucket: 'missing', title: null,
        evidenceVerdict: 'not-applicable', reopenRecommended: false,
      }),
    ]);
  });

  it('wires the tool to list work-items and workspace-scoped presence', async () => {
    mockListWorkItems.mockResolvedValue([item({ id: 'WI-live', assignee: 'su-live' })]);
    mockListPresence.mockResolvedValue([
      {
        ownerId: 'su-live',
        ownerLabel: 'su live',
        heartbeatAt: new Date().toISOString(),
      } as never,
    ]);

    const res = await callTool({ harness: 'papercusp', includeChildren: true }, { workspaceId: 'ws-test' });

    expect(mockListWorkItems).toHaveBeenCalledWith({
      harness: 'papercusp',
      kind: undefined,
      includeChildren: true,
      limit: 2000,
    });
    expect(mockListPresence).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    expect(res.data).toMatchObject({
      ok: true,
      harness: 'papercusp',
      counts: { total: 1, terminal: 0, inFlight: 1, parked: 0, unclaimed: 0 },
    });
  });

  it('payload-tier shaping keeps a large census schema-valid and never inserts a string into row arrays', () => {
    const result = buildBurnDownResult(
      Array.from({ length: 2000 }, (_, index) =>
        item({
          id: `WI-live-${index}`,
          title: `long title ${'x'.repeat(240)}`,
          assignee: `su-${index}`,
          takenAt: '2026-08-11T20:00:00.000Z',
          updatedAt: '2026-08-11T20:00:00.000Z',
        }),
      ),
      new Set(),
      { harness: 'papercusp', since: '2026-08-11T18:48:00.000Z', rowLimit: 2000 },
    );
    const shaped = shapeBurnDown(result, 'trimmed', { limit: 2000 }) as Record<string, unknown>;
    const parsed = (tool as unknown as {
      result: { safeParse: (value: unknown) => { success: boolean; error?: unknown } };
    }).result.safeParse(shaped);

    expect(parsed.success).toBe(true);
    expect(JSON.stringify(shaped).length).toBeLessThan(30_000);
    expect(shaped.counts).toEqual(expect.objectContaining({ inFlight: 2000 }));
    expect(shaped.inFlight).toHaveLength(10);
    expect((shaped.inFlight as unknown[]).every((row) => row && typeof row === 'object')).toBe(true);
    expect((shaped.inFlight as unknown[]).some((row) => typeof row === 'string')).toBe(false);
    expect(shaped.presentation).toEqual(expect.objectContaining({
      tier: 'trimmed',
      rowCap: 10,
      rows: expect.objectContaining({
        inFlight: { shown: 10, total: 2000, truncated: true },
      }),
    }));
  });

  // ---------------------------------------------------------------------------
  // WI-37381 — the recurrence guard for the defect this fix ends: `limit` used to
  // bound the FETCH that terminal.*/counts.* were computed from, so a small `limit`
  // (e.g. 5) could report terminal.total 0 / deltaBy.fleet 0 for a queue with 1693
  // real terminal rows. `limit` must bound only the returned row lists.
  // ---------------------------------------------------------------------------
  it('WI-37381: `limit` never bounds the aggregate fetch — the census always uses WORK_ITEMS_MAX_LIMIT', async () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item({ id: `WI-done-${i}`, state: 'done' })),
      ...Array.from({ length: 4 }, (_, i) => item({ id: `WI-live-${i}`, assignee: `su-${i}` })),
    ];
    mockListWorkItems.mockResolvedValue(items);
    mockListPresence.mockResolvedValue([]);

    const res = await callTool({ harness: 'papercusp', limit: 2 });

    // The underlying fetch is NEVER bounded by the caller's `limit` — always the hard cap.
    expect(mockListWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: WORK_ITEMS_MAX_LIMIT }),
    );

    const data = res.data as {
      terminal: { total: number; truncatedByLimit: boolean; censusLimit: number };
      counts: { total: number; terminal: number; inFlight: number };
      inFlight: unknown[];
    };
    // Aggregate counts reflect the TRUE bucket sizes — a limit:2 request must not zero
    // (or otherwise shrink) terminal.total / counts.*, the exact bug this guards.
    expect(data.terminal.total).toBe(6);
    expect(data.counts).toMatchObject({ total: 10, terminal: 6, inFlight: 4 });
    expect(data.terminal.truncatedByLimit).toBe(false);
    expect(data.terminal.censusLimit).toBe(WORK_ITEMS_MAX_LIMIT);
    // `limit` DOES bound the returned row list (display only).
    expect(data.inFlight).toHaveLength(2);
  });

  it('WI-37381: buildBurnDownResult — rowLimit caps only inFlight/parked/unclaimed row arrays, never their counts', () => {
    const result = buildBurnDownResult(
      [
        item({ id: 'WI-1', assignee: 'su-1' }),
        item({ id: 'WI-2', assignee: 'su-2' }),
        item({ id: 'WI-3', assignee: 'su-3' }),
      ],
      new Set(),
      { harness: 'papercusp', rowLimit: 1 },
    );
    expect(result.inFlight).toHaveLength(1);
    expect(result.counts.inFlight).toBe(3);
  });

  it('WI-37381: buildBurnDownResult — censusLimit/truncatedByLimit are decoupled from rowLimit and reflect the real fetch size', () => {
    const untruncated = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
      censusLimit: 2000,
    });
    expect(untruncated.terminal).toMatchObject({ censusLimit: 2000, truncatedByLimit: false });

    // items.length (1) >= censusLimit (1) — the fetch itself hit its cap, so the
    // aggregate may still be an undercount even though the caller passed no `limit`.
    const truncated = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
      censusLimit: 1,
    });
    expect(truncated.terminal).toMatchObject({ censusLimit: 1, truncatedByLimit: true });

    // No censusLimit passed (the fixed `ids`-cohort path) — never reported as truncated.
    const cohort = buildBurnDownResult([item({ id: 'WI-done', state: 'done' })], new Set(), {
      harness: 'papercusp',
    });
    expect(cohort.terminal.truncatedByLimit).toBe(false);
  });

  it('loads an exact ID cohort and returns one audit row per requested ID', async () => {
    mockGetWorkItem.mockImplementation(async (id) =>
      id === 'WI-found'
        ? item({
            id,
            state: 'closed',
            terminalCompletionRef: 'ref',
            terminalOwner: 'su-1',
            terminalCompletionEvidence: { verifiedHow: 'manual', testsRun: 'probe', testResult: 'ok' },
          })
        : null,
    );
    mockListPresence.mockResolvedValue([]);

    const res = await callTool({ harness: 'papercusp', ids: ['WI-found', 'WI-missing', 'WI-found'] });

    expect(mockListWorkItems).not.toHaveBeenCalled();
    expect(mockGetWorkItem).toHaveBeenCalledTimes(2);
    expect(mockGetWorkItem).toHaveBeenCalledWith('WI-found', 'papercusp');
    expect(res.data).toMatchObject({
      counts: { total: 1, terminal: 1 },
      cohortAudit: { requested: 2, found: 1, missing: 1, reopenRecommended: 0 },
    });
  });

  // EI-19313376980892266 fix B — PROVENANCE ON A DERIVED NUMBER.
  // `terminal.delta` is harness-WIDE. Read as one fleet's output it over-reports by
  // whatever the rest of the harness closed; that misread put ~30 closes/hour in front
  // of an owner when the reporting fleet's real figure was ~6.6.
  describe('terminal.deltaBy — attribution of the burn-down delta', () => {
    const since = '2026-07-05T20:00:00.000Z';
    const closedAt = '2026-07-05T20:30:00.000Z';
    const fleetScope = {
      slug: 'my-fleet',
      members: new Set(['su-mine-alive', 'su-mine-DEAD']),
      source: 'arg' as const,
    };
    const mixedCohort = [
      item({ id: 'WI-1', state: 'done', closedAt, terminalOwner: 'su-mine-alive' }),
      // The member that has since DIED. A live-presence basis drops exactly this row —
      // the 55%-under-report measured on a real fleet (708 ever vs 318 live).
      item({ id: 'WI-2', state: 'done', closedAt, terminalOwner: 'su-mine-DEAD' }),
      item({ id: 'WI-3', state: 'resolved', closedAt, terminalOwner: 'su-someone-else' }),
      item({ id: 'WI-4', state: 'done', closedAt, terminalOwner: 'system:plan-item-reconcile' }),
      // No `system:` prefix and no constant anywhere — a membership-only classifier
      // misfiles this as an agent (42 such closes in 30 days, measured).
      item({ id: 'WI-5', state: 'resolved', closedAt, terminalOwner: 'watchdog-green-resolve' }),
      item({ id: 'WI-6', state: 'done', closedAt, terminalOwner: null }),
    ];

    it('splits the delta by fleet / other agents / system / unattributed', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(['su-mine-alive']), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });

      expect(r.terminal.delta).toBe(6);
      expect(r.terminal.deltaBy).toMatchObject({
        fleet: 2,
        otherAgents: 1,
        system: 2,
        unattributed: 1,
      });
    });

    it('counts a fleet member that is DEAD — attribution is ever-members, not live presence', () => {
      // The whole point of the ledger basis: `liveOwners` deliberately contains only the
      // one live member, yet BOTH members' closes must be credited to the fleet.
      const r = buildBurnDownResult(mixedCohort, new Set(['su-mine-alive']), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });
      expect(r.terminal.deltaBy?.fleet).toBe(2);
      expect(r.terminal.deltaBy?.basis.membership).toBe('ever-members');
    });

    it('classifies un-prefixed watchdog identities as system, not as an agent', () => {
      const r = buildBurnDownResult(
        [item({ id: 'WI-w', state: 'done', closedAt, terminalOwner: 'watchdog-green-resolve' })],
        new Set(),
        { harness: 'papercusp', since, fleet: fleetScope },
      );
      expect(r.terminal.deltaBy).toMatchObject({ system: 1, otherAgents: 0 });
    });

    it('keeps unattributed closes OUT of system — they are different facts', () => {
      // Folding a null terminal_owner into `system` would hide the mass-unattributed-close
      // signature EI-18820653360383242 exists to keep visible.
      const r = buildBurnDownResult(
        [item({ id: 'WI-n', state: 'done', closedAt, terminalOwner: null })],
        new Set(),
        { harness: 'papercusp', since, fleet: fleetScope },
      );
      expect(r.terminal.deltaBy).toMatchObject({ unattributed: 1, system: 0 });
    });

    // THE FALSIFIER for the whole field: if these four ever stop summing to `delta`,
    // the split is silently lying about a total it claims to partition.
    it('PARTITIONS delta exactly — the four buckets always sum to it', () => {
      for (const fleet of [fleetScope, null]) {
        const r = buildBurnDownResult(mixedCohort, new Set(), {
          harness: 'papercusp',
          since,
          fleet,
        });
        const d = r.terminal.deltaBy!;
        expect((d.fleet ?? 0) + d.otherAgents + d.system + d.unattributed).toBe(r.terminal.delta);
        expect(r.terminal.deltaByPartitions).toBe(true);
      }
    });

    it('reports fleet as NULL (never 0) when no fleet is in scope', () => {
      // 0 asserts "the fleet closed nothing" — a fabricated verdict from a failed or
      // absent lookup. null says "no fleet was resolved", which is the actual fact.
      const r = buildBurnDownResult(mixedCohort, new Set(), {
        harness: 'papercusp',
        since,
        fleet: null,
      });
      expect(r.terminal.deltaBy?.fleet).toBeNull();
      expect(r.terminal.deltaBy?.basis.fleet).toBeNull();
      expect(r.terminal.deltaBy?.basis.note).toMatch(/no fleet in scope/i);
      // With no fleet, every agent close lands in otherAgents rather than vanishing.
      expect(r.terminal.deltaBy?.otherAgents).toBe(3);
    });

    it('is absent without `since` — there is no delta to attribute', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(), { harness: 'papercusp' });
      expect(r.terminal.deltaBy).toBeUndefined();
      expect(r.terminal.deltaByPartitions).toBeUndefined();
    });

    it('names the scoping that produced the split', () => {
      const r = buildBurnDownResult(mixedCohort, new Set(), {
        harness: 'papercusp',
        since,
        fleet: fleetScope,
      });
      expect(r.terminal.deltaBy?.basis).toMatchObject({
        fleet: 'my-fleet',
        fleetSource: 'arg',
        membership: 'ever-members',
        memberCount: 2,
      });
    });
  });
});

/**
 * P-011 (fleet-lead-instrumentation-audit-2026-08-09) — the drain leader measured
 * burn-down by hand-rolling SQL with a hand-maintained p2p title regex re-typed
 * into every query, because the real metric (terminal transitions) lived here and
 * this tool could not express a LANE. The property under test is that the fence
 * applied here is the CLAIM PATH's fence, not a second copy of it.
 */
describe('applyLaneFence (P-011) — burn-down scoped to the lane the fleet may claim from', () => {
  it('excludes p2p work and keeps local work, counting what it removed', () => {
    const items = [
      item({ id: 'WI-p1', title: 'hypercore session leaks a handle' }),
      item({ id: 'WI-p2', title: 'autobase view rebuild is quadratic' }),
      item({ id: 'WI-l1', title: 'operator restart drops the pending cut' }),
      item({ id: 'WI-l2', title: 'plans:get returns a stale contentHash' }),
    ];
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(rows.map((r) => r.id)).toEqual(['WI-l1', 'WI-l2']);
    expect(report).toMatchObject({ lane: 'p2p-lane', candidates: 4, counted: 2, excluded: 2 });
  });

  // D-007: the substrate vocabulary leads a second life naming ordinary single-box
  // release-engineering work here (this repo BUNDLES a corestore seed into the
  // desktop release), and 'peer' routinely means ANOTHER AGENT. Those terms were
  // REJECTED from the fence for that reason. Pinning it through this path too,
  // because a burn-down that quietly dropped them would hide from the fleet exactly
  // the local work it can act on.
  it('does NOT exclude the D-007 anti-terms — substrate vocabulary is not p2p work here', () => {
    const items = [
      item({ id: 'WI-a1', title: 'corestore seed bloats the desktop bundle' }),
      item({ id: 'WI-a2', title: 'peer agent wedges the shared tree lock' }),
      item({ id: 'WI-a3', title: 'cannot replicate the floor set locally' }),
    ];
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(rows.map((r) => r.id)).toEqual(['WI-a1', 'WI-a2', 'WI-a3']);
    expect(report.excluded).toBe(0);
    // Guard the premise, not just the outcome: if one of these terms is ever added
    // to the fence, this test should fail HERE with a clear reason rather than as a
    // mysterious row-count change above.
    for (const term of ['corestore', 'peer', 'replicate']) {
      expect(P2P_LANE_EXCLUSION_TERMS as readonly string[]).not.toContain(term);
      expect(P2P_LANE_REJECTED_ANTI_TERMS as readonly string[]).toContain(term);
    }
  });

  // CONTROL (falsifiability): the fence must be the SHARED macro, evaluated by the
  // claim path's own matcher — not a local regex that happens to agree today. Drive
  // every real exclusion term through it; a hand-rolled copy drifts from this list
  // the moment the module changes, which is the failure P-011 is about.
  it('CONTROL: every term in the shared fence actually excludes, via the claim-path matcher', () => {
    const items = P2P_LANE_EXCLUSION_TERMS.map((term, i) =>
      item({ id: `WI-${i}`, title: `${term} regression in the swarm` }),
    );
    const { rows, report } = applyLaneFence(items, 'p2p-lane');
    expect(report.candidates).toBe(P2P_LANE_EXCLUSION_TERMS.length);
    expect(rows).toEqual([]);
    expect(report.excluded).toBe(P2P_LANE_EXCLUSION_TERMS.length);
  });

  it('is a no-op report on an empty census rather than inventing a scope', () => {
    const { rows, report } = applyLaneFence([], 'p2p-lane');
    expect(rows).toEqual([]);
    expect(report).toMatchObject({ candidates: 0, counted: 0, excluded: 0 });
  });
});
