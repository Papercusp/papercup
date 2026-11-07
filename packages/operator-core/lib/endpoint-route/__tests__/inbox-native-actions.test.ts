import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ read: vi.fn(), dispatch: vi.fn(), csrf: vi.fn() }));
vi.mock('../../agent-tools/index', () => ({}));
vi.mock('../routes/admin/proxy-host-extras', () => ({ ADMIN_PROXY_HOST_EXTRAS: {} }));
vi.mock('../cors', () => ({ requireAllowedOriginOr403: h.csrf }));
vi.mock('../../agent-tools/plans/read-dispatch', () => ({ callPlansReadRaw: h.read }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'fallback-workspace' }));
vi.mock('../../workspace-als', () => ({ runWithWorkspace: (_id: string, run: () => unknown) => run() }));
vi.mock('../../owner-sessions/actions', () => ({
  dispatchToolAsAdminUi: h.dispatch,
  adminToolResultJson: (result: { body: unknown }) => result.body,
}));
// Exercise the real shared action switch without booting the agent registry.
// These effects retain the call seam so workspace/harness attribution is tested.
vi.mock('../../agent-tools/inbox/bulk-run', () => ({
  terminalDependencies: ({ call }: { call: (name: string, args: unknown) => Promise<unknown> }) => ({
    acknowledgeMessage: ({ msgId }: { msgId: string }) => call('coord:ack', { msg_id: msgId }),
    resolveEscalation: ({ msgId, choice }: { msgId: string; choice: string }) => call('coord:resolve', { msg_id: msgId, choice }),
    setPlanItemStatus: ({ slug, itemId, status }: { slug: string; itemId: string; status: string }) =>
      call('plans:set-status', { slug, item: itemId, status }),
    wakePlanLoop: vi.fn(),
    decideStandingApproval: (args: unknown) => call('operator:standing_approvals_decide', args),
    closeSessionGate: (args: unknown) => call('sessions:ingest-gate-event', args),
    triageAttentionItem: (args: unknown) => call('inbox:triage', args),
  }),
}));

import routes from '../routes/admin/inbox';
const handler = routes[0].handler!;
const item = {
  id: 'literal +/=& λ', kind: 'coord-message', title: 'Question', harnessSlug: 'managed-harness',
  ref: { kind: 'coord-message', msgId: 'message +/=& λ' }, actions: [{ id: 'ack' }],
};
const request = (overrides = {}) => ({ expected: { id: item.id, kind: item.kind, ref: item.ref }, actionId: 'ack', confirmed: true, ...overrides });
const ctx = { principal: { workspaceId: 'admitted-workspace' }, params: { verb: 'execute' }, signal: new AbortController().signal };
async function execute(body: unknown = request()) {
  return handler(new Request('http://localhost/api/admin/inbox/execute?client=untrusted-override', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'foreign-workspace' }, body: JSON.stringify(body),
  }), ctx as never);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.csrf.mockReturnValue(null);
  h.read.mockResolvedValue({ status: 200, data: { groups: [{ items: [item] }] } });
  h.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
});

describe('native owner Inbox uses the canonical terminal dispatcher', () => {
  it('refuses CSRF and unconfirmed, malformed, or client-authored source effects before reading', async () => {
    h.csrf.mockReturnValueOnce(new Response('foreign origin', { status: 403 }));
    expect((await execute()).status).toBe(403);
    for (const body of [request({ confirmed: false }), request({ tool: 'arbitrary:write' }), null, []]) {
      expect((await execute(body)).status).toBe(400);
    }
    expect(h.read).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('keeps unknown or degraded attention unavailable without writing', async () => {
    for (const read of [{ status: 503 }, { status: 200, data: {} },
      { status: 200, data: { groups: [], degraded: true } }, { status: 200, data: { groups: [], _partial: true } }]) {
      h.read.mockResolvedValueOnce(read); expect((await execute()).status).toBe(503);
    }
    h.read.mockRejectedValueOnce(new Error('source failed'));
    expect((await execute()).status).toBe(503); expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('rejects removed, rebound, conflicting, unoffered, and navigation actions', async () => {
    for (const rows of [[], [{ ...item, ref: { ...item.ref, msgId: 'rebound' } }], [{ ...item, kind: 'other' }],
      [item, { ...item, ref: { ...item.ref, msgId: 'conflict' } }], [{ ...item, actions: [] }]]) {
      h.read.mockResolvedValueOnce({ status: 200, data: { groups: [{ items: rows }] } });
      expect((await execute()).status).toBe(409);
    }
    h.read.mockResolvedValueOnce({ status: 200, data: { groups: [{ items: [{ ...item, actions: [{ id: 'discuss' }] }] }] } });
    expect((await execute(request({ actionId: 'discuss' }))).status).toBe(409);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('acknowledges literal coordinates once in the admitted workspace under the admin identity', async () => {
    expect(await (await execute()).json()).toEqual({ ok: true, resolved: true, itemId: item.id });
    expect(h.read).toHaveBeenCalledWith('attention', {}, { uiProjection: false });
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ group: 'coord', verb: 'ack', body: { msg_id: item.ref.msgId }, workspaceId: 'admitted-workspace' });
  });

  it('threads plan harness scope and uses the shared source mutation for a drop', async () => {
    const plan = { ...item, kind: 'plan-item', ref: { kind: 'plan-item', slug: 'plan +/=& λ', itemId: 'P-002' }, actions: [{ id: 'drop' }] };
    h.read.mockResolvedValueOnce({ status: 200, data: { groups: [{ items: [plan] }] } });
    expect((await execute(request({ expected: { id: plan.id, kind: plan.kind, ref: plan.ref }, actionId: 'drop' }))).status).toBe(200);
    expect(h.dispatch).toHaveBeenCalledWith({ group: 'plans', verb: 'set-status', workspaceId: 'admitted-workspace',
      body: { slug: 'plan +/=& λ', item: 'P-002', status: 'dropped', harness: 'managed-harness' } });
  });

  it('accepts only named escalation options offered by a live resolve action', async () => {
    const escalation = { ...item, kind: 'coord-escalation', ref: { kind: 'coord-escalation', msgId: 'escalation', options: [{ id: 'B', label: 'Option B' }] }, actions: [{ id: 'resolve' }] };
    h.read.mockResolvedValue({ status: 200, data: { groups: [{ items: [escalation] }] } });
    const expected = { id: escalation.id, kind: escalation.kind, ref: escalation.ref };
    expect((await execute(request({ expected, actionId: 'B' }))).status).toBe(200);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ group: 'coord', verb: 'resolve', body: { msg_id: 'escalation', choice: 'B' } }));
    expect((await execute(request({ expected, actionId: 'invented' }))).status).toBe(409);
  });

  it('does not report a canonical refusal as a successful resolution', async () => {
    h.dispatch.mockResolvedValueOnce({ status: 403, body: { error: 'denied' } });
    expect((await execute()).status).toBe(503);
    h.dispatch.mockResolvedValueOnce({ status: 200, body: { isError: true } });
    expect((await execute()).status).toBe(503);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
});
