/**
 * P-031 metering interception — the pure core and the BYOC honor-path leg.
 *
 * The four cases the plan item names by hand (through the doors, duplicate
 * nonce, cap exhaustion, cumulative regression) are covered here at the
 * interception point; the door-level halves live in the Worker route test and
 * the agent-tool door test.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptMeteredVoucher,
  buildUsageVoucher,
  closeMeteredInvocation,
  declareMeter,
  openMeteredInvocation,
  quoteMicros,
  usageReceiptSigningBytes,
  type BillableUnit,
  type MeterDeclaration,
} from './metered-invocation';
import { createMicrochargeChannel, type MicrochargeChannel } from './microcharge';
import { emptyMeteringLedger, contributionOf, spentOn } from './metering-ledger';
import { createByocBudget, prepareByocExecution, settleByocExecution } from './byoc-execution';

const TERMS = {
  unitPriceMicros: 250,
  meterUnit: 'tool-call',
  priceVersion: 'v3',
  splitManifestHash: `sha256:${'a'.repeat(64)}`,
};

function meter(): MeterDeclaration {
  const declared = declareMeter(TERMS);
  if (!declared.ok) throw new Error(`fixture terms must declare: ${declared.detail}`);
  return declared.meter;
}

function unit(overrides: Partial<BillableUnit> = {}): BillableUnit {
  return {
    payer: 'org_buyer',
    seller: 'gh:4242',
    releaseRef: 'sku:sentiment-tool@1.4.0',
    usageNonce: 'nonce-1',
    quantity: 4n,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

const signVoucher = () => 'payer-signature';
const signReceipt = () => 'seller-signature';

function open(channel: MicrochargeChannel, u: BillableUnit = unit(), nowMs = 1_000) {
  return openMeteredInvocation({ channel, meter: meter(), unit: u, nowMs, signVoucher });
}

describe('declareMeter', () => {
  it('accepts published per-use terms and converts the price to bigint micros', () => {
    const declared = declareMeter(TERMS);
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.meter.unitPriceMicros).toBe(250n);
    expect(declared.meter.meterUnit).toBe('tool-call');
  });

  it.each([
    ['a non-sha256 split hash', { ...TERMS, splitManifestHash: 'deadbeef' }],
    ['a zero unit price', { ...TERMS, unitPriceMicros: 0 }],
    ['a blank meter unit', { ...TERMS, meterUnit: '  ' }],
    ['a blank price version', { ...TERMS, priceVersion: '' }],
    ['an unsafe integer price', { ...TERMS, unitPriceMicros: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses %s so an unpriced unit can never be executed', (_label, terms) => {
    expect(declareMeter(terms)).toMatchObject({ ok: false, code: 'invalid-meter' });
  });
});

describe('metering interception on a billable unit', () => {
  it('binds payer, seller, release, nonce, quantity, price version and split hash into the reserved voucher', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.voucher).toMatchObject({
      channelId: 'ch_1',
      payer: 'org_buyer',
      seller: 'gh:4242',
      releaseRef: 'sku:sentiment-tool@1.4.0',
      usageNonce: 'nonce-1',
      meterQuantity: 4n,
      pricePerUnitMicros: 250n,
      priceVersion: 'v3',
      splitManifestHash: TERMS.splitManifestHash,
      signature: 'payer-signature',
    });
    // 4 units x 250 micros, reserved against a channel that had claimed nothing.
    expect(opened.voucher.cumulativeClaimMicros).toBe(1_000n);
    expect(opened.reservedMicros).toBe(1_000n);
    expect(opened.channel.reservations['nonce-1']).toBe(1_000n);
  });

  it('settles the served units into a signed usage receipt and commits the channel', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.receipt).toMatchObject({
      channelId: 'ch_1',
      usageNonce: 'nonce-1',
      meterQuantity: 4n,
      amountMicros: 1_000n,
      occurredAtMs: 2_000,
      signature: 'seller-signature',
    });
    expect(closed.receipt.voucherDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.channel.committedMicros).toBe(1_000n);
    expect(closed.channel.reservations['nonce-1']).toBeUndefined();
  });

  it('releases the unused reservation when fewer units were actually served', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      actualQuantity: 1n,
      occurredAtMs: 2_000,
      signReceipt,
    });
    expect(closed).toMatchObject({ ok: true, amountMicros: 250n });
    if (!closed.ok) return;
    expect(closed.receipt.meterQuantity).toBe(1n);
    expect(closed.channel.committedMicros).toBe(250n);
  });

  it('refuses to settle more units than were reserved', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        actualQuantity: 5n,
        occurredAtMs: 2_000,
        signReceipt,
      }),
    ).toMatchObject({ ok: false, code: 'actual-exceeds-reservation' });
  });

  it('refuses a DUPLICATE NONCE on both the reserved and the settled path', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    // Still reserved.
    expect(open(opened.channel, unit({ usageNonce: 'nonce-1' }))).toMatchObject({
      ok: false,
      code: 'duplicate-nonce',
    });
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    if (!closed.ok) throw new Error('settlement must close');
    // Already settled — the receipt is the durable replay guard.
    expect(open(closed.channel, unit({ usageNonce: 'nonce-1' }))).toMatchObject({
      ok: false,
      code: 'duplicate-nonce',
    });
  });

  it('refuses when the channel CAP is exhausted rather than serving on credit', () => {
    // Escrow covers three units at 250; the unit asks for four.
    const refused = open(createMicrochargeChannel('ch_small', 750n));
    expect(refused).toMatchObject({ ok: false, code: 'cap-exhausted' });
  });

  it('refuses cap exhaustion cumulatively, after earlier units have committed', () => {
    let channel = createMicrochargeChannel('ch_small', 1_500n);
    const first = open(channel, unit({ usageNonce: 'n-1', quantity: 4n }));
    if (!first.ok) throw new Error('first unit must reserve');
    const settled = closeMeteredInvocation({
      channel: first.channel,
      voucher: first.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    if (!settled.ok) throw new Error('first unit must settle');
    channel = settled.channel;
    expect(channel.committedMicros).toBe(1_000n);
    // 500 micros of headroom left; two more units (500) fit, three do not.
    expect(open(channel, unit({ usageNonce: 'n-2', quantity: 3n }))).toMatchObject({
      ok: false,
      code: 'cap-exhausted',
    });
    expect(open(channel, unit({ usageNonce: 'n-3', quantity: 2n })).ok).toBe(true);
  });

  it('refuses a CUMULATIVE REGRESSION when a payer replays a claim built on a stale channel view', () => {
    const stale = createMicrochargeChannel('ch_1', 10_000n);
    const first = open(stale, unit({ usageNonce: 'n-1' }));
    if (!first.ok) throw new Error('first unit must reserve');

    // The payer signs a SECOND unit against its stale pre-reservation view, so
    // the claim repeats a cumulative total the channel has already advanced past.
    const replayed = {
      ...buildUsageVoucher(stale, meter(), unit({ usageNonce: 'n-2' })),
      signature: 'payer-signature',
    };
    expect(replayed.cumulativeClaimMicros).toBe(first.voucher.cumulativeClaimMicros);

    expect(
      acceptMeteredVoucher({
        channel: first.channel,
        meter: meter(),
        unit: unit({ usageNonce: 'n-2' }),
        voucher: replayed,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, code: 'cumulative-regression' });
  });

  it('settling a nonce that was never reserved is refused rather than minting a receipt', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: { ...opened.voucher, usageNonce: 'never-reserved' },
        occurredAtMs: 2_000,
        signReceipt,
      }),
    ).toMatchObject({ ok: false, code: 'unknown-reservation' });
  });

  it('re-derives a wire voucher against the DECLARED meter and refuses forged terms', () => {
    const channel = createMicrochargeChannel('ch_1', 10_000n);
    const honest = { ...buildUsageVoucher(channel, meter(), unit()), signature: 'payer-signature' };
    expect(acceptMeteredVoucher({ channel, meter: meter(), unit: unit(), voucher: honest, nowMs: 1_000 }).ok).toBe(true);

    for (const [label, forged] of [
      ['a discounted unit price', { ...honest, pricePerUnitMicros: 1n }],
      ['an older price version', { ...honest, priceVersion: 'v1' }],
      ['a different split manifest', { ...honest, splitManifestHash: `sha256:${'b'.repeat(64)}` }],
      ['an inflated quantity', { ...honest, meterQuantity: 40n }],
      ['a substituted seller', { ...honest, seller: 'gh:9999' }],
    ] as const) {
      expect(
        acceptMeteredVoucher({ channel, meter: meter(), unit: unit(), voucher: forged, nowMs: 1_000 }),
        label,
      ).toMatchObject({ ok: false, code: 'terms-mismatch' });
    }

    expect(
      acceptMeteredVoucher({
        channel,
        meter: meter(),
        unit: unit(),
        voucher: honest,
        nowMs: 1_000,
        verifySignature: () => false,
      }),
    ).toMatchObject({ ok: false, code: 'invalid-voucher' });
  });

  it('refuses an expired voucher at the interception point', () => {
    expect(open(createMicrochargeChannel('ch_1', 10_000n), unit(), 20_000)).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it.each([
    ['a blank payer', unit({ payer: ' ' })],
    ['a blank seller', unit({ seller: '' })],
    ['a blank release ref', unit({ releaseRef: '' })],
    ['a blank usage nonce', unit({ usageNonce: '' })],
    ['a non-positive quantity', unit({ quantity: 0n })],
  ])('refuses %s before any voucher is signed', (_label, u) => {
    expect(open(createMicrochargeChannel('ch_1', 10_000n), u)).toMatchObject({
      ok: false,
      code: 'invalid-unit',
    });
  });

  it('refuses when a signer returns nothing rather than emitting an unsigned voucher or receipt', () => {
    expect(
      openMeteredInvocation({
        channel: createMicrochargeChannel('ch_1', 10_000n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher: () => '   ',
      }),
    ).toMatchObject({ ok: false, code: 'unsigned-voucher' });

    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        occurredAtMs: 2_000,
        signReceipt: () => '',
      }),
    ).toMatchObject({ ok: false, code: 'unsigned-receipt' });
  });

  it('signs the receipt over canonical bytes that carry the voucher digest', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    let signed: string | null = null;
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt: (bytes) => {
        signed = bytes.toString('utf8');
        return 'seller-signature';
      },
    });
    if (!closed.ok) throw new Error('settlement must close');
    expect(signed).not.toBeNull();
    expect(signed as unknown as string).toContain(closed.receipt.voucherDigest);
    expect(
      usageReceiptSigningBytes({
        channelId: closed.receipt.channelId,
        usageNonce: closed.receipt.usageNonce,
        meterQuantity: closed.receipt.meterQuantity,
        amountMicros: closed.receipt.amountMicros,
        voucherDigest: closed.receipt.voucherDigest,
        occurredAtMs: closed.receipt.occurredAtMs,
      }).toString('utf8'),
    ).toBe(signed as unknown as string);
  });

  it('records the served units on the metering ledger as part of settlement', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
      metering: {
        ledger: emptyMeteringLedger(),
        served: {
          hostRef: 'host-a',
          fleetSlug: 'fleet-a',
          axis: 'remote',
          unit: 'tokens',
          attestedUserId: 'user-1',
          perUserContributionCap: 3,
        },
      },
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok || !closed.metering) return;
    expect(spentOn(closed.metering, 'host-a', 'fleet-a', 'remote')).toBe(4);
    // M22: the per-user cap clamps the reciprocity credit, not the served spend.
    expect(contributionOf(closed.metering, 'user-1', 'remote')).toBe(3);
    expect(closed.contributionCredited).toBe(3);
  });

  it('refuses when the metering ledger refuses the served units (H14 unit discipline)', () => {
    const seeded = closeMeteredInvocation({
      channel: (() => {
        const o = open(createMicrochargeChannel('ch_1', 10_000n), unit({ usageNonce: 'n-1' }));
        if (!o.ok) throw new Error('reservation must open');
        return o.channel;
      })(),
      voucher: (() => {
        const o = open(createMicrochargeChannel('ch_1', 10_000n), unit({ usageNonce: 'n-1' }));
        if (!o.ok) throw new Error('reservation must open');
        return o.voucher;
      })(),
      occurredAtMs: 2_000,
      signReceipt,
      metering: {
        ledger: emptyMeteringLedger(),
        served: { hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote', unit: 'tokens' },
      },
    });
    if (!seeded.ok || !seeded.metering) throw new Error('seed settlement must close');

    const opened = open(createMicrochargeChannel('ch_2', 10_000n), unit({ usageNonce: 'n-2' }));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        occurredAtMs: 2_000,
        signReceipt,
        metering: {
          ledger: seeded.metering,
          served: { hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote', unit: 'slots' },
        },
      }),
    ).toMatchObject({ ok: false, code: 'metering-refused' });
  });

  it('quotes a unit price without floating point', () => {
    expect(quoteMicros(meter(), 7n)).toBe(1_750n);
  });
});

describe('BYOC honor path (P-017) under a per-use meter', () => {
  const base = {
    hostRef: 'host-a',
    fleetSlug: 'fleet-a',
    axis: 'remote' as const,
    unit: 'usd-micros' as const,
    billedAmount: 10,
    reservationId: 'call-1',
    billingMode: 'host-pays' as const,
  };

  it('reserves the microcharge before execution and settles a receipt after it', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const prepared = prepareByocExecution({
      budget,
      context: base,
      microcharge: {
        channel: createMicrochargeChannel('ch_byoc', 10_000n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.microcharge) throw new Error('honor path must reserve a microcharge');
    expect(prepared.microcharge.reservedMicros).toBe(1_000n);

    const settled = settleByocExecution({
      budget: prepared.ledger,
      metering: emptyMeteringLedger(),
      context: base,
      actualAmount: 7,
      microcharge: {
        channel: prepared.microcharge.channel,
        voucher: prepared.microcharge.voucher,
        occurredAtMs: 2_000,
        signReceipt,
      },
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok || !settled.microcharge) throw new Error('honor path must settle a microcharge');
    expect(settled.microcharge.receipt).toMatchObject({ usageNonce: 'nonce-1', meterQuantity: 4n, amountMicros: 1_000n });
    expect(settled.microcharge.channel.committedMicros).toBe(1_000n);
    // The budget commit is what records the served units; the microcharge leg
    // must not double-count them.
    expect(spentOn(settled.metering, 'host-a', 'fleet-a', 'remote')).toBe(7);
  });

  it('refuses the whole call when the channel cap is exhausted, without drawing the local budget', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const refused = prepareByocExecution({
      budget,
      context: base,
      microcharge: {
        channel: createMicrochargeChannel('ch_byoc', 750n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher,
      },
    });
    expect(refused).toMatchObject({ ok: false, code: 'cap-exhausted' });
    // The pure reserve never mutates: the caller's budget is untouched.
    expect(budget).toEqual(createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' }));
  });

  it('is unchanged when no meter is declared — the free/allowance honor path keeps its shape', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const prepared = prepareByocExecution({ budget, context: base });
    expect(prepared).toMatchObject({ ok: true, relay: 'local-only' });
    if (!prepared.ok) return;
    expect(prepared.microcharge).toBeUndefined();
    const settled = settleByocExecution({
      budget: prepared.ledger,
      metering: emptyMeteringLedger(),
      context: base,
      actualAmount: 7,
    });
    expect(settled).toMatchObject({ ok: true, committedAmount: 7 });
    if (!settled.ok) return;
    expect(settled.microcharge).toBeUndefined();
  });
});
