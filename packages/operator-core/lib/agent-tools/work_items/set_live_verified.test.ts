/** P-020: work_items:set_live_verified exact release-parity enforcement. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  getWorkItem: vi.fn(),
  setWorkItemLiveVerified: vi.fn(),
}));
vi.mock('../../dev-deploy-state', () => ({
  devDeployState: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test' }),
}));

import { devDeployState } from '../../dev-deploy-state';
import { getWorkItem, setWorkItemLiveVerified } from '../../work-items';

const getWI = vi.mocked(getWorkItem);
const setLV = vi.mocked(setWorkItemLiveVerified);
const deployState = vi.mocked(devDeployState);
const tool = (await import('./set_live_verified')).default;

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);

type Out = { data: unknown };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data as any;

beforeEach(() => {
  getWI.mockReset();
  setLV.mockReset();
  deployState.mockReset();
  getWI.mockResolvedValue({ id: 'F-1', family: 'feature' } as never);
  deployState.mockResolvedValue({ deployed: { sha: shaA }, greenPin: { sha: shaA } } as never);
  setLV.mockImplementation(async (_id, marker) => ({ id: 'F-1', applicable: true, liveVerified: marker }) as never);
});

describe('work_items:set_live_verified handler', () => {
  it('persists a marker only when tested, claimed, actual, and green SHAs match exactly', async () => {
    const b = body(
      await call({
        id: 'F-1',
        testedSha: shaA,
        deployedSha: shaA,
        evidence: 'exercised live behavior',
      }),
    );
    expect(b).toMatchObject({
      ok: true,
      applicable: true,
      action: 'set',
      parity: { ok: true, state: 'matched' },
      liveVerified: {
        by: 'su-test',
        testedSha: shaA,
        deployedSha: shaA,
        greenPinSha: shaA,
        parity: 'matched',
        evidence: 'exercised live behavior',
      },
    });
    expect(typeof b.liveVerified.at).toBe('number');
    expect(setLV).toHaveBeenCalledOnce();
  });

  it('refuses an unresolved write when required SHAs are omitted', async () => {
    const b = body(await call({ id: 'F-1' }));
    expect(b).toMatchObject({ ok: false, refused: true, parity: { state: 'unresolved' } });
    expect(setLV).not.toHaveBeenCalled();
  });

  it('refuses a tested SHA that differs from the actual deployment', async () => {
    const b = body(await call({ id: 'F-1', testedSha: shaB, deployedSha: shaA }));
    expect(b).toMatchObject({ ok: false, refused: true, parity: { state: 'tested-deploy-mismatch' } });
    expect(setLV).not.toHaveBeenCalled();
  });

  it('refuses a stale caller-claimed deployment SHA', async () => {
    const b = body(await call({ id: 'F-1', testedSha: shaA, deployedSha: shaB }));
    expect(b).toMatchObject({ ok: false, refused: true, parity: { state: 'claimed-deploy-stale' } });
    expect(setLV).not.toHaveBeenCalled();
  });

  it('refuses a deployment that is not the current green pin', async () => {
    deployState.mockResolvedValue({ deployed: { sha: shaA }, greenPin: { sha: shaB } } as never);
    const b = body(await call({ id: 'F-1', testedSha: shaA, deployedSha: shaA }));
    expect(b).toMatchObject({ ok: false, refused: true, parity: { state: 'deployed-not-green' } });
    expect(setLV).not.toHaveBeenCalled();
  });

  it('clear bypasses release parity and retracts the marker', async () => {
    setLV.mockResolvedValue({ id: 'F-1', applicable: true, liveVerified: null } as never);
    const b = body(await call({ id: 'F-1', clear: true }));
    expect(b).toMatchObject({ ok: true, applicable: true, action: 'clear', parity: null, liveVerified: null });
    expect(deployState).not.toHaveBeenCalled();
    expect(setLV).toHaveBeenCalledWith('F-1', null, { harness: undefined });
  });

  it('returns not-found before consulting release authority', async () => {
    getWI.mockResolvedValue(null);
    const b = body(await call({ id: 'nope', testedSha: shaA, deployedSha: shaA }));
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/not found/i);
    expect(deployState).not.toHaveBeenCalled();
    expect(setLV).not.toHaveBeenCalled();
  });

  it('preserves non-feature applicable:false semantics without requiring SHAs', async () => {
    getWI.mockResolvedValue({ id: 'WI-9', family: 'issue' } as never);
    const b = body(await call({ id: 'WI-9' }));
    expect(b).toMatchObject({ ok: true, applicable: false, id: 'WI-9' });
    expect(deployState).not.toHaveBeenCalled();
    expect(setLV).not.toHaveBeenCalled();
  });
});
