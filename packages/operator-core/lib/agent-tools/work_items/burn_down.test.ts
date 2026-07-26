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

import { getWorkItem, listWorkItems } from '../../work-items';
import { listPresence } from '../coordination/presence';
import {
  buildBurnDownResult,
  buildCohortAudit,
  liveOwnersFromPresence,
} from './burn_down';

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
    createdAt: '2026-07-05T20:00:00.000Z',
    updatedAt: '2026-07-05T20:00:00.000Z',
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
        item({ id: 'WI-done', state: 'done', updatedAt: '2026-07-05T20:10:00.000Z' }),
        item({ id: 'EI-resolved', state: 'resolved', updatedAt: '2026-07-05T20:20:00.000Z' }),
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

  it('itemizes closedSince (terminal, updatedAt>since) and openedSince (createdAt>since), newest first', () => {
    const result = buildBurnDownResult(
      [
        item({
          id: 'WI-closed-old',
          state: 'done',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:05:00.000Z', // before since — not in closedSince
        }),
        item({
          id: 'WI-closed-new',
          state: 'resolved',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:20:00.000Z',
        }),
        item({
          id: 'WI-closed-newer',
          state: 'dropped',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-05T20:25:00.000Z',
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
    const bare = item({
      id: 'WI-bare',
      state: 'resolved',
      terminalOwner: 'su-2',
      terminalCompletionRef: 'done assertion only',
      terminalCompletionEvidence: null,
    });
    const open = item({ id: 'WI-open', state: 'open', assignee: 'su-3' });
    const audit = buildCohortAudit(
      ['WI-verified', 'WI-bare', 'WI-open', 'WI-missing'],
      [verified, bare, open],
    );
    expect(audit).toMatchObject({ requested: 4, found: 3, missing: 1, reopenRecommended: 1 });
    expect(audit.rows).toEqual([
      expect.objectContaining({
        id: 'WI-verified', bucket: 'terminal', closureKind: 'done',
        evidenceVerdict: 'verified', completionRef: 'sha:abc', reopenRecommended: false,
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
});
