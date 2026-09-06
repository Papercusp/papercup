/**
 * P-031 — metering interception THROUGH THE DOORS.
 *
 * The fake below is not a stub that echoes what the client sent: it holds the
 * channel and re-runs the same pure interception the hosted Worker route runs,
 * so a client that skipped a refusal is caught here rather than agreed with.
 * That is the property under test — the door refuses independently — and a
 * mock that simply returned 201 would assert the opposite of it.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptMeteredVoucher,
  closeMeteredInvocation,
  declareMeter,
  type BillableUnit,
} from '../p2p/metered-invocation';
import {
  createMicrochargeChannel,
  paymentVoucherDigest,
  unsignedVoucher,
  type CumulativePaymentVoucher,
  type MicrochargeChannel,
} from '../p2p/microcharge';
import {
  channelFromUsage,
  reserveMeteredUnit,
  settleMeteredUnit,
  type UsageReceiptWire,
} from './metered-invocation-door-io';

const TERMS = {
  unitPriceMicros: 2_500,
  meterUnit: 'inference-call',
  priceVersion: 'v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}`,
} as const;

const PAYER = 'gh:1001';
const SELLER = 'gh:2002';
const RELEASE = 'release/agent-pack@1.2.3';
const CHANNEL = 'ch_test';
const NOW = 1_700_000_000_000;

/** A hosted door that actually decides, backed by the same pure core. */
function fakeDoor(options: { escrowMicros: bigint; failNextReserveWith?: { status: number; error: string } }) {
  let channel: MicrochargeChannel = createMicrochargeChannel(CHANNEL, options.escrowMicros);
  const rows = new Map<string, UsageReceiptWire>();
  const calls: string[] = [];
  let failNext = options.failNextReserveWith;

  const usageBody = () => ({
    channelId: CHANNEL,
    escrowMicros: String(channel.escrowMicros),
    committedMicros: String(channel.committedMicros),
    receipts: [...rows.values()],
  });

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);

    if (method === 'GET' && path.endsWith('/usage')) return json(usageBody(), 200);

    if (method === 'POST' && path.endsWith('/metered-invocations')) {
      if (failNext) {
        const forced = failNext;
        failNext = undefined;
        return json({ error: forced.error, detail: 'forced by the fake door' }, forced.status);
      }
      const body = JSON.parse(String(init?.body)) as { voucher: Record<string, string | number> };
      const w = body.voucher;
      const voucher: CumulativePaymentVoucher = {
        channelId: String(w.channelId),
        payer: String(w.payer),
        seller: String(w.seller),
        releaseRef: String(w.releaseRef),
        usageNonce: String(w.usageNonce),
        meterQuantity: BigInt(w.meterQuantity),
        pricePerUnitMicros: BigInt(w.pricePerUnitMicros),
        priceVersion: String(w.priceVersion),
        splitManifestHash: String(w.splitManifestHash),
        expiresAtMs: Number(w.expiresAtMs),
        cumulativeClaimMicros: BigInt(w.cumulativeClaimMicros),
        signature: String(w.signature),
      };
      const declared = declareMeter(TERMS);
      if (!declared.ok) return json({ error: declared.code, detail: declared.detail }, 422);
      const unit: BillableUnit = {
        payer: PAYER,
        seller: SELLER,
        releaseRef: RELEASE,
        usageNonce: voucher.usageNonce,
        quantity: voucher.meterQuantity,
        expiresAtMs: voucher.expiresAtMs,
      };
      const accepted = acceptMeteredVoucher({ channel, meter: declared.meter, unit, voucher, nowMs: NOW });
      if (!accepted.ok) return json({ error: accepted.code, detail: accepted.detail }, 409);
      channel = accepted.channel;
      const row: UsageReceiptWire = {
        channelId: CHANNEL,
        usageNonce: voucher.usageNonce,
        offerId: 'offer_1',
        payer: voucher.payer,
        seller: voucher.seller,
        releaseRef: voucher.releaseRef,
        meterUnit: declared.meter.meterUnit,
        meterQuantity: String(voucher.meterQuantity),
        unitPriceMicros: String(voucher.pricePerUnitMicros),
        priceVersion: voucher.priceVersion,
        splitManifestHash: voucher.splitManifestHash,
        reservedMicros: String(accepted.reservedMicros),
        amountMicros: null,
        cumulativeClaimMicros: String(voucher.cumulativeClaimMicros),
        expiresAtMs: voucher.expiresAtMs,
        voucherDigest: paymentVoucherDigest(unsignedVoucher(voucher)),
        voucherSignature: voucher.signature,
        receiptSignature: null,
        state: 'reserved',
        reservedAtMs: NOW,
        settledAtMs: null,
      };
      rows.set(row.usageNonce, row);
      return json({ reserved: true, receipt: row }, 201);
    }

    if (method === 'POST' && path.endsWith('/settle')) {
      const nonce = decodeURIComponent(path.split('/').at(-2) as string);
      const row = rows.get(nonce);
      if (!row) return json({ error: 'unknown-reservation', detail: nonce }, 404);
      const body = JSON.parse(String(init?.body)) as { receiptSignature: string; actualQuantity?: string };
      const voucher: CumulativePaymentVoucher = {
        channelId: row.channelId,
        payer: row.payer,
        seller: row.seller,
        releaseRef: row.releaseRef,
        usageNonce: row.usageNonce,
        meterQuantity: BigInt(row.meterQuantity),
        pricePerUnitMicros: BigInt(row.unitPriceMicros),
        priceVersion: row.priceVersion,
        splitManifestHash: row.splitManifestHash,
        expiresAtMs: row.expiresAtMs,
        cumulativeClaimMicros: BigInt(row.cumulativeClaimMicros),
        signature: row.voucherSignature,
      };
      const closed = closeMeteredInvocation({
        channel,
        voucher,
        ...(body.actualQuantity !== undefined ? { actualQuantity: BigInt(body.actualQuantity) } : {}),
        occurredAtMs: NOW,
        signReceipt: () => body.receiptSignature,
      });
      if (!closed.ok) return json({ error: closed.code, detail: closed.detail }, 409);
      channel = closed.channel;
      const settled: UsageReceiptWire = {
        ...row,
        amountMicros: String(closed.amountMicros),
        meterQuantity: String(closed.receipt.meterQuantity),
        receiptSignature: closed.receipt.signature,
        voucherDigest: closed.receipt.voucherDigest,
        state: 'settled',
        settledAtMs: NOW,
      };
      rows.set(nonce, settled);
      return json({ settled: true, receipt: settled }, 200);
    }

    return json({ error: 'not_found', detail: path }, 404);
  }) as unknown as typeof fetch;

  return {
    deps: { fetchImpl, baseUrl: 'https://cupboard.test', authToken: 'test-token' },
    calls,
    channel: () => channel,
    row: (nonce: string) => rows.get(nonce),
  };
}

/** Deterministic, and distinct per byte string, so a wrong-bytes signature shows. */
const signer = (tag: string) => async (bytes: Buffer) => `${tag}:${bytes.toString('base64url').slice(0, 24)}`;

const reserveArgs = (nonce: string, quantity: bigint) => ({
  channelId: CHANNEL,
  offerId: 'offer_1',
  terms: TERMS,
  payer: PAYER,
  seller: SELLER,
  releaseRef: RELEASE,
  usageNonce: nonce,
  quantity,
  expiresAtMs: NOW + 60_000,
  nowMs: NOW,
  signVoucher: signer('payer'),
});

describe('metering interception through the hosted doors', () => {
  it('reserves a unit before execution and settles the units served after it', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });

    const reserved = await reserveMeteredUnit(reserveArgs('n1', 4n), door.deps);
    expect(reserved.ok).toBe(true);
    if (reserved.ok !== true) return;
    expect(reserved.reservedMicros).toBe(10_000n); // 4 × 2_500
    expect(reserved.receipt.state).toBe('reserved');
    // Reserving must not commit: the escrow is held, not spent, until settlement.
    expect(door.channel().committedMicros).toBe(0n);

    const settled = await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    expect(settled.ok).toBe(true);
    if (settled.ok !== true) return;
    expect(settled.amountMicros).toBe(10_000n);
    expect(settled.receipt.state).toBe('settled');
    expect(door.channel().committedMicros).toBe(10_000n);
  });

  it('settles only the units ACTUALLY served, releasing the rest of the reservation', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    await reserveMeteredUnit(reserveArgs('n1', 10n), door.deps);

    const settled = await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', actualQuantity: 3n, occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    expect(settled.ok).toBe(true);
    if (settled.ok !== true) return;
    expect(settled.amountMicros).toBe(7_500n);
    // The other 17_500 went back to the channel rather than being stranded.
    expect(door.channel().committedMicros).toBe(7_500n);
    expect(door.channel().reservations).toEqual({});
  });

  it('binds the settled receipt to the voucher the payer actually signed', async () => {
    // Regression: rebuilding the reservation with a SUBSTITUTED expiresAtMs
    // produced a receipt digest over a voucher nobody signed — well-formed, and
    // bound to nothing. expiresAtMs is a canonical field of the digest.
    const door = fakeDoor({ escrowMicros: 100_000n });
    const reserved = await reserveMeteredUnit(reserveArgs('n1', 2n), door.deps);
    expect(reserved.ok).toBe(true);
    if (reserved.ok !== true) return;

    const reservedRow = door.row('n1') as UsageReceiptWire;
    expect(reservedRow.expiresAtMs).toBe(NOW + 60_000);

    await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    const settledRow = door.row('n1') as UsageReceiptWire;
    expect(settledRow.voucherDigest).toBe(paymentVoucherDigest(unsignedVoucher(reserved.voucher)));
    expect(settledRow.voucherDigest).toBe(reservedRow.voucherDigest);
  });

  it('refuses a DUPLICATE NONCE rather than billing the same unit twice', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    expect((await reserveMeteredUnit(reserveArgs('n1', 2n), door.deps)).ok).toBe(true);

    const replay = await reserveMeteredUnit(reserveArgs('n1', 2n), door.deps);
    expect(replay.ok).toBe(false);
    if (replay.ok !== false) return;
    expect(replay.code).toBe('duplicate-nonce');
    expect(door.channel().committedMicros).toBe(0n);
  });

  it('refuses when the channel CAP is exhausted, cumulatively across earlier units', async () => {
    const door = fakeDoor({ escrowMicros: 10_000n });
    expect((await reserveMeteredUnit(reserveArgs('n1', 3n), door.deps)).ok).toBe(true); // 7_500 of 10_000

    const overflow = await reserveMeteredUnit(reserveArgs('n2', 2n), door.deps); // +5_000 > escrow
    expect(overflow.ok).toBe(false);
    if (overflow.ok !== false) return;
    expect(overflow.code).toBe('cap-exhausted');
  });

  it('refuses an unpriced unit BEFORE the network, not after the seller served it', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    const outcome = await reserveMeteredUnit(
      { ...reserveArgs('n1', 1n), terms: { ...TERMS, splitManifestHash: 'not-a-hash' } },
      door.deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.code).toBe('invalid-meter');
    expect(outcome.refusedBy).toBe('local-interception');
    // The whole point of refusing locally: no request was made at all.
    expect(door.calls).toEqual([]);
  });

  it('refuses to emit an unsigned voucher when the payer signer returns nothing', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    const outcome = await reserveMeteredUnit({ ...reserveArgs('n1', 1n), signVoucher: () => '' }, door.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.code).toBe('unsigned-voucher');
    expect(door.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('surfaces a HOSTED refusal as the door’s, not as a local verdict', async () => {
    // A cumulative regression is only visible to the party holding the durable
    // channel, so the client must report the hosted refusal verbatim rather than
    // flattening it into a local one.
    const door = fakeDoor({
      escrowMicros: 100_000n,
      failNextReserveWith: { status: 409, error: 'cumulative-regression' },
    });
    const outcome = await reserveMeteredUnit(reserveArgs('n1', 1n), door.deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.code).toBe('cumulative-regression');
    expect(outcome.status).toBe(409);
    expect(outcome.refusedBy).toBe('hosted-door');
  });

  it('refuses to settle a nonce that was never reserved', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    const outcome = await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'never', occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.code).toBe('unknown-reservation');
    expect(door.calls.some((c) => c.includes('/settle'))).toBe(false);
  });

  it('refuses to settle the same unit twice', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    await reserveMeteredUnit(reserveArgs('n1', 1n), door.deps);
    await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );

    const again = await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    expect(again.ok).toBe(false);
    if (again.ok !== false) return;
    expect(again.code).toBe('already-settled');
    expect(door.channel().committedMicros).toBe(2_500n);
  });

  it('refuses to settle MORE units than were reserved', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    await reserveMeteredUnit(reserveArgs('n1', 2n), door.deps);

    const outcome = await settleMeteredUnit(
      { channelId: CHANNEL, usageNonce: 'n1', actualQuantity: 5n, occurredAtMs: NOW, signReceipt: signer('seller') },
      door.deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok !== false) return;
    expect(outcome.code).toBe('actual-exceeds-reservation');
  });

  it('advances the cumulative claim across units so a replayed claim cannot pass', async () => {
    const door = fakeDoor({ escrowMicros: 100_000n });
    const first = await reserveMeteredUnit(reserveArgs('n1', 2n), door.deps);
    const second = await reserveMeteredUnit(reserveArgs('n2', 2n), door.deps);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok !== true || second.ok !== true) return;
    expect(first.voucher.cumulativeClaimMicros).toBe(5_000n);
    expect(second.voucher.cumulativeClaimMicros).toBe(10_000n);
  });
});

describe('channelFromUsage', () => {
  it('takes the HIGHEST observed claim as the watermark, not the last row', async () => {
    // Row order is not claim order; deriving from the max is what lets a client
    // that missed a unit recover the right base instead of regressing.
    const channel = channelFromUsage({
      channelId: CHANNEL,
      escrowMicros: '100000',
      committedMicros: '5000',
      receipts: [
        { cumulativeClaimMicros: '9000', usageNonce: 'b', state: 'settled', reservedMicros: '4000', voucherDigest: 'd2' },
        { cumulativeClaimMicros: '5000', usageNonce: 'a', state: 'settled', reservedMicros: '5000', voucherDigest: 'd1' },
      ] as unknown as readonly UsageReceiptWire[],
    });
    expect(channel.lastCumulativeMicros).toBe(9_000n);
    expect(channel.committedMicros).toBe(5_000n);
    expect(channel.reservations).toEqual({});
  });

  it('carries an open reservation forward so a duplicate nonce is caught locally', async () => {
    const channel = channelFromUsage({
      channelId: CHANNEL,
      escrowMicros: '100000',
      committedMicros: '0',
      receipts: [
        { cumulativeClaimMicros: '2500', usageNonce: 'open', state: 'reserved', reservedMicros: '2500', voucherDigest: 'd' },
      ] as unknown as readonly UsageReceiptWire[],
    });
    expect(channel.reservations).toEqual({ open: 2_500n });
  });
});
