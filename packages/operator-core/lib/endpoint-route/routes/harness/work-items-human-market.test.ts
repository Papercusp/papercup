import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';
import { claimHumanMarketJob, humanAssignee } from '../../../work-items-human-market';

const f = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), act: vi.fn() }));
vi.mock('../../../auth', () => ({ getSessionUser: f.session }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'pilot-workspace' }));
vi.mock('../../../work-items-human-market-store', () => ({ getHumanMarketItem: f.read, actOnHumanMarketItem: f.act }));
import routes from './work-items';
const get = routes.find(r => r.method === 'GET' && r.path.endsWith('/human-work'))!;
const post = routes.find(r => r.method === 'POST' && r.path.endsWith('/human-work'))!;
const human = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000001';
const offer = { id: 'WI-job', state: 'needs-human', assignee: null, payload: {
  internalSecret: 'hidden', humanWork: { route: 'market', version: 0, ownerUserId: owner,
    brief: 'Review public onboarding.', rubricRef: 'review@1', amountCents: 500, currency: 'USD' },
} };
const ctx = { params: { slug: 'pilot', id: 'WI-job' }, log() {}, principal: null } as unknown as RouteContext;
const url = 'http://localhost/api/harness/pilot/work-items/WI-job/human-work';
function request(body: unknown, extra: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  f.session.mockResolvedValue({ id: human, workspace_id: 'pilot-workspace' });
  f.read.mockResolvedValue(offer);
  f.act.mockResolvedValue({ ...offer, state: 'wip', assignee: humanAssignee(human),
    payload: { ...offer.payload, humanWork: claimHumanMarketJob(offer, human, '2026-10-01T02:00:00Z') } });
});

describe('human-work HTTP actions', () => {
  it('requires a real human session even with a bearer, and rejects another workspace', async () => {
    f.session.mockResolvedValue(null);
    expect((await get.handler(new Request(url, { headers: { authorization: 'Bearer agent' } }), ctx)).status).toBe(401);
    expect((await post.handler(request({ action: 'claim', version: 0 }), ctx)).status).toBe(401);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
    f.session.mockResolvedValue({ id: human, workspace_id: 'other' });
    expect((await post.handler(request({ action: 'claim', version: 0 }), ctx)).status).toBe(403);
    expect(f.act).not.toHaveBeenCalled();
  });

  it('reads the safe offer without publishing owner id or internal payload', async () => {
    const response = await get.handler(new Request(url), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offer: { id: 'WI-job', brief: 'Review public onboarding.',
      rubricRef: 'review@1', amountCents: 500, currency: 'USD', status: 'available' }, version: 0, mine: false, submission: null });
    expect(f.read).toHaveBeenCalledWith({ workspaceId: 'pilot-workspace', harness: 'pilot', id: 'WI-job' });
  });

  it('derives the claimant from the cookie, rejects identity/grade/payment injection, and enforces origin', async () => {
    const response = await post.handler(request({ action: 'claim', version: 0 }), ctx);
    expect(response.status).toBe(200);
    expect(f.act).toHaveBeenCalledWith({ workspaceId: 'pilot-workspace', harness: 'pilot', id: 'WI-job', userId: human, action: 'claim', version: 0 });
    for (const body of [{ action: 'claim', version: 0, userId: owner },
      { action: 'grade', version: 0, passed: true }, { action: 'payment', version: 0, receiptRef: 'made-up' }]) {
      expect((await post.handler(request(body), ctx)).status).toBe(400);
    }
    expect((await post.handler(request({ action: 'claim', version: 0 }, { origin: 'https://foreign.example' }), ctx)).status).toBe(403);
  });

  it('submits only bounded nonempty work and reports conflict without leaking storage errors', async () => {
    for (const result of ['', ' '.repeat(3), 'x'.repeat(32001)]) {
      expect((await post.handler(request({ action: 'submit', version: 1, result }), ctx)).status).toBe(400);
    }
    await post.handler(request({ action: 'submit', version: 1, result: 'Reviewed.' }), ctx);
    expect(f.act).toHaveBeenLastCalledWith(expect.objectContaining({ userId: human, action: 'submit', result: 'Reviewed.' }));
    f.act.mockRejectedValue(new Error('market_offer_changed'));
    expect((await post.handler(request({ action: 'claim', version: 0 }), ctx)).status).toBe(409);
    f.act.mockRejectedValue(new Error('database secret'));
    const failure = await post.handler(request({ action: 'claim', version: 0 }), ctx);
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: 'human_work_write_failed' });
  });
});
