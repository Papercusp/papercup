/**
 * work-items-urgent.test.ts — the URGENT-enqueue hook on the unified create
 * chokepoint (swarm-coordination P-006/D-005): createWorkItem { urgent:true }
 * fires requestUrgentHiveWake for BOTH families, fire-and-forget (a wake failure
 * never breaks the create), and the work_items:create tool threads the flag.
 *
 * PG-touching seams are mocked (db-org sql, issues-engineer, fanout-projection);
 * the urgent-wake module itself is unit-covered in hive/urgent-wake.test.ts —
 * here it is a spy seam.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const requestUrgentHiveWake = vi.fn(async (_opts: { reason: string; harness: string | null }) => ({
  fired: true,
  coalesced: false,
}));
vi.mock('./hive/urgent-wake', () => ({
  requestUrgentHiveWake: (...a: Parameters<typeof requestUrgentHiveWake>) => requestUrgentHiveWake(...a),
}));

// Fake org-PG: a tagged-template sql that answers the id-mint, with .unsafe for
// the feature-family INSERT. Spread the real module so other graph consumers keep
// their exports.
const fakeSql = Object.assign(
  async () => [{ id: 'WI-9001' }],
  { unsafe: vi.fn(async () => []) },
);
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-urgent' }));
vi.mock('./sync/hyperbee/fanout-projection', () => ({ fanoutForObject: vi.fn(async () => {}) }));
// The lifecycle-event emits are fire-and-forget into the REAL events engine —
// and the fakeSql above answers EVERY query with [{ id: 'WI-9001' }], so the
// engine's await-row parse hit `undefined.startsWith` and console.warn'd at a
// TIMING-DEPENDENT moment (often inside a later test on a loaded machine) →
// vitest-fail-on-console flaked this whole file and red-pinned the release gate
// (2026-07-07, WI-3309 investigation; 4 consecutive gate reds). Spy the emit
// seam out entirely — the event leg has its own coverage in
// work-items-events.test.ts; this file is about the urgent-wake hook.
vi.mock('./work-items-events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitWorkItemCreatedEvent: vi.fn(),
  emitWorkItemClaimedEvent: vi.fn(),
  emitClaimReleasedEvent: vi.fn(),
  emitWorkItemBlockedEvent: vi.fn(),
  emitWorkItemStatusEvent: vi.fn(),
  emitWorkItemSettledEvents: vi.fn(async () => {}),
}));
vi.mock('./issue-blocks-merge', () => ({
  featureRef: (h: string, id: string) => `${h}#${id}`,
  FEATURE_KIND: 'feature',
  isQualifiedFeatureRef: (r: string) => r.includes('#'),
}));

const createIssue = vi.fn(async (input: { id: string; kind: string; title: string; scope: string }) => ({
  id: input.id,
  kind: input.kind,
  title: input.title,
  body: '',
  state: 'open',
  assignee: null,
  assignedBy: null,
  severity: null,
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
import createTool from './agent-tools/work_items/create';

// Pre-resolve the ./work-items-events mock BEFORE any create runs. The mock
// factory is async (it spreads importOriginal over a module that circularly
// imports ./work-items), so the FIRST dynamic import('./work-items-events')
// from createWorkItem could race the factory and get the REAL module — its
// fire-and-forget created-event emit then hit the fakeSql and console.warn'd
// at a timing-dependent moment, red-pinning the gate (EI-8413). Warming the
// mock here forces the factory to finish + cache before the first create.
beforeAll(async () => {
  await import('./work-items-events');
});

beforeEach(() => {
  requestUrgentHiveWake.mockClear();
  requestUrgentHiveWake.mockResolvedValue({ fired: true, coalesced: false });
  createIssue.mockClear();
});

describe('createWorkItem urgent hook (P-006)', () => {
  it('issue-family urgent create fires the brain wake with the item id + title', async () => {
    const wi = await createWorkItem({ kind: 'bug', title: 'prod is on fire', urgent: true });
    expect(wi.id).toBe('WI-9001');
    await vi.waitFor(() => expect(requestUrgentHiveWake).toHaveBeenCalledTimes(1));
    const arg = requestUrgentHiveWake.mock.calls[0][0] as unknown as { reason: string; harness: string | null };
    expect(arg.reason).toContain('WI-9001');
    expect(arg.reason).toContain('prod is on fire');
    expect(arg.harness).toBeNull(); // operator-scoped bug → env fallback decides the home slug
  });

  it('feature-family urgent create passes the item harness as the hive home slug', async () => {
    await createWorkItem({ kind: 'feature', title: 'hotfix', harness: 'papercup', urgent: true });
    await vi.waitFor(() => expect(requestUrgentHiveWake).toHaveBeenCalledTimes(1));
    expect((requestUrgentHiveWake.mock.calls[0][0] as unknown as { harness: string | null }).harness).toBe('papercup');
  });

  it('a non-urgent create never touches the wake path', async () => {
    await createWorkItem({ kind: 'bug', title: 'routine filing' });
    await createWorkItem({ kind: 'feature', title: 'routine feature', harness: 'papercup' });
    await new Promise((r) => setTimeout(r, 10)); // give a stray fire-and-forget a beat
    expect(requestUrgentHiveWake).not.toHaveBeenCalled();
  });

  it('fire-and-forget: a rejecting wake never fails the create', async () => {
    requestUrgentHiveWake.mockRejectedValueOnce(new Error('wake path down'));
    const wi = await createWorkItem({ kind: 'bug', title: 'still lands', urgent: true });
    expect(wi.id).toBe('WI-9001');
    await vi.waitFor(() => expect(requestUrgentHiveWake).toHaveBeenCalledTimes(1));
  });
});

describe('work_items:create tool threads urgent', () => {
  const ctx = { uiClientId: 'su-self', isSuperuser: true, workspaceId: 'ws-urgent' } as never;
  const parse = (x: unknown) => createTool.args.parse(x) as never;

  it('urgent:true reaches the brain-wake seam', async () => {
    const res = await createTool.handler(parse({ kind: 'bug', title: 'tool urgent', urgent: true }), ctx);
    // work_items:create is bulk (P-006): the handler returns { data: envelope }.
    const body = (res as { data: any }).data;
    expect(body.ok).toBe(true);
    await vi.waitFor(() => expect(requestUrgentHiveWake).toHaveBeenCalledTimes(1));
  });

  it('urgent omitted → no wake', async () => {
    await createTool.handler(parse({ kind: 'bug', title: 'tool routine' }), ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(requestUrgentHiveWake).not.toHaveBeenCalled();
  });
});
