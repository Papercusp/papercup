/**
 * work-items-created-event-hook.test.ts — createWorkItem fires
 * emitWorkItemCreatedEvent for EVERY new item, both families (EI-8296: no
 * creation event existed, so "alert on a new critical item" fell back to a
 * 15-min poll+diff plan). Mirrors work-items-urgent.test.ts's mocking
 * scaffold; the emit's own key/payload shape is unit-covered directly in
 * work-items-events.test.ts — this file only proves the create chokepoint
 * calls it, for both families, fire-and-forget.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitWorkItemCreatedEvent = vi.fn();
vi.mock('./work-items-events', () => ({
  emitWorkItemCreatedEvent: (...a: unknown[]) => emitWorkItemCreatedEvent(...a),
  emitWorkItemClaimedEvent: vi.fn(),
}));

vi.mock('./hive/urgent-wake', () => ({ requestUrgentHiveWake: vi.fn(async () => ({ fired: true, coalesced: false })) }));

const fakeSql = Object.assign(
  async () => [{ id: 'WI-9001' }],
  { unsafe: vi.fn(async () => []) },
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
    const wi = await createWorkItem({ kind: 'feature', title: 'a new feature', harness: 'papercup' });
    expect(wi.id).toBe('WI-9001');
    await vi.waitFor(() => expect(emitWorkItemCreatedEvent).toHaveBeenCalledTimes(1));
    const arg = emitWorkItemCreatedEvent.mock.calls[0][0] as { id: string; harness: string | null };
    expect(arg.id).toBe('WI-9001');
    expect(arg.harness).toBe('papercup');
  });

  it('fire-and-forget: a throwing hook never fails the create', async () => {
    emitWorkItemCreatedEvent.mockImplementationOnce(() => {
      throw new Error('emit path down');
    });
    const wi = await createWorkItem({ kind: 'bug', title: 'still lands despite hook throw' });
    expect(wi.id).toBe('WI-9001');
  });
});
