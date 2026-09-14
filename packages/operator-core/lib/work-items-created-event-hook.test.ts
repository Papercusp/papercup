/**
 * work-items-created-event-hook.test.ts — createWorkItem fires
 * emitWorkItemCreatedEvent for EVERY new item, both families (EI-8296: no
 * creation event existed, so "alert on a new critical item" fell back to a
 * 15-min poll+diff plan). Mirrors work-items-urgent.test.ts's mocking
 * scaffold; the emit's own key/payload shape is unit-covered directly in
 * work-items-events.test.ts — this file only proves the create chokepoint
 * calls it, for both families, fire-and-forget.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const emitWorkItemCreatedEvent = vi.fn();
vi.mock('./work-items-events', () => ({
  emitWorkItemCreatedEvent: (...a: unknown[]) => emitWorkItemCreatedEvent(...a),
  emitWorkItemClaimedEvent: vi.fn(),
}));
// The create path fires the lifecycle event fire-and-forget via a dynamic
// `import('./work-items-events')` under a work-items ↔ work-items-events import
// CYCLE — a combination vitest's per-function module mock does NOT reliably
// intercept, so a REAL emit could leak through, hit the real await-engine against
// this file's fakeSql (which answers EVERY query with [{ id: 'WI-9001' }], so the
// engine's delivery/await-row parse tripped `new Date(undefined).toISOString()` =
// "Invalid time value"), and console.warn at a TIMING-DEPENDENT moment (surfacing
// inside a LATER test) → vitest-fail-on-console flaked this file (EI-9654; the
// identical class WI-3309/EI-8413 red-pinned the gate 4× on 2026-07-07). Stub the
// SINGLE SINK every emit funnels through — emitAwaitedEvent — so no emit path
// (mocked or leaked) can ever touch PG. The event leg has its own coverage in
// work-items-events.test.ts.
vi.mock('./events/await/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAwaitedEvent: vi.fn(async () => ({ ok: true, key: '', woken: 0, notified: [], msgId: null })),
}));

vi.mock('./pot/urgent-wake', () => ({ requestUrgentHiveWake: vi.fn(async () => ({ fired: true, coalesced: false })) }));

// EI-21829617047179388: `.unsafe` must answer the feature-family INSERT's
// `ON CONFLICT (harness_slug, feature_id) DO NOTHING RETURNING feature_id`.
// createWorkItem treats an EMPTY result as "the insert was suppressed — mint a
// new id and retry", and that retry is unbounded, so a fake returning [] spins
// forever and exhausts the V8 heap at ANY --max-old-space-size (it OOM'd at both
// the 2240MB default and at 8192MB). Answer with the RETURNING row shape —
// `feature_id`, not `id` (that one belongs to the tagged-template id-mint above).
const fakeSql = Object.assign(
  async () => [{ id: 'WI-9001' }],
  { unsafe: vi.fn(async () => [{ feature_id: 'WI-9001' }]) },
);
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-created-hook' }));
vi.mock('./sync/hyperbee/fanout-projection', () => ({ fanoutForObject: vi.fn(async () => {}) }));
vi.mock('./issue-blocks-merge', () => ({
  featureRef: (h: string, id: string) => `${h}#${id}`,
  FEATURE_KIND: 'feature',
  isQualifiedFeatureRef: (r: string) => r.includes('#'),
}));

const createIssue = vi.fn(async (input: { id: string; kind: string; title: string; severity?: string; scope: string }) => ({
  id: input.id,
  kind: input.kind,
  title: input.title,
  body: '',
  state: 'open',
  assignee: null,
  assignedBy: null,
  severity: input.severity ?? null,
  scope: input.scope,
  payload: null,
  assigneeRank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));
vi.mock('./issues-engineer', () => ({
  ISSUE_KIND: 'issue',
  createIssue: (...a: unknown[]) => createIssue(...(a as [never])),
  getIssue: vi.fn(async () => null),
  getIssueDetail: vi.fn(async () => null),
  listIssues: vi.fn(async () => []),
  setIssueState: vi.fn(async () => null),
  claimIssue: vi.fn(async () => null),
  releaseIssue: vi.fn(async () => null),
  linkIssue: vi.fn(async () => {}),
  unlinkIssue: vi.fn(async () => {}),
  tagIssue: vi.fn(async () => {}),
  untagIssue: vi.fn(async () => {}),
  subscribeIssue: vi.fn(async () => {}),
  commentIssue: vi.fn(async () => null),
  searchIssues: vi.fn(async () => []),
  promoteIssue: vi.fn(async () => ({ error: 'unused' })),
}));

import { createWorkItem } from './work-items';

// createWorkItem intentionally lazy-imports the event module to break a production
// cycle. Preload the already-mocked module once so this test measures whether the
// create chokepoint fires the hook, not whether a cold Vite transform finishes inside
// vi.waitFor's unrelated one-second default on a busy shared runner.
beforeAll(async () => {
  await import('./work-items-events');
});

beforeEach(() => {
  emitWorkItemCreatedEvent.mockClear();
  createIssue.mockClear();
});

describe('createWorkItem fires emitWorkItemCreatedEvent (EI-8296)', () => {
  it('issue-family create fires the created-event hook with the new item', async () => {
    const wi = await createWorkItem({ kind: 'bug', title: 'a new bug', severity: 'critical' });
    expect(wi.id).toBe('WI-9001');
    await vi.waitFor(() => expect(emitWorkItemCreatedEvent).toHaveBeenCalledTimes(1));
    const arg = emitWorkItemCreatedEvent.mock.calls[0][0] as { id: string; severity: string | null };
    expect(arg.id).toBe('WI-9001');
    expect(arg.severity).toBe('critical');
  });

  it('feature-family create ALSO fires the created-event hook', async () => {
    // 'papercup' is the legacy dogfood slug — pot-membership-enforcement-2026-07-20
    // (P-005) now resolves it against harness_shared.pots to its real Pot home
    // ('papercusp') at write time, so the created-event hook receives the RESOLVED
    // slug, not the caller's raw legacy input. See pot-membership.ts canonicalPotSlug.
    const wi = await createWorkItem({ kind: 'feature', title: 'a new feature', harness: 'papercup' });
    expect(wi.id).toBe('WI-9001');
    await vi.waitFor(() => expect(emitWorkItemCreatedEvent).toHaveBeenCalledTimes(1));
    const arg = emitWorkItemCreatedEvent.mock.calls[0][0] as { id: string; harness: string | null };
    expect(arg.id).toBe('WI-9001');
    expect(arg.harness).toBe('papercusp');
  });

  it('fire-and-forget: a throwing hook never fails the create', async () => {
    emitWorkItemCreatedEvent.mockImplementationOnce(() => {
      throw new Error('emit path down');
    });
    const wi = await createWorkItem({ kind: 'bug', title: 'still lands despite hook throw' });
    expect(wi.id).toBe('WI-9001');
  });
});
