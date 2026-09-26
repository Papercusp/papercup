import { beforeEach, describe, expect, it, vi } from 'vitest';

const unsafe = vi.hoisted(() => vi.fn());
const begin = vi.hoisted(() => vi.fn(async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => fn({ unsafe })));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { unsafe, begin } }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

import { executeWithGateActionReceipt } from './gate-action-receipt';

const input = (run: () => Promise<{ launched: boolean }>) => ({
  action: 'release:deploy', actor: 'test-actor', ownerId: 'owner-a',
  conditionKey: 'gate-red-streak:papercusp', target: { commit: 'abc' }, run,
  summarize: (effect: { launched: boolean }) => ({ status: effect.launched ? 'accepted' : 'not-launched' }),
});

describe('durable gate action receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unsafe.mockImplementation(async (query: string) => query.includes('SELECT w.feature_id')
      ? [{ work_item: 'WI-gate', holder: 'owner-a', taken_at: '2026-09-26T18:00:00Z', expires_at: null }]
      : []);
  });

  it('commits intent before effect, then settles under the claim-row lock', async () => {
    const run = vi.fn(async () => {
      expect(unsafe.mock.calls[0]![0]).toContain('INSERT INTO harness_shared.audit_log');
      expect(unsafe.mock.calls[1]![0]).toContain('FOR UPDATE OF w');
      return { launched: true };
    });
    const result = await executeWithGateActionReceipt(input(run));
    expect(result).toMatchObject({ ok: true, effect: { launched: true },
      ownership: { workItem: 'WI-gate', holder: 'owner-a' } });
    expect(unsafe.mock.calls[2]![0]).toContain('UPDATE harness_shared.audit_log');
    expect(JSON.parse(unsafe.mock.calls[2]![1][1])).toMatchObject({
      phase: 'settled', ownershipCertainty: 'claim-row-locked-through-effect',
      effect: { status: 'accepted' },
    });
  });

  it('refuses a different holder without running the effect', async () => {
    unsafe.mockImplementation(async (query: string) => query.includes('SELECT w.feature_id')
      ? [{ work_item: 'WI-gate', holder: 'owner-b', taken_at: null, expires_at: null }]
      : []);
    const run = vi.fn(async () => ({ launched: true }));
    expect(await executeWithGateActionReceipt(input(run))).toMatchObject({
      ok: false, reason: 'gate_condition_not_held_by_caller', effectMayHaveRun: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when the intent write fails', async () => {
    unsafe.mockRejectedValueOnce(new Error('audit unavailable'));
    const run = vi.fn(async () => ({ launched: true }));
    expect(await executeWithGateActionReceipt(input(run))).toMatchObject({
      ok: false, receiptId: null, reason: 'gate_action_intent_unavailable', effectMayHaveRun: false,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('leaves committed intent unknown when settlement fails after effect', async () => {
    unsafe.mockImplementation(async (query: string) => {
      if (query.includes('SELECT w.feature_id')) return [
        { work_item: 'WI-gate', holder: 'owner-a', taken_at: null, expires_at: null },
      ];
      if (query.includes('UPDATE harness_shared.audit_log')) throw new Error('commit unavailable');
      return [];
    });
    const run = vi.fn(async () => ({ launched: true }));
    expect(await executeWithGateActionReceipt(input(run))).toMatchObject({
      ok: false, reason: 'gate_action_effect_or_settlement_unknown', effectMayHaveRun: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
