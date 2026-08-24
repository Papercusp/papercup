/**
 * burn-alert.test.ts — WI-41147 leg c: the stated wall at the observation WRITE seam.
 *
 * The wrapper must (i) alarm on the TRANSITION edge only (fact + severe-event), (ii) keep the
 * standing fact refreshed on every burning observation, (iii) retract + resolve on recovery,
 * and (iv) stay completely silent for a healthy account. The pool store, facts store and
 * severe-event rail are mocked; `recordAccountWindow`/`accountBurnTransition` run REAL, so
 * these tests exercise the true verdict math end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAccount, type AccountPool } from '../deployment/account-pool';
import { recordAccountWindowWithBurnAlert } from './burn-alert';

const h = vi.hoisted(() => ({
  state: { pool: { accounts: [] } as unknown },
  assertFact: vi.fn(async (_input: unknown) => ({})),
  retractFact: vi.fn(async (_input: unknown) => true),
  broadcastSevereEvent: vi.fn(async (_ev: unknown) => true),
  broadcastSevereEventResolved: vi.fn(async (_res: unknown) => true),
}));

vi.mock('../deployment/account-pool-store', () => ({
  updateAccountPool: async (mutator: (p: AccountPool) => AccountPool) => {
    h.state.pool = mutator(h.state.pool as AccountPool);
    return h.state.pool;
  },
}));
vi.mock('../agent-facts/store', () => ({
  assertFact: h.assertFact,
  retractFact: h.retractFact,
}));
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: h.broadcastSevereEvent,
  broadcastSevereEventResolved: h.broadcastSevereEventResolved,
}));

const T0 = 1_800_000_000_000;
const HR = 3_600_000;
const RESET = { windowResetAt7d: T0 + 24 * HR };

describe('recordAccountWindowWithBurnAlert (leg c)', () => {
  beforeEach(() => {
    h.state.pool = registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'cred-a1' }, T0 - HR);
    h.assertFact.mockClear();
    h.retractFact.mockClear();
    h.broadcastSevereEvent.mockClear();
    h.broadcastSevereEventResolved.mockClear();
  });

  it('healthy observation: writes the window, states NOTHING', async () => {
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    expect(transition).toBeNull();
    expect((h.state.pool as AccountPool).accounts[0]!.rate.utilization7d).toBe(0.4);
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEvent).not.toHaveBeenCalled();
    expect(h.retractFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('escalation edge: asserts the fact AND broadcasts once, condition-keyed', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR);
    expect(transition).toEqual(expect.objectContaining({ from: 'none', to: 'shed' }));
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ scope: 'workspace', key: 'account-burn:a1' }),
    );
    expect(h.broadcastSevereEvent).toHaveBeenCalledTimes(1);
    expect(h.broadcastSevereEvent.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ conditionKey: 'account-burn:a1', oneShot: true }),
    );
    expect(h.broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('steady burning: refreshes the fact each observation, but does NOT re-broadcast', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // edge: fact 1 + broadcast 1
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.9 }, T0 + 2 * HR);
    expect(transition).toBeNull(); // shed → shed
    expect(h.assertFact).toHaveBeenCalledTimes(2); // refreshed (TTL keeps the standing fact alive)
    expect(h.broadcastSevereEvent).toHaveBeenCalledTimes(1); // edge-only
  });

  it('recovery edge: retracts the fact and broadcasts resolved', async () => {
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR); // shed
    await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.9 }, T0 + 2 * HR); // still shed
    const { transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.3 }, T0 + 3 * HR);
    expect(transition).toEqual(expect.objectContaining({ from: 'shed', to: 'none' }));
    expect(h.retractFact).toHaveBeenCalledTimes(1);
    expect(h.retractFact.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ scope: 'workspace', key: 'account-burn:a1' }),
    );
    expect(h.broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    expect(h.broadcastSevereEventResolved.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ conditionKey: 'account-burn:a1' }),
    );
    expect(h.assertFact).toHaveBeenCalledTimes(2); // no refresh on the recovery write
  });

  it('a facts-store failure never breaks the observation write (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.assertFact.mockRejectedValueOnce(new Error('pg down'));
      await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.4, ...RESET }, T0);
      const { pool, transition } = await recordAccountWindowWithBurnAlert('a1', { utilization7d: 0.7 }, T0 + HR);
      expect(transition).toEqual(expect.objectContaining({ to: 'shed' }));
      expect(pool.accounts[0]!.rate.utilization7d).toBe(0.7); // the durable half landed
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fact assert failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('unknown account id: no-op write, nothing stated', async () => {
    const { transition } = await recordAccountWindowWithBurnAlert('ghost', { utilization7d: 0.9 }, T0);
    expect(transition).toBeNull();
    expect(h.assertFact).not.toHaveBeenCalled();
    expect(h.broadcastSevereEvent).not.toHaveBeenCalled();
  });
});
