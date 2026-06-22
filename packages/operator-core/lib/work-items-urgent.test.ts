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
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
