/** TEMP probe — delete after use. Mirrors work-items-created-event-hook.test.ts rig. */
import { describe, it, vi } from 'vitest';

const emitWorkItemCreatedEvent = vi.fn();
const emitWorkItemClaimableEvent = vi.fn();
vi.mock('./work-items-events', () => ({
  emitWorkItemCreatedEvent: (...a: unknown[]) => emitWorkItemCreatedEvent(...a),
  emitWorkItemClaimedEvent: vi.fn(),
  emitWorkItemClaimableEvent: (...a: unknown[]) => emitWorkItemClaimableEvent(...a),
}));

vi.mock('./pot/urgent-wake', () => ({ requestUrgentHiveWake: vi.fn(async () => ({ fired: true, coalesced: false })) }));

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

describe('probe', () => {
  it('who runs the real claimable emitter?', async () => {
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      // eslint-disable-next-line no-console
      console.log('WARN-INTERCEPT:', ...a, '\nSTACK:', new Error('probe').stack);
    });
    await createWorkItem({ kind: 'bug', title: 'probe bug', severity: 'critical' });
    await new Promise((r) => setTimeout(r, 50));
    // eslint-disable-next-line no-console
    console.log('created-mock-calls:', emitWorkItemCreatedEvent.mock.calls.length,
      'claimable-mock-calls:', emitWorkItemClaimableEvent.mock.calls.length);
  });
});
