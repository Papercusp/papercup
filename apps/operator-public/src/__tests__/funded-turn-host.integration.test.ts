import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import postgres from 'postgres';
import { Hono } from 'hono';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../../../packages/operator-core/test/_pg-helpers';
import { meteredUsageRoute } from '../routes/metered-usage';
import { makeSqliteDb } from './sqlite-d1';
import { makeEnv } from './fake-d1';
import { FundedIdentityTurnStore, fundedIdentityTurnId, type FundedIdentityTurnBinding } from '@papercusp/operator-core/lib/cupboard/funded-turn-store';
import { FundedIdentityTurnHost } from '@papercusp/operator-core/lib/cupboard/funded-turn-host';
import { identityPerUseOfferTerms } from '@papercusp/operator-core/lib/cupboard/identity-per-use-offer';
import type { IdentityTurnBilledCost } from '@papercusp/operator-core/lib/cupboard/shadow-metering-reader';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (original) => ({
  ...await original<typeof import('../auth.ts')>(),
  resolveGithubBearer: auth.resolveGithubBearer,
}));
let db: FreshPgDb, peerSql: postgres.Sql, seq = 0;
beforeAll(async () => {
  db = await createFreshPgDb('funded-turn-host');
  await applyMigrationForTest(db.sql, resolve('../../libs/papercusp/libs/db/sql/1423-cupboard-funded-turn-ledger.sql'));
  const nativeMigration = resolve('../../libs/papercusp/libs/db/sql/1424-funded-turn-native-binding.sql');
  await applyMigrationForTest(db.sql, existsSync(nativeMigration) ? nativeMigration : nativeMigration + '.DRAFT');
  peerSql = postgres(db.url, { prepare: false });
});
afterAll(async () => { await peerSql?.end({ timeout: 1 }); await db?.cleanup(); });
const offered = identityPerUseOfferTerms({ identity: { id: 'analyst', version: '1.0.0' }, markupBps: 2500 });
if (!offered.ok) throw new Error(offered.detail);
const offer = offered.terms, eventKey = 'a'.repeat(64);
const sign = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function harness() {
  const { db: d1, raw } = makeSqliteDb(), { env } = makeEnv(); env.DB = d1;
  const now = Date.now();
  const payerKey = generateKeyPairSync('ed25519');
  const payerPubkeyBase64 = payerKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  for (const id of ['c1', 'c2']) raw.prepare(`INSERT INTO payment_channels
    (channel_id,principal_id,rail,chain_id,stablecoin_address,settlement_contract_address,funding_source,funding_ref,
      wallet_address,escrow_micros,state,created_at_ms,updated_at_ms,payer_pubkey_base64)
    VALUES (?,'gh:7','evm-x402',84532,'coin','contract','bound-wallet',?,'wallet',10000,'open',?,?,?)`).run(id,id,now,now,payerPubkeyBase64);
  raw.prepare(`INSERT INTO commerce_products (product_id,sku_ref,creator_id,title) VALUES ('p1',?,'gh:9','Analyst')`).run(offer.skuRef);
  raw.prepare(`INSERT INTO commerce_offers (offer_id,product_id,pricing_model,amount_minor,currency,
    unit_price_micros,meter_unit,price_version,split_manifest_hash) VALUES ('o1','p1','per-use',0,'usd',?,?,?,?)`)
    .run(offer.unitPriceMicros,offer.meterUnit,offer.priceVersion,offer.splitManifestHash);
  const api = new Hono().route('/', meteredUsageRoute());
  // This existing endpoint is tested independently. Read actual fixture rows,
  // rather than inventing a second funded channel in the local adapter.
  api.get('/commerce/payment-channels/:id', (c) => {
    const row = raw.prepare('SELECT * FROM payment_channels WHERE channel_id=?').get(c.req.param('id'))!;
    return c.json({ channel: { channelId: row.channel_id, principalId: row.principal_id, state: row.state,
      escrowMicros: row.escrow_micros, committedMicros: row.committed_micros } });
  });
  let loseReserve = false, loseSettlement = false, unavailable = false, failReadback = false;
  let rejectSettlement = false, changedOrigin = false;
  const requests: { path: string; body: unknown }[] = [];
  const transport = (principal: number) => ({ authToken: 'test', baseUrl: 'https://cupboard.test',
    fetchImpl: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (unavailable) throw new Error('host unavailable');
      auth.resolveGithubBearer.mockResolvedValue({ id: principal });
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === 'POST' && path.endsWith('/settle') && rejectSettlement) {
        unavailable = true;
        throw new Error('settlement request lost before write');
      }
      const response = await api.request(new Request(String(url), init), undefined, env);
      if (init?.method === 'POST' && path.endsWith('/settle') && loseSettlement) {
        unavailable = failReadback;
        throw new Error('lost settlement ack');
      }
      if (init?.method === 'POST' && path.endsWith('/metered-invocations') && loseReserve) {
        unavailable = failReadback;
        throw new Error('lost reserve ack');
      }
      if (changedOrigin && new URL(String(url)).searchParams.has('identityOfferId') && response.status === 200) {
        const payload = await response.json() as { identityMarkupOrigin: { payer: string } };
        payload.identityMarkupOrigin.payer = 'gh:someone-else';
        return Response.json(payload);
      }
      return response;
    }) as typeof fetch });
  const payerTransport = transport(7), sellerTransport = transport(9);
  let cost = 999n;
  const readUsage = async (_sql: postgres.Sql, binding: { usageEventKeys: readonly string[] }): Promise<IdentityTurnBilledCost> =>
    ({ ok: true, billedInferenceMicros: cost, samples: binding.usageEventKeys.map((usageEventKey) =>
      ({ usageEventKey, sampleId: 'trusted-provider-sample', activationEventId: 'active-identity-span' })) });
  const signReceipt = vi.fn(sign), signVoucher = vi.fn((bytes: Buffer) => cryptoSign(null, bytes, payerKey.privateKey).toString('base64'));
  const host = (store = new FundedIdentityTurnStore(db.sql)) => new FundedIdentityTurnHost({ store,
    payerTransport, sellerTransport, signVoucher, signReceipt, readUsage });
  const binding: FundedIdentityTurnBinding = { workspaceId: 'host-ws-' + ++seq, ownerId: 'su-buyer', principalId: 'system:superuser',
    nativeSessionId: 'native-session', nativeTurnId: 'turn-1', specificationRevision: 'spec-1', stateRevision: 'state-1',
    payer: 'gh:7', seller: 'gh:9', offerId: 'o1', channelId: 'c1', offer, inferenceCeilingMicros: 1000n, expiresAtMs: now + 100000 };
  return { raw, requests, binding, host, signReceipt, signVoucher, loseReserve: (readbackFails = false) => { loseReserve = true; failReadback = readbackFails; },
    loseSettlement: (readbackFails = false) => { loseSettlement = true; failReadback = readbackFails; }, unavailable: () => { unavailable = true; },
    rejectSettlement: () => { rejectSettlement = true; }, changedOrigin: () => { changedOrigin = true; },
    recover: () => { unavailable = false; loseReserve = false; loseSettlement = false; rejectSettlement = false; changedOrigin = false; },
    setCost: (value: bigint) => { cost = value; } };
}

describe('trusted funded turn host with real PG CAS and migrated hosted D1', () => {
  it('composes pre-inference funding, exact native binding and hosted settlement through the awaited lifecycle', async () => {
    const h = harness(), b = { ...h.binding, admissionId: 'owner-command', nativeTurnId: null };
    const resolveClosedPopulation = vi.fn(async () => [eventKey]), recordFailure = vi.fn(async () => {});
    const lifecycle = h.host().nativeLifecycle({ resolveAdmission: async () => ({ kind: 'funded', binding: b }),
      resolveClosedPopulation, recordFailure });
    const lease = await lifecycle.admit({ workspaceId: b.workspaceId, ownerId: b.ownerId,
      nativeSessionId: b.nativeSessionId, ownerTurnId: b.admissionId });
    if (!lease.ok) throw new Error(lease.message);
    const store = new FundedIdentityTurnStore(peerSql), turnId = fundedIdentityTurnId(b);
    expect(await store.read(b.workspaceId, turnId)).toMatchObject({ state: 'running', binding: { nativeTurnId: null } });
    expect(resolveClosedPopulation).not.toHaveBeenCalled();
    expect(h.raw.prepare('SELECT state FROM usage_receipts').get()).toMatchObject({ state: 'reserved' });
    await lease.bindNativeTurn('provider-native-turn');
    const completedAtMs = Date.now();
    await lease.complete({ nativeTurnId: 'provider-native-turn', status: 'completed', completedAtMs });
    expect(resolveClosedPopulation).toHaveBeenCalledWith({ binding: { ...b, nativeTurnId: 'provider-native-turn' }, status: 'completed', completedAtMs });
    expect(await store.read(b.workspaceId, turnId)).toMatchObject({ state: 'settled',
      settlementOutbox: { receipt: { occurredAtMs: completedAtMs, amountMicros: '249' } } });
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({ committed_micros: 249 });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('refuses a funding resolver bound to another host admission before any voucher is signed', async () => {
    const h = harness(), b = { ...h.binding, admissionId: 'actual-command', nativeTurnId: null };
    const lifecycle = h.host().nativeLifecycle({ resolveAdmission: async () => ({ kind: 'funded', binding: b }),
      resolveClosedPopulation: async () => [eventKey], recordFailure: async () => {} });
    expect(await lifecycle.admit({ workspaceId: b.workspaceId, ownerId: 'another-owner',
      nativeSessionId: b.nativeSessionId, ownerTurnId: b.admissionId }))
      .toMatchObject({ ok: false, code: 'native-admission-binding-mismatch' });
    expect(h.signVoucher).not.toHaveBeenCalled();
    expect(await new FundedIdentityTurnStore(db.sql).read(b.workspaceId, fundedIdentityTurnId(b))).toBeNull();
  });

  it('retains a running hold when the complete population is unavailable and records reconciliation', async () => {
    const h = harness(), b = { ...h.binding, admissionId: 'pending-command', nativeTurnId: null };
    const recordFailure = vi.fn(async () => {});
    const lifecycle = h.host().nativeLifecycle({ resolveAdmission: async () => ({ kind: 'funded', binding: b }),
      resolveClosedPopulation: async () => { throw new Error('native population incomplete'); }, recordFailure });
    const lease = await lifecycle.admit({ workspaceId: b.workspaceId, ownerId: b.ownerId,
      nativeSessionId: b.nativeSessionId, ownerTurnId: b.admissionId });
    if (!lease.ok) throw new Error(lease.message);
    await lease.bindNativeTurn('actual-pending-turn');
    await expect(lease.complete({ nativeTurnId: 'actual-pending-turn', status: 'failed', completedAtMs: Date.now() }))
      .rejects.toThrow('native population incomplete');
    await lease.reconcile({ phase: 'completion', message: 'native population incomplete' });
    expect(recordFailure).toHaveBeenCalledWith({ turnId: fundedIdentityTurnId(b), workspaceId: b.workspaceId,
      phase: 'completion', message: 'native population incomplete' });
    expect(await new FundedIdentityTurnStore(peerSql).read(b.workspaceId, fundedIdentityTurnId(b)))
      .toMatchObject({ state: 'running', binding: { nativeTurnId: 'actual-pending-turn' } });
    expect(h.signReceipt).not.toHaveBeenCalled();
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({ committed_micros: 0 });
  });

  it('recovers a lost reserve ack, admits once and settles exact cost once', async () => {
    const h = harness(); h.loseReserve();
    const admitted = await h.host().admit(h.binding);
    expect(admitted).toMatchObject({ ok: true, turn: { state: 'running' } });
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit(h.binding)).toMatchObject({ ok: false, code: 'turn-already-entered' });
    const closedAtMs = Date.now();
    expect(await h.host().complete({ binding: h.binding, turnId: fundedIdentityTurnId(h.binding),
      usageEventKeys: [eventKey], closedAtMs })).toMatchObject({ ok: true, turn: { state: 'settled',
        settlementOutbox: { receipt: { amountMicros: '249', occurredAtMs: closedAtMs }, remainderNumerator: '7500' } } });
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1')).toMatchObject({ committed_micros: 249 });
  });
  it('never admits on an unreadable hosted authority or an insufficient channel', async () => {
    const h = harness(); h.unavailable();
    expect(await h.host().admit(h.binding)).toMatchObject({ ok: false, code: 'transport_error' });
    expect((await new FundedIdentityTurnStore(db.sql).read(h.binding.workspaceId, fundedIdentityTurnId(h.binding)))!.state).toBe('prepared');
    const poor = harness(); poor.raw.prepare('UPDATE payment_channels SET escrow_micros=1').run();
    expect(await poor.host().admit(poor.binding)).toMatchObject({ ok: false, code: 'cap-exhausted' });
    expect(poor.signVoucher).not.toHaveBeenCalled();
  });
  it('keeps an uncertain reserve prepared until hosted readback resolves it on restart', async () => {
    const h = harness(); h.loseReserve(true);
    expect(await h.host().admit(h.binding)).toMatchObject({ ok: false, code: 'transport_error' });
    const store = new FundedIdentityTurnStore(peerSql);
    expect((await store.read(h.binding.workspaceId, fundedIdentityTurnId(h.binding)))!.state).toBe('prepared');
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM usage_receipts').get()).toMatchObject({ n: 1 });
    h.recover(); expect((await h.host(store).admit(h.binding)).ok).toBe(true);
    expect(h.signVoucher).toHaveBeenCalledTimes(1);
  });
  it('revalidates a funded but unentered turn after process death', async () => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql);
    vi.spyOn(store, 'enter').mockRejectedValueOnce(new Error('process died before entry'));
    await expect(h.host(store).admit(h.binding)).rejects.toThrow('process died before entry');
    const restarted = new FundedIdentityTurnStore(peerSql);
    expect((await restarted.read(h.binding.workspaceId, fundedIdentityTurnId(h.binding)))!.state).toBe('funded');
    expect((await h.host(restarted).admit(h.binding)).ok).toBe(true);
    expect(h.signVoucher).toHaveBeenCalledTimes(1);
  });
  it('recovers uncertain funding through hosted GET only and leaves inference unentered', async () => {
    const h = harness(); h.loseReserve(true);
    expect(await h.host().admit(h.binding)).toMatchObject({ ok: false, code: 'transport_error' });
    const store = new FundedIdentityTurnStore(peerSql), turnId = fundedIdentityTurnId(h.binding);
    const count = h.requests.length;
    h.recover();
    expect(await h.host(store).reconcileFunding(h.binding.workspaceId, turnId))
      .toMatchObject({ ok: true, turn: { state: 'funded' } });
    expect(h.requests.slice(count)).toHaveLength(1);
    expect(h.requests.slice(count)[0]!.body).toBeNull();
    expect((await store.read(h.binding.workspaceId, turnId))!.state).toBe('funded');
    expect(h.signVoucher).toHaveBeenCalledTimes(1);
    expect(h.signReceipt).not.toHaveBeenCalled();
    expect((await h.host(store).admit(h.binding)).ok).toBe(true);
    expect(await h.host(store).reconcileFunding(h.binding.workspaceId, turnId))
      .toMatchObject({ ok: false, code: 'invalid-turn-state' });
  });
  it('retains an unconfirmed admission and blocks its successor after an empty funding read', async () => {
    const h = harness(), store = new FundedIdentityTurnStore(peerSql);
    const prepared = await store.prepare(h.binding);
    if (!prepared.ok) throw new Error(prepared.detail);
    expect(await h.host(store).reconcileFunding(h.binding.workspaceId, prepared.turn.turnId))
      .toMatchObject({ ok: false, code: 'funding-not-confirmed' });
    expect((await store.read(h.binding.workspaceId, prepared.turn.turnId))!.state).toBe('prepared');
    expect(await store.prepare({ ...h.binding, nativeTurnId: 'successor' }))
      .toMatchObject({ ok: false, code: 'account-turn-pending' });
    expect(h.signVoucher).not.toHaveBeenCalled();
    expect(h.signReceipt).not.toHaveBeenCalled();
  });
  it('refuses a changed hosted origin before inference entry and can reconcile the exact origin', async () => {
    const h = harness(); h.changedOrigin();
    expect(await h.host().admit(h.binding)).toMatchObject({ code: 'funding-origin-mismatch' });
    expect((await new FundedIdentityTurnStore(db.sql).read(h.binding.workspaceId, fundedIdentityTurnId(h.binding)))!.state).toBe('prepared');
    h.recover(); expect((await h.host().admit(h.binding)).ok).toBe(true);
  });
  it('elects exactly one inference entry between independent PG clients', async () => {
    const h = harness();
    const results = await Promise.all([h.host().admit(h.binding), h.host(new FundedIdentityTurnStore(peerSql)).admit(h.binding)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM usage_receipts').get()).toMatchObject({ n: 1 });
  });
  it('reconciles a committed settlement with a lost ack after process restart without re-signing', async () => {
    const h = harness(); expect((await h.host().admit(h.binding)).ok).toBe(true); h.loseSettlement(true);
    const input = { binding: h.binding, turnId: fundedIdentityTurnId(h.binding), usageEventKeys: [eventKey], closedAtMs: Date.now() };
    expect(await h.host().complete(input)).toMatchObject({ ok: false, code: 'transport_error' });
    expect((await new FundedIdentityTurnStore(peerSql).read(h.binding.workspaceId, input.turnId))!.state).toBe('settlement-pending');
    h.recover();
    expect((await h.host(new FundedIdentityTurnStore(peerSql)).reconcileCompletion(h.binding.workspaceId, input.turnId)).ok).toBe(true);
    expect(h.signReceipt).toHaveBeenCalledTimes(1);
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1')).toMatchObject({ committed_micros: 249 });
    const requestCount = h.requests.length;
    expect(await h.host().reconcileCompletion(h.binding.workspaceId, input.turnId)).toMatchObject({ ok: true, turn: { state: 'settled' } });
    expect(h.requests).toHaveLength(requestCount);
    expect(await h.host().complete({ ...input, closedAtMs: input.closedAtMs + 1 })).toMatchObject({ code: 'turn-closure-changed' });
  });
  it('resends identical persisted signed bytes and fixed time when settlement never reached the hosted ledger', async () => {
    const h = harness(); await h.host().admit(h.binding); h.rejectSettlement();
    const input = { binding: h.binding, turnId: fundedIdentityTurnId(h.binding), usageEventKeys: [eventKey], closedAtMs: Date.now() };
    expect(await h.host().complete(input)).toMatchObject({ code: 'transport_error' });
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1')).toMatchObject({ committed_micros: 0 });
    h.recover(); expect((await h.host(new FundedIdentityTurnStore(peerSql)).reconcileCompletion(h.binding.workspaceId, input.turnId)).ok).toBe(true);
    const attempts = h.requests.filter((r) => r.path.endsWith('/settle'));
    expect(attempts).toHaveLength(2); expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    expect(h.signReceipt).toHaveBeenCalledTimes(1);
  });
  it.each(['prepared', 'funded', 'running'] as const)('retains %s uncertainty without funding, signing or inference during completion recovery', async (state) => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql), turnId = fundedIdentityTurnId(h.binding);
    if (state === 'running') {
      expect((await h.host(store).admit(h.binding)).ok).toBe(true);
    } else {
      expect((await store.prepare(h.binding)).ok).toBe(true);
      if (state === 'funded') {
        h.loseReserve(true);
        expect(await h.host(store).admit(h.binding)).toMatchObject({ ok: false, code: 'transport_error' });
        h.recover();
        expect(await h.host(store).reconcileFunding(h.binding.workspaceId, turnId)).toMatchObject({ ok: true, turn: { state: 'funded' } });
      }
    }
    const requestCount = h.requests.length, signatures = h.signVoucher.mock.calls.length;
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).reconcileCompletion(h.binding.workspaceId, turnId))
      .toMatchObject({ ok: false, code: 'native-completion-unconfirmed' });
    expect(await store.read(h.binding.workspaceId, turnId)).toMatchObject({ state });
    expect(h.requests).toHaveLength(requestCount); expect(h.signVoucher).toHaveBeenCalledTimes(signatures);
    expect(h.signReceipt).not.toHaveBeenCalled();
  });

  it('recovers original closed keys/time after a bill-grade refusal, and never substitutes a caller closure', async () => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql), turnId = fundedIdentityTurnId(h.binding);
    expect((await h.host(store).admit(h.binding)).ok).toBe(true);
    const running = (await store.read(h.binding.workspaceId, turnId))!, closedAtMs = Date.now();
    expect((await store.close(h.binding.workspaceId, turnId, running.revision, [eventKey], closedAtMs)).ok).toBe(true);
    h.setCost(1001n);
    expect(await h.host().reconcileCompletion(h.binding.workspaceId, turnId)).toMatchObject({ ok: false, code: 'inference-ceiling-exceeded' });
    expect(await store.read(h.binding.workspaceId, turnId)).toMatchObject({ state: 'closed', usageEventKeys: [eventKey], closedAtMs });
    expect(h.signReceipt).not.toHaveBeenCalled();
    h.setCost(999n);
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).reconcileCompletion(h.binding.workspaceId, turnId))
      .toMatchObject({ ok: true, turn: { state: 'settled', usageEventKeys: [eventKey], closedAtMs,
        settlementOutbox: { receipt: { occurredAtMs: closedAtMs } } } });
    expect(h.signReceipt).toHaveBeenCalledTimes(1);
    expect(await h.host().reconcileCompletion(h.binding.workspaceId, 'unknown-turn')).toMatchObject({ ok: false, code: 'unknown-turn' });
  });
  it.each(['lost-ack', 'never-delivered'] as const)('drives %s completion recovery from the next native admission', async (failure) => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql), turnId = fundedIdentityTurnId(h.binding);
    expect((await h.host(store).admit(h.binding)).ok).toBe(true);
    if (failure === 'lost-ack') h.loseSettlement(true); else h.rejectSettlement();
    const closedAtMs = Date.now();
    expect(await h.host(store).complete({ binding: h.binding, turnId, usageEventKeys: [eventKey], closedAtMs }))
      .toMatchObject({ ok: false, code: 'transport_error' });
    const signed = (await store.read(h.binding.workspaceId, turnId))!.settlementOutbox!;
    h.recover();
    const next = { ...h.binding, nativeSessionId: 'resumed-native-session', nativeTurnId: 'turn-2',
      stateRevision: 'state-2', channelId: 'c2' };
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit(next)).toMatchObject({ ok: true, turn: { state: 'running' } });
    expect(await store.read(h.binding.workspaceId, turnId)).toMatchObject({ state: 'settled',
      binding: h.binding, usageEventKeys: [eventKey], closedAtMs, settlementOutbox: signed });
    expect(h.signReceipt).toHaveBeenCalledTimes(1);
    expect(h.signVoucher).toHaveBeenCalledTimes(2);
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({ committed_micros: 249 });
    const settlements = h.requests.filter((r) => r.path.endsWith('/settle'));
    expect(settlements).toHaveLength(failure === 'lost-ack' ? 1 : 2);
    if (failure === 'never-delivered') expect(settlements[1]!.body).toEqual(settlements[0]!.body);
    expect(h.requests.map((r) => r.path.endsWith('/settle')).lastIndexOf(true))
      .toBeLessThan(h.requests.map((r) => r.path.endsWith('/metered-invocations')).lastIndexOf(true));
  });
  it('retains a closed hold when billing or immutable account terms refuse the next admission', async () => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql), turnId = fundedIdentityTurnId(h.binding);
    await h.host(store).admit(h.binding);
    const running = (await store.read(h.binding.workspaceId, turnId))!, closedAtMs = Date.now();
    await store.close(h.binding.workspaceId, turnId, running.revision, [eventKey], closedAtMs);
    const next = { ...h.binding, nativeTurnId: 'turn-2' }, requestCount = h.requests.length;
    const changed = identityPerUseOfferTerms({ identity: { id: 'analyst', version: '1.0.0' }, markupBps: 5000 });
    if (!changed.ok) throw new Error(changed.detail);
    for (const change of [{ seller: 'gh:other' }, { offer: changed.terms }]) {
      expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit({ ...next, ...change }))
        .toMatchObject({ ok: false, code: 'offer-binding-changed' });
    }
    expect(await h.host().admit({ ...next, offer: { ...h.binding.offer, priceVersion: 'changed' } }))
      .toMatchObject({ ok: false, code: 'identity-offer-mismatch' });
    h.setCost(1001n);
    expect(await h.host().admit(next)).toMatchObject({ ok: false, code: 'inference-ceiling-exceeded' });
    expect(h.requests).toHaveLength(requestCount);
    expect(h.signReceipt).not.toHaveBeenCalled(); expect(h.signVoucher).toHaveBeenCalledTimes(1);
    expect(await store.read(h.binding.workspaceId, turnId)).toMatchObject({ state: 'closed', usageEventKeys: [eventKey], closedAtMs });
    expect(await store.read(h.binding.workspaceId, fundedIdentityTurnId(next))).toBeNull();
  });
  it.each(['prepared', 'funded'] as const)('retains an unentered %s hold when a different admission arrives', async (state) => {
    const h = harness(), store = new FundedIdentityTurnStore(db.sql), turnId = fundedIdentityTurnId(h.binding);
    h.loseReserve(true); await h.host(store).admit(h.binding); h.recover();
    if (state === 'funded') expect((await h.host(store).reconcileFunding(h.binding.workspaceId, turnId)).ok).toBe(true);
    const requestCount = h.requests.length;
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit({ ...h.binding, nativeTurnId: 'different-turn' }))
      .toMatchObject({ ok: false, code: 'account-turn-pending' });
    expect(h.requests).toHaveLength(requestCount); expect(h.signVoucher).toHaveBeenCalledTimes(1);
    expect(h.signReceipt).not.toHaveBeenCalled(); expect(await store.read(h.binding.workspaceId, turnId)).toMatchObject({ state });
  });
  it('keeps unknown native execution held and refuses the same completed admission without re-entry', async () => {
    const h = harness(), turnId = fundedIdentityTurnId(h.binding);
    await h.host().admit(h.binding);
    const next = { ...h.binding, nativeTurnId: 'turn-2' }, requestCount = h.requests.length;
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit(next)).toMatchObject({ ok: false, code: 'account-turn-pending' });
    expect(h.requests).toHaveLength(requestCount); expect(h.signReceipt).not.toHaveBeenCalled();
    h.loseSettlement(true);
    await h.host().complete({ binding: h.binding, turnId, usageEventKeys: [eventKey], closedAtMs: Date.now() });
    h.recover();
    expect(await h.host(new FundedIdentityTurnStore(peerSql)).admit(h.binding))
      .toMatchObject({ ok: false, code: 'turn-already-entered' });
    expect(h.signVoucher).toHaveBeenCalledTimes(1); expect(h.signReceipt).toHaveBeenCalledTimes(1);
    expect(await new FundedIdentityTurnStore(peerSql).read(h.binding.workspaceId, turnId)).toMatchObject({ state: 'settled' });
  });
  it('seeds the global hosted remainder after a channel AND workspace change', async () => {
    const h = harness(); await h.host().admit(h.binding);
    await h.host().complete({ binding: h.binding, turnId: fundedIdentityTurnId(h.binding), usageEventKeys: [eventKey], closedAtMs: Date.now() });
    const next = { ...h.binding, workspaceId: h.binding.workspaceId + '-new', channelId: 'c2', nativeTurnId: 'turn-2' };
    h.setCost(1n); expect((await h.host(new FundedIdentityTurnStore(peerSql)).admit(next)).ok).toBe(true);
    expect(await h.host().complete({ binding: next, turnId: fundedIdentityTurnId(next), usageEventKeys: [eventKey], closedAtMs: Date.now() }))
      .toMatchObject({ ok: true, turn: { settlementOutbox: { priorRemainderNumerator: '7500', remainderNumerator: '0', receipt: { amountMicros: '1' } } } });
    expect(h.raw.prepare('SELECT SUM(committed_micros) AS n FROM payment_channels').get()).toMatchObject({ n: 250 });
  });
  it('refuses a changed payer or worn revision at completion before signing', async () => {
    const h = harness(); await h.host().admit(h.binding);
    for (const change of [{ payer: 'gh:8' }, { stateRevision: 'changed' }]) {
      expect(await h.host().complete({ binding: { ...h.binding, ...change }, turnId: fundedIdentityTurnId(h.binding),
        usageEventKeys: [eventKey], closedAtMs: Date.now() })).toMatchObject({ code: 'turn-binding-changed' });
    }
    expect(h.signReceipt).not.toHaveBeenCalled();
  });
});
