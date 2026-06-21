/**
 * set_live_verified.test.ts — the work_items:set_live_verified HANDLER shaping. The store write
 * (setWorkItemLiveVerified) is stubbed; this pins: a `set` builds an { at, by, deployedSha, evidence }
 * marker and passes a non-null marker to the store; `clear:true` passes null (retract); a missing
 * item maps to ok:false; and a non-feature-family item surfaces applicable:false (no error).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/set_live_verified.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../work-items', () => ({
  setWorkItemLiveVerified: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test' }),
}));

import { setWorkItemLiveVerified } from '../../work-items';
const setLV = vi.mocked(setWorkItemLiveVerified);
const tool = (await import('./set_live_verified')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => setLV.mockReset());

describe('work_items:set_live_verified handler', () => {
  it('set builds a marker { at, by, deployedSha, evidence } and persists a non-null marker', async () => {
    setLV.mockImplementation(async (_id, marker) => ({ id: 'WI-1', applicable: true, liveVerified: marker }) as never);
    const b = body(await call({ id: 'WI-1', deployedSha: 'abc123', evidence: 'GET /health → 200 on :3070' }));
    expect(b).toMatchObject({ ok: true, applicable: true, id: 'WI-1', action: 'set' });
    expect(b.liveVerified).toMatchObject({ by: 'su-test', deployedSha: 'abc123', evidence: 'GET /health → 200 on :3070' });
    expect(typeof b.liveVerified.at).toBe('number');
    expect(setLV.mock.calls[0]![1]).not.toBeNull();
  });

  it('omitted deployedSha/evidence become null on the marker', async () => {
    setLV.mockImplementation(async (_id, marker) => ({ id: 'WI-1', applicable: true, liveVerified: marker }) as never);
    const b = body(await call({ id: 'WI-1' }));
    expect(b.liveVerified).toMatchObject({ by: 'su-test', deployedSha: null, evidence: null });
  });

  it('clear:true passes a null marker (retract) and reports action:clear', async () => {
    setLV.mockResolvedValue({ id: 'WI-1', applicable: true, liveVerified: null } as never);
    const b = body(await call({ id: 'WI-1', clear: true }));
    expect(b).toMatchObject({ ok: true, applicable: true, action: 'clear', liveVerified: null });
    expect(setLV.mock.calls[0]![1]).toBeNull();
  });

  it('maps a missing item (null) to ok:false', async () => {
    setLV.mockResolvedValue(null as never);
    const b = body(await call({ id: 'nope' }));
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/not found/i);
  });

  it('a non-feature-family item surfaces applicable:false (no error)', async () => {
    setLV.mockResolvedValue({ id: 'EI-9', applicable: false, liveVerified: null } as never);
    const b = body(await call({ id: 'EI-9' }));
    expect(b).toMatchObject({ ok: true, applicable: false, id: 'EI-9' });
    expect(String(b.note)).toMatch(/feature-family/i);
  });
});
