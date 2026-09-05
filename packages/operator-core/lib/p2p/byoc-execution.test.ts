import { describe, expect, it } from 'vitest';
import { createByocBudget, prepareByocExecution, settleByocExecution } from './byoc-execution';
import { grantLease } from './inference-lease';
import { emptyMeteringLedger, spentOn } from './metering-ledger';

const base = {
  hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote' as const, unit: 'usd-micros' as const,
  billedAmount: 10, reservationId: 'call-1', billingMode: 'host-pays' as const,
};

describe('BYOC execution seam', () => {
  it('reserves and settles local execution while recording spend and contribution', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const prepared = prepareByocExecution({ budget, context: { ...base, attestedUserId: 'user-1', perUserContributionCap: 100 } });
    expect(prepared).toMatchObject({ ok: true, relay: 'local-only' });
    if (!prepared.ok) return;
    const settled = settleByocExecution({ budget: prepared.ledger, metering: emptyMeteringLedger(), context: { ...base, attestedUserId: 'user-1', perUserContributionCap: 100 }, actualAmount: 7 });
    expect(settled).toMatchObject({ ok: true, committedAmount: 7, contributionCredited: 7 });
    if (settled.ok) expect(spentOn(settled.metering, 'host-a', 'fleet-a', 'remote')).toBe(7);
  });

  it('revalidates leases and refuses a streaming relay', () => {
    const lease = grantLease({ leaseId: 'lease-1', fleetSlug: 'fleet-a', axis: 'remote', amount: 10, unit: 'usd-micros', ttlMs: 10_000, ownerEpoch: 2 }, { nowReceiver: 1_000, advisoryRemaining: 20 });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const refused = prepareByocExecution({ budget, context: { ...base, lease: lease.lease, claimGate: { admits: true }, nowReceiver: 2_000, ownerHighWaterEpoch: 2, billingContext: { gatewayLeg: 'streaming-relay' } } });
    expect(refused).toMatchObject({ ok: false, code: 'relay_forbidden_v1' });
  });

  it('fails closed when claim-time gate refuses despite a valid lease', () => {
    const lease = grantLease({ leaseId: 'lease-2', fleetSlug: 'fleet-a', axis: 'remote', amount: 10, unit: 'usd-micros', ttlMs: 10_000, ownerEpoch: 1 }, { nowReceiver: 1_000, advisoryRemaining: 20 });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const refused = prepareByocExecution({ budget, context: { ...base, lease: lease.lease, claimGate: { admits: false, reason: 'provider cap' }, nowReceiver: 2_000, ownerHighWaterEpoch: 1 } });
    expect(refused).toMatchObject({ ok: false, code: 'gate_refused' });
  });
});
