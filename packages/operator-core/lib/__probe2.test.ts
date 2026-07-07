import { describe, it, expect, vi } from 'vitest';
const requestUrgentHiveWake = vi.fn(async () => ({ fired: true, coalesced: false }));
vi.mock('./hive/urgent-wake', () => ({ requestUrgentHiveWake: (...a: any[]) => requestUrgentHiveWake(...a) }));
const fakeSql = Object.assign(async () => [{ id: 'WI-9001' }], { unsafe: vi.fn(async () => []) });
vi.mock('@papercusp/db-org', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getOrgPg: () => ({ sql: fakeSql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-urgent' }));
vi.mock('./sync/hyperbee/fanout-projection', () => ({ fanoutForObject: vi.fn(async () => {}) }));
const emitCreated = vi.fn();
vi.mock('./work-items-events', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), emitWorkItemCreatedEvent: emitCreated, emitWorkItemClaimedEvent: vi.fn(), emitClaimReleasedEvent: vi.fn(), emitWorkItemBlockedEvent: vi.fn(), emitWorkItemStatusEvent: vi.fn(), emitWorkItemSettledEvents: vi.fn(async () => {}) }));
vi.mock('./issue-blocks-merge', () => ({ featureRef: (h: string, id: string) => `${h}#${id}`, FEATURE_KIND: 'feature', isQualifiedFeatureRef: (r: string) => r.includes('#') }));
const createIssue = vi.fn(async (input: any) => ({ id: input.id, kind: input.kind, title: input.title, body: '', state: 'open', assignee: null, assignedBy: null, severity: null, scope: input.scope, payload: null, assigneeRank: null, rankWriter: null, rankUpdatedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
vi.mock('./issues-engineer', () => ({ ISSUE_KIND: 'issue', createIssue: (...a: any[]) => createIssue(...(a as [never])), getIssue: vi.fn(async () => null), getIssueDetail: vi.fn(async () => null), listIssues: vi.fn(async () => []), setIssueState: vi.fn(async () => null), claimIssue: vi.fn(async () => null), releaseIssue: vi.fn(async () => null), linkIssue: vi.fn(async () => {}), unlinkIssue: vi.fn(async () => {}), tagIssue: vi.fn(async () => {}), untagIssue: vi.fn(async () => {}), subscribeIssue: vi.fn(async () => {}), commentIssue: vi.fn(async () => null), searchIssues: vi.fn(async () => []), promoteIssue: vi.fn(async () => ({ error: 'unused' })) }));
import { createWorkItem } from './work-items';
describe('probe2', () => {
  it('after importing work-items, dyn import of events is mock', async () => {
    const m = await import('./work-items-events');
    console.log('EVENTS_IS_MOCK:', (m.emitWorkItemCreatedEvent as any) === emitCreated);
    await createWorkItem({ kind: 'bug', title: 'routine filing' });
    await new Promise((r) => setTimeout(r, 30));
    console.log('EMIT_CREATED_CALLS:', emitCreated.mock.calls.length);
    expect(true).toBe(true);
  });
});
