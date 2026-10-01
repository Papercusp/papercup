/**
 * The reconciliation pass end to end over injected rails (P-043, D-025 §4-§5):
 * import first, then reconcile, file breaks once, and push a signed gate that
 * the Worker can verify. The PG store and the Worker routes have their own tests.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEntry } from './money-journal';
import type { StripeBalanceTransaction, StripeBalanceTransactionLister } from './money-journal-producers';
import { memoryReconciliationStore, type BreakFiler, type GatePublisher } from './reconciliation';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_PATH,
  parseReconciliationInputs,
  parseTransferGatePush,
  signReconciliationRequest,
  verifyReconciliationRequest,
  type ReconciliationInputs,
} from './reconciliation-hmac';
import {
  centsFromMicros,
  cupboardGatePublisher,
  cupboardInputsReader,
  parseMoneyJournalPolicy,
  readReconciliationRuntimeConfig,
  runReconciliationPass,
  type ReconciliationRuntimeConfig,
} from './reconciliation-runtime';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00Z, provisional period = October
const IN_MONTH_S = Math.floor(Date.UTC(2026, 9, 3, 9, 0, 0) / 1000);
const WS = 'ws-recon';
const SECRET = 'test-reconciliation-secret';
const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;

const charge: StripeBalanceTransaction = {
  id: 'txn_charge1',
  type: 'charge',
  amount: 10_000,
  fee: 320,
  currency: 'usd',
  created: IN_MONTH_S,
  source: { id: 'ch_1', object: 'charge', invoice: null },
};
const credits: StripeBalanceTransaction = {
  id: 'txn_credits1',
  type: 'charge',
  amount: 5_000,
  fee: 175,
  currency: 'usd',
  created: IN_MONTH_S + 60,
  source: { id: 'ch_2', object: 'charge', invoice: null, metadata: { purpose: 'prepaid-credits' } },
};
const payout: StripeBalanceTransaction = { id: 'txn_payout1', type: 'payout', amount: -4_000, fee: 0, currency: 'usd', created: IN_MONTH_S + 120 };

function lister(bts: readonly StripeBalanceTransaction[]): StripeBalanceTransactionLister {
  return async () => ({ data: bts, has_more: false });
}

function config(overrides: Partial<ReconciliationRuntimeConfig> = {}): ReconciliationRuntimeConfig {
  return {
    stripeSecretKeyRef: 'env:STRIPE_TEST',
    stripeJournalWorkspace: WS,
    treasuryWorkspace: WS,
    policy: { daoBasisPoints: 1_000, refundReserveBasisPoints: 500 },
    policyError: null,
    gateSecretRef: 'env:RECON_SECRET',
    cupboardUrl: 'https://cupboard.test',
    chainRpcUrl: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<ReconciliationInputs> = {}): ReconciliationInputs {
  return {
    // The credit purchase above books 5,000c to the reserve; 4,000c of credits remain owed.
    outstandingCreditsMicros: 4_000 * 10_000,
    daoTransfers: [{ transferId: 'tt-1', chainId: 84532, transactionHash: TX_A, amountMicros: 500 * 10_000, createdAtMs: NOW - 86_400_000 }],
    generatedAtMs: NOW,
    ...overrides,
  };
}

/** An in-memory journal with the store's idempotency semantics. */
function journal(seed: readonly JournalEntry[] = []) {
  const entries = new Map<string, JournalEntry>(seed.map((e) => [e.entryId, e]));
  return {
    entries,
    post: () => async (entry: JournalEntry) => {
      if (entries.has(entry.entryId)) return { ok: true as const, duplicate: true };
      entries.set(entry.entryId, entry);
      return { ok: true as const, duplicate: false };
    },
    read: async () => [...entries.values()],
  };
}

function recordingFiler() {
  const filed: string[] = [];
  const resolved: string[] = [];
  const filer: BreakFiler = {
    async fileBreak({ verdict }) {
      filed.push(verdict.invariant);
      return `WI-${filed.length}`;
    },
    async noteResolved({ workItemId }) {
      resolved.push(workItemId);
    },
  };
  return { filer, filed, resolved };
}

function capturingFetch(status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body ?? '') });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('reconciliation request signing', () => {
  it('verifies a signature over the exact method, path and body, within five minutes', async () => {
    const header = await signReconciliationRequest({ secret: SECRET, method: 'PUT', pathname: TRANSFER_GATE_PATH, body: '{"a":1}', nowMs: NOW });
    const base = { secret: SECRET, header, method: 'PUT', pathname: TRANSFER_GATE_PATH, body: '{"a":1}' };
    expect(await verifyReconciliationRequest({ ...base, nowMs: NOW + 60_000 })).toEqual({ ok: true });
    expect(await verifyReconciliationRequest({ ...base, nowMs: NOW + 6 * 60_000 })).toEqual({ ok: false, reason: 'stale' });
    expect(await verifyReconciliationRequest({ ...base, body: '{"a":2}', nowMs: NOW })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReconciliationRequest({ ...base, pathname: '/commerce/treasury/reconciliation-inputs', nowMs: NOW })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await verifyReconciliationRequest({ ...base, secret: 'other', nowMs: NOW })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReconciliationRequest({ ...base, secret: undefined, nowMs: NOW })).toEqual({ ok: false, reason: 'not-configured' });
    expect(await verifyReconciliationRequest({ ...base, header: 't=1,v1=zz', nowMs: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a gate push that is open with reasons, or that omits treasuryReconciled', () => {
    const push = { workspaceId: WS, open: true, reasons: [], runId: 'r1', atMs: NOW, treasuryReconciled: true };
    expect(parseTransferGatePush(push)).toEqual(push);
    expect(parseTransferGatePush({ ...push, reasons: ['break open: x'] })).toBeNull();
    const { treasuryReconciled: _omit, ...withoutFlag } = push;
    expect(parseTransferGatePush(withoutFlag)).toBeNull();
  });

  it('refuses malformed Worker inputs instead of guessing', () => {
    expect(() => parseReconciliationInputs({ outstandingCreditsMicros: -1, daoTransfers: [] })).toThrow(/outstandingCreditsMicros/);
    expect(() =>
      parseReconciliationInputs({ outstandingCreditsMicros: 0, daoTransfers: [{ transferId: 'x', chainId: 1, transactionHash: '0x12', amountMicros: 1, createdAtMs: 1 }] }),
    ).toThrow(/daoTransfers\[0\]/);
  });
});

describe('reconciliation runtime configuration', () => {
  it('reads every rail from the environment, defaulting the treasury to the Stripe workspace', () => {
    const c = readReconciliationRuntimeConfig({
      PAPERCUSP_STRIPE_SECRET_KEY_REF: 'file:/k',
      PAPERCUSP_STRIPE_JOURNAL_WORKSPACE: 'ws-a',
      PAPERCUSP_MONEY_JOURNAL_POLICY: '{"daoBasisPoints":1000,"refundReserveBasisPoints":500}',
      PAPERCUSP_RECONCILIATION_GATE_SECRET_REF: 'env:X',
      PAPERCUSP_CUPBOARD_URL: 'https://w.test/',
    });
    expect(c).toMatchObject({ stripeJournalWorkspace: 'ws-a', treasuryWorkspace: 'ws-a', cupboardUrl: 'https://w.test', policyError: null });
    expect(readReconciliationRuntimeConfig({}).treasuryWorkspace).toBeNull();
    expect(parseMoneyJournalPolicy('{"daoBasisPoints":9000,"refundReserveBasisPoints":2000}').error).toMatch(/exceed/);
    expect(centsFromMicros(1_234_999)).toBe(123);
  });
});

describe('runReconciliationPass', () => {
  it('imports Stripe and DAO transfers first, then reconciles every invariant it can and opens the gate', async () => {
    const j = journal();
    const store = memoryReconciliationStore();
    const { filer, filed } = recordingFiler();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config(),
        resolveSecret: async () => SECRET,
        stripeLister: lister([charge, credits, payout]),
        cupboardInputs: async () => inputs(),
        chainVerifier: async () => true,
        store,
        filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    const ws = result.workspaces[0]!;
    expect(ws.error).toBeNull();
    expect(ws.stripeImport).toMatchObject({ scanned: 3, posted: 2, skipped: [{ sourceId: 'txn_payout1' }] });
    expect(ws.daoTransferImport).toMatchObject({ scanned: 1, posted: 1 });
    expect([...j.entries.keys()].sort()).toEqual(['chain-tx:84532:' + TX_A, 'stripe-bt:txn_charge1', 'stripe-bt:txn_credits1']);
    const status = Object.fromEntries(ws.run!.verdicts.map((v) => [v.invariant, v.status]));
    expect(status).toEqual({
      'credit-reserve-covers-outstanding-credits': 'ok',
      'dao-payable-equals-accrued-minus-transferred': 'ok',
      'safe-balance-equals-receipts-minus-approved-spends': 'not-configured',
      'journal-matches-stripe': 'ok',
      'journal-matches-bank': 'not-configured',
      'journal-matches-chain': 'ok',
    });
    // The charge accrued 1,000c to the DAO (10% of 10,000 net); the imported 500c
    // transfer debited it, so payable 500c = accrued 1,000c - transferred 500c.
    expect(ws.run!.verdicts.find((v) => v.invariant === 'dao-payable-equals-accrued-minus-transferred')!.detail).toBe(
      'journal dao-payable 500c; accrued 1000c - transferred on chain 500c = 500c',
    );
    expect(filed).toEqual([]);
    // The gate push is signed, verifiable by the Worker, and carries treasuryReconciled.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`https://cupboard.test${TRANSFER_GATE_PATH}`);
    expect(
      await verifyReconciliationRequest({
        secret: SECRET,
        header: call.headers[RECONCILIATION_SIGNATURE_HEADER],
        method: 'PUT',
        pathname: TRANSFER_GATE_PATH,
        body: call.body,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
    expect(parseTransferGatePush(JSON.parse(call.body))).toEqual({
      workspaceId: WS,
      open: true,
      reasons: [],
      runId: ws.run!.runId,
      atMs: NOW,
      treasuryReconciled: true,
    });
  });

  it('a re-run is idempotent: nothing is re-posted and an open break files no second item', async () => {
    const j = journal();
    const store = memoryReconciliationStore();
    const { filer, filed } = recordingFiler();
    const deps = {
      config: config(),
      resolveSecret: async () => SECRET,
      stripeLister: lister([charge]),
      // No credit purchase was journaled, so any outstanding credit breaks the reserve invariant.
      cupboardInputs: async () => inputs({ outstandingCreditsMicros: 1, daoTransfers: [] }),
      chainVerifier: async () => true,
      store,
      filer,
      gate: { publish: async () => ({ published: true as const }) },
      post: j.post,
      readEntries: j.read,
      now: () => NOW,
    };
    const first = await runReconciliationPass({ mode: 'provisional', workspaces: [WS] }, deps);
    const second = await runReconciliationPass({ mode: 'provisional', workspaces: [WS] }, deps);
    expect(second.workspaces[0]!.stripeImport).toMatchObject({ posted: 0, duplicates: 1 });
    expect(first.workspaces[0]!.run!.opened).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(second.workspaces[0]!.run!.opened).toEqual([]);
    expect(filed).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(second.workspaces[0]!.run!.gate).toEqual({ open: false, reasons: ['break open: credit-reserve-covers-outstanding-credits'] });
    expect(store.runs).toHaveLength(2);
  });

  it('a journal entry citing a transaction the chain reports reverted breaks journal-matches-chain', async () => {
    const seeded = journal();
    // A previous run journaled TX_B; the chain now says it never succeeded.
    await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs({ daoTransfers: [{ transferId: 'tt-b', chainId: 84532, transactionHash: TX_B, amountMicros: 100 * 10_000, createdAtMs: NOW - 1000 }] }),
        chainVerifier: async () => true,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        gate: { publish: async () => ({ published: true as const }) },
        post: seeded.post,
        readEntries: seeded.read,
        now: () => NOW,
      },
    );
    const { filer, filed } = recordingFiler();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs({ daoTransfers: [{ transferId: 'tt-b', chainId: 84532, transactionHash: TX_B, amountMicros: 100 * 10_000, createdAtMs: NOW - 1000 }] }),
        chainVerifier: async () => false,
        store: memoryReconciliationStore(),
        filer,
        gate: { publish: async () => ({ published: true as const }) },
        post: seeded.post,
        readEntries: seeded.read,
        now: () => NOW,
      },
    );
    const chain = result.workspaces[0]!.run!.verdicts.find((v) => v.invariant === 'journal-matches-chain')!;
    expect(chain.status).toBe('broken');
    expect(chain.detail).toContain(`chain-tx:84532:${TX_B}`);
    expect(filed).toContain('journal-matches-chain');
    expect(result.workspaces[0]!.run!.gate.open).toBe(false);
  });

  it('a Worker that cannot be read leaves the treasury invariants unknown, closes the gate, and says treasuryReconciled:false', async () => {
    const j = journal();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => {
          throw new Error('cupboard reconciliation-inputs: status 503');
        },
        chainVerifier: null,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    const run = result.workspaces[0]!.run!;
    const status = Object.fromEntries(run.verdicts.map((v) => [v.invariant, v.status]));
    expect(status['credit-reserve-covers-outstanding-credits']).toBe('unknown');
    expect(status['dao-payable-equals-accrued-minus-transferred']).toBe('unknown');
    expect(run.gate.open).toBe(false);
    expect(run.gate.reasons.join('\n')).toMatch(/cannot evaluate credit-reserve-covers-outstanding-credits: .*503/);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ open: false, treasuryReconciled: false });
  });

  it('a workspace that does not own the treasury never claims to have reconciled it', async () => {
    const j = journal();
    const { calls, fetchImpl } = capturingFetch();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: ['ws-other'] },
      {
        config: config({ stripeSecretKeyRef: null }),
        resolveSecret: async () => SECRET,
        cupboardInputs: async () => inputs(),
        chainVerifier: async () => true,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
        fetchImpl,
      },
    );
    expect(result.workspaces[0]!.daoTransferImport).toMatchObject({ skipped: expect.stringMatching(/treasury/) });
    expect(j.entries.size).toBe(0);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ workspaceId: 'ws-other', open: true, treasuryReconciled: false });
  });

  it('a Stripe key without a payment policy reads Stripe as failed rather than mapping with a guessed split', async () => {
    const j = journal();
    const result = await runReconciliationPass(
      { mode: 'provisional', workspaces: [WS] },
      {
        config: config({ policy: null, gateSecretRef: null }),
        resolveSecret: async () => SECRET,
        stripeLister: lister([charge]),
        cupboardInputs: null,
        store: memoryReconciliationStore(),
        filer: recordingFiler().filer,
        post: j.post,
        readEntries: j.read,
        now: () => NOW,
      },
    );
    const ws = result.workspaces[0]!;
    expect(ws.stripeImport).toMatchObject({ skipped: expect.stringMatching(/PAPERCUSP_MONEY_JOURNAL_POLICY/) });
    expect(ws.run!.verdicts.find((v) => v.invariant === 'journal-matches-stripe')).toMatchObject({ status: 'unknown' });
    expect(ws.run!.gatePublish).toMatchObject({ published: false, detail: expect.stringMatching(/GATE_SECRET_REF/) });
  });
});

describe('Worker clients', () => {
  it('the inputs reader signs a GET the Worker can verify, and parses the body', async () => {
    let seen: { url: string; header: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, header: (init.headers as Record<string, string>)[RECONCILIATION_SIGNATURE_HEADER]! };
      return Response.json(inputs());
    }) as unknown as typeof fetch;
    const read = cupboardInputsReader({ baseUrl: 'https://cupboard.test', secret: SECRET, fetchImpl, now: () => NOW });
    expect((await read()).daoTransfers).toHaveLength(1);
    expect(seen!.url).toBe('https://cupboard.test/commerce/treasury/reconciliation-inputs');
    expect(
      await verifyReconciliationRequest({ secret: SECRET, header: seen!.header, method: 'GET', pathname: '/commerce/treasury/reconciliation-inputs', body: '', nowMs: NOW }),
    ).toEqual({ ok: true });
  });

  it('the gate publisher reports a Worker refusal instead of claiming it published', async () => {
    const { fetchImpl } = capturingFetch(401);
    const publisher: GatePublisher = cupboardGatePublisher({ baseUrl: 'https://cupboard.test', secret: SECRET, treasuryReconciled: true, fetchImpl, now: () => NOW });
    const out = await publisher.publish({ workspaceId: WS, gate: { open: true, reasons: [] }, runId: 'r', atMs: NOW });
    expect(out).toMatchObject({ published: false, detail: expect.stringMatching(/401/) });
  });
});
