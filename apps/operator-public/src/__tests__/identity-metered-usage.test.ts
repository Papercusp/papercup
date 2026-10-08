import { paymentTestKey, signPaymentTestBytes, signPaymentTestVoucher } from '@papercusp/operator-core/lib/p2p/_payment-voucher-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { identityPerUseOfferTerms } from '@papercusp/operator-core/lib/cupboard/identity-per-use-offer';
import { paymentVoucherDigest, paymentVoucherSigningBytes, unsignedVoucher, type CumulativePaymentVoucher } from '@papercusp/operator-core/lib/p2p/microcharge';
import { meteredUsageRoute } from '../routes/metered-usage';
import { getUsageReceipt, reserveUsageReceipt, settleUsageReceipt, readIdentityMarkupRemainder,
  type ReserveUsageReceiptInput } from '../usage-receipt-store';
import { makeEnv } from './fake-d1';
import { makeSqliteDb } from './sqlite-d1';
import { reserveMeteredUnit, settleMeteredUnit, readChannelUsage } from '@papercusp/operator-core/lib/cupboard/metered-invocation-door-io';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (original) => ({ ...await original<typeof import('../auth.ts')>(),
  resolveGithubBearer: auth.resolveGithubBearer }));
const derived = identityPerUseOfferTerms({ identity: { id: 'analyst', version: '1.0.0' }, markupBps: 2500 });
if (!derived.ok) throw new Error(derived.detail);
const offer = derived.terms;
const at = Date.now() - 10000;
const payerKey = generateKeyPairSync('ed25519');
const payerPubkeyBase64 = payerKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const signVoucher = (bytes: Buffer): string => sign(null, bytes, payerKey.privateKey).toString('base64');

function harness(withPayerKey = true) {
  const { db, raw } = makeSqliteDb();
  for (const id of ['c1', 'c2']) raw.prepare(`INSERT INTO payment_channels
    (channel_id,principal_id,rail,chain_id,stablecoin_address,settlement_contract_address,funding_source,funding_ref,
      wallet_address,escrow_micros,state,created_at_ms,updated_at_ms,payer_pubkey_base64)
    VALUES (?,'gh:7','evm-x402',84532,'coin','contract','bound-wallet',?,'wallet',10000,'open',?,?,?)`).run(id,id,at,at,withPayerKey ? payerPubkeyBase64 : null);
  raw.prepare(`INSERT INTO commerce_products (product_id,sku_ref,creator_id,title) VALUES ('p1',?,'gh:9','Analyst')`).run(offer.skuRef);
  raw.prepare(`INSERT INTO commerce_offers (offer_id,product_id,pricing_model,amount_minor,currency,
    unit_price_micros,meter_unit,price_version,split_manifest_hash) VALUES ('o1','p1','per-use',0,'usd',?,?,?,?)`)
    .run(offer.unitPriceMicros,offer.meterUnit,offer.priceVersion,offer.splitManifestHash);
  const { env } = makeEnv(); env.DB = db;
  return { db, raw, env, api: meteredUsageRoute() };
}
function reservation(nonce = 'n1', overrides: Partial<ReserveUsageReceiptInput> = {}): ReserveUsageReceiptInput {
  const v: CumulativePaymentVoucher = signPaymentTestVoucher({ channelId: 'c1', usageNonce: nonce, payer: 'gh:7', seller: 'gh:9',
    releaseRef: offer.skuRef, meterQuantity: 1n, pricePerUnitMicros: 250n,
    priceVersion: offer.priceVersion, splitManifestHash: offer.splitManifestHash,
    cumulativeClaimMicros: 250n, expiresAtMs: at + 1000000, signature: '' });
  const voucherSignature = signVoucher(paymentVoucherSigningBytes(unsignedVoucher(v)));
  return { channelId: 'c1', usageNonce: nonce, principalId: 'gh:7', offerId: 'o1', payer: v.payer,
    seller: v.seller, releaseRef: v.releaseRef, meterUnit: offer.meterUnit, meterQuantity: 1n, unitPriceMicros: 250n,
    priceVersion: v.priceVersion, splitManifestHash: v.splitManifestHash, reservedMicros: 250n,
    cumulativeClaimMicros: 250n, expiresAtMs: v.expiresAtMs, voucherDigest: paymentVoucherDigest(unsignedVoucher(v)),
    voucherSignature, nowMs: at, identityInferenceCeilingMicros: 1000n, ...overrides };
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { Authorization: 'Bearer test',
  'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function closure(body: Record<string, unknown> = {}) {
  return { channelId: 'c1', receiptSignature: 'seller-signature', occurredAtMs: at + 500,
    billedInferenceMicros: '999', priorRemainderNumerator: '0', ...body };
}

describe('exact identity settlement through the hosted production handler and real migrated D1', () => {
  beforeEach(() => { auth.resolveGithubBearer.mockReset(); auth.resolveGithubBearer.mockResolvedValue({ id: 9 }); });
  it('reads immutable receipt costs through the authenticated channel route for both parties, without writes', async () => {
    const h = harness(); await reserveUsageReceipt(h.db, reservation());
    expect((await h.api.request('/commerce/metered-invocations/n1/settle', post(closure()), h.env)).status).toBe(200);
    await reserveUsageReceipt(h.db, reservation('pending', { cumulativeClaimMicros: 500n }));
    // A current offer mutation cannot rewrite the history the parties signed.
    h.raw.prepare("UPDATE commerce_offers SET active=0,price_version='new-terms' WHERE offer_id='o1'").run();
    const read = async (id: number) => {
      auth.resolveGithubBearer.mockResolvedValue({ id });
      const response = await h.api.request('/commerce/payment-channels/c1/usage', { headers: { Authorization: 'Bearer test' } }, h.env);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const buyer = await read(7), seller = await read(9);
    expect(buyer.status).toBe(200); expect(seller.status).toBe(200);
    expect(buyer.body.identityStatement).toEqual(seller.body.identityStatement);
    expect(buyer.body.identityStatement).toMatchObject({ basis: 'hosted-settled-usage', markupMicros: '249', reservedReceipts: 1,
      complete: true, chainFinality: 'not-measured', costPerAcceptedOutcomeMicros: null,
      lines: [{ offerId: 'o1', billedInferenceMicros: '999', markupMicros: '249',
        allocationQuote: { creatorMicros: '224', daoMicros: '25', componentMicros: '0' } }] });
    expect((await read(11)).status).toBe(403);
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({ committed_micros: 249 });
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM usage_receipts').get()).toMatchObject({ n: 2 });
  });

  it('excludes another seller on the same channel from a seller statement', async () => {
    const h = harness(); expect(await reserveUsageReceipt(h.db, reservation())).toMatchObject({ ok: true });
    expect((await h.api.request('/commerce/metered-invocations/n1/settle', post(closure()), h.env)).status).toBe(200);
    // Each seller has its own offer. Migration045 rejects substituting the
    // seller on an already-used payer/offer binding before it writes a row.
    expect(await reserveUsageReceipt(h.db, reservation('foreign', { seller: 'gh:10', offerId: 'o2', cumulativeClaimMicros: 500n })))
      .toMatchObject({ ok: true });
    const settled = await settleUsageReceipt(h.db, { channelId: 'c1', usageNonce: 'foreign', amountMicros: 249n, meterQuantity: 1n,
      receiptSignature: 'other-seller', nowMs: at + 600,
      identityInference: { billedInferenceMicros: 999n, priorRemainderNumerator: 0n, remainderNumerator: 7500n } });
    expect(settled).toMatchObject({ ok: true });
    const response = await h.api.request('/commerce/payment-channels/c1/usage', { headers: { Authorization: 'Bearer test' } }, h.env);
    const body = await response.json() as { receipts: unknown[]; identityStatement: { lines: unknown[]; reservedReceipts: number } };
    expect(response.status).toBe(200); expect(body.receipts).toHaveLength(1);
    expect(body.identityStatement.lines).toHaveLength(1); expect(body.identityStatement.reservedReceipts).toBe(0);
  });
  it.each([false, true])('refuses forged signatures or legacy unbound channels before durable reservation (bound=%s)', async (bound) => {
    const h = harness(bound); auth.resolveGithubBearer.mockResolvedValue({ id: 7 }); const r = reservation();
    const voucher = { channelId: r.channelId, payer: r.payer, seller: r.seller, releaseRef: r.releaseRef,
      usageNonce: r.usageNonce, meterQuantity: '1', pricePerUnitMicros: '250', priceVersion: r.priceVersion,
      splitManifestHash: r.splitManifestHash, cumulativeClaimMicros: '250', expiresAtMs: r.expiresAtMs,
      signature: bound ? 'forged' : r.voucherSignature };
    const response = await h.api.request('/commerce/metered-invocations', post({ channelId: 'c1', offerId: 'o1', voucher,
      identityInferenceCeilingMicros: '999', payerPubkeyBase64, verifySignature: true }), h.env);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'invalid-voucher' });
    expect(await getUsageReceipt(h.db, 'c1', 'n1')).toBeNull();
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id = ?').get('c1'))
      .toMatchObject({ committed_micros: 0 });
  });

  it('admits a stored ceiling through the funder door and refuses an unpriced ceiling', async () => {
    const h = harness(); auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    const r = reservation();
    const voucher = { channelId: r.channelId, payer: r.payer, seller: r.seller, releaseRef: r.releaseRef,
      usageNonce: r.usageNonce, meterQuantity: '1', pricePerUnitMicros: '250', priceVersion: r.priceVersion,
      splitManifestHash: r.splitManifestHash, cumulativeClaimMicros: '250', expiresAtMs: r.expiresAtMs, signature: r.voucherSignature };
    expect((await h.api.request('/commerce/metered-invocations', post({ channelId:'c1',offerId:'o1',voucher }),h.env)).status).toBe(422);
    const response = await h.api.request('/commerce/metered-invocations', post({ channelId:'c1',offerId:'o1',voucher,
      identityInferenceCeilingMicros:'999' }),h.env);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ receipt: { identityInference: { ceilingMicros:'999' } } });
  });
  it('acknowledges the exact amount and signed time, and replays without charging twice', async () => {
    const h = harness(); expect((await reserveUsageReceipt(h.db,reservation())).ok).toBe(true);
    for (let i=0;i<2;i++) {
      const response = await h.api.request('/commerce/metered-invocations/n1/settle',post(closure()),h.env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ receipt: { amountMicros:'249',meterQuantity:'1',settledAtMs:at+500,
        identityInference:{billedInferenceMicros:'999',priorRemainderNumerator:'0',remainderNumerator:'7500'} } });
    }
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({committed_micros:249});
    const changed = await h.api.request('/commerce/metered-invocations/n1/settle',post(closure({receiptSignature:'changed'})),h.env);
    expect(changed.status).toBe(409);
  });
  it('retains remainder across channel switches, using insertion order rather than signed timestamps', async () => {
    const h=harness(); await reserveUsageReceipt(h.db,reservation());
    expect((await h.api.request('/commerce/metered-invocations/n1/settle',post(closure()),h.env)).status).toBe(200);
    expect((await reserveUsageReceipt(h.db,reservation('n2',{channelId:'c2',nowMs:at+1}))).ok).toBe(true);
    const response=await h.api.request('/commerce/metered-invocations/n2/settle',post(closure({channelId:'c2',occurredAtMs:at+400,
      billedInferenceMicros:'1',priorRemainderNumerator:'7500'})),h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({receipt:{amountMicros:'1',identityInference:{remainderNumerator:'0'}}});
    expect(await readIdentityMarkupRemainder(h.db,'gh:7','o1')).toBe(0n);
  });
  it('reads the authenticated global remainder on a new channel before local admission', async () => {
    const h = harness(); await reserveUsageReceipt(h.db, reservation());
    await h.api.request('/commerce/metered-invocations/n1/settle', post(closure()), h.env);
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    const deps = { authToken: 'test', baseUrl: 'https://cupboard.test', fetchImpl: (async (url, init) =>
      h.api.request(new Request(String(url), init), undefined, h.env)) as typeof fetch };
    expect(await readChannelUsage('c2', deps, 'o1')).toMatchObject({ ok: true, usage: { receipts: [],
      identityMarkupOrigin: { payer: 'gh:7', seller: 'gh:9', offerId: 'o1', offer, remainderNumerator: '7500' } } });
    auth.resolveGithubBearer.mockResolvedValue({ id: 8 });
    expect(await readChannelUsage('c2', deps, 'o1')).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('refuses a legacy identity history instead of presenting a reset remainder', async () => {
    const h = harness(); await reserveUsageReceipt(h.db, reservation());
    h.raw.prepare('UPDATE usage_receipts SET identity_ceiling_micros=NULL WHERE usage_nonce=?').run('n1');
    auth.resolveGithubBearer.mockResolvedValue({ id: 7 });
    const response = await h.api.request('/commerce/payment-channels/c2/usage?identityOfferId=o1',
      { headers: { Authorization: 'Bearer test' } }, h.env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'identity-history-unverifiable' });
  });
  it.each([{billedInferenceMicros:'0',amount:'0',remainder:'0'}, {billedInferenceMicros:'1',amount:'0',remainder:'2500'}])
    ('settles $billedInferenceMicros billed micros without a minimum charge',async ({billedInferenceMicros,amount,remainder})=>{
      const h=harness(); await reserveUsageReceipt(h.db,reservation());
      const response=await h.api.request('/commerce/metered-invocations/n1/settle',post(closure({billedInferenceMicros})),h.env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({receipt:{amountMicros:amount,identityInference:{remainderNumerator:remainder}}});
    });
  it.each([{priorRemainderNumerator:'1'},{billedInferenceMicros:'1001'},{occurredAtMs:undefined},{actualQuantity:'1'},
    {billedInferenceMicros:'estimated'},{occurredAtMs:at-1}])('refuses malformed or unbound settlement %j',async (change)=>{
      const h=harness(); await reserveUsageReceipt(h.db,reservation());
      const response=await h.api.request('/commerce/metered-invocations/n1/settle',post(closure(change)),h.env);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await getUsageReceipt(h.db,'c1','n1'))!.state).toBe('reserved');
      expect(await readIdentityMarkupRemainder(h.db,'gh:7','o1')).toBe(0n);
    });
  it('refuses a buyer settlement', async()=>{
    const h=harness(); await reserveUsageReceipt(h.db,reservation()); auth.resolveGithubBearer.mockResolvedValue({id:7});
    expect((await h.api.request('/commerce/metered-invocations/n1/settle',post(closure()),h.env)).status).toBe(403);
  });
  it('uses the actual client transport to reserve and settle the exact signed bill through hosted authority',async()=>{
    const h=harness();
    const deps={authToken:'test',baseUrl:'https://cupboard.test',fetchImpl:(async (url,init)=>
      h.api.request(new Request(String(url),init),undefined,h.env)) as typeof fetch};
    auth.resolveGithubBearer.mockResolvedValue({id:7});
    const funded=await reserveMeteredUnit({channelId:'c1',offerId:'o1',terms:offer,payer:'gh:7',seller:'gh:9',
      releaseRef:offer.skuRef,usageNonce:'native',quantity:1n,expiresAtMs:at+1000000,
      identityInferenceCeilingMicros:999n,signVoucher},deps);
    expect(funded.ok).toBe(true);
    auth.resolveGithubBearer.mockResolvedValue({id:9});
    const occurredAtMs=Date.now(); let signed: Record<string,unknown>={};
    const result=await settleMeteredUnit({channelId:'c1',usageNonce:'native',occurredAtMs,
      identityInference:{billedInferenceMicros:999n,priorRemainderNumerator:0n},
      signReceipt:(bytes)=>{signed=JSON.parse(bytes.toString());return 'fixed-outbox-signature';}},deps);
    expect(result).toMatchObject({ok:true,amountMicros:249n,receipt:{settledAtMs:occurredAtMs,
      receiptSignature:'fixed-outbox-signature',identityInference:{ceilingMicros:'999',remainderNumerator:'7500'}}});
    expect(signed).toMatchObject({amountMicros:'249',occurredAtMs});
  });
  it('serializes one payer/offer admission across channels and refuses changed immutable terms',async()=>{
    const h=harness(); await reserveUsageReceipt(h.db,reservation());
    expect(await reserveUsageReceipt(h.db,reservation('n2',{channelId:'c2'}))).toMatchObject({ok:false,code:'identity-account-pending'});
    const other=identityPerUseOfferTerms({identity:{id:'analyst',version:'1.0.0'},markupBps:2000});
    if(!other.ok)throw new Error(other.detail);
    expect(await reserveUsageReceipt(h.db,reservation('n3',{channelId:'c2',unitPriceMicros:200n,reservedMicros:200n,
      cumulativeClaimMicros:200n,priceVersion:other.terms.priceVersion,splitManifestHash:other.terms.splitManifestHash})))
      .toMatchObject({ok:false,code:'identity-account-mismatch'});
  });
  it('refuses unrepresentable ledger amounts before any rounding reaches SQLite',async()=>{
    const h=harness();
    expect(await reserveUsageReceipt(h.db,reservation('large',{cumulativeClaimMicros:9007199254740993n})))
      .toMatchObject({ok:false,code:'invalid-ledger-range'});
    expect(await getUsageReceipt(h.db,'c1','large')).toBeNull();
  });
  it('guards durable admission when preflight races channel refunds or another reservation',async()=>{
    const h=harness(); h.raw.prepare('UPDATE payment_channels SET escrow_micros=300,refunded_micros=100 WHERE channel_id=?').run('c1');
    expect(await reserveUsageReceipt(h.db,reservation())).toMatchObject({ok:false,code:'cap-exhausted'});
  });
  it('rolls back the monetary increment if identity settlement cannot persist',async()=>{
    const h=harness(); await reserveUsageReceipt(h.db,reservation());
    h.raw.exec("CREATE TRIGGER refuse_test_settlement BEFORE UPDATE OF state ON usage_receipts BEGIN SELECT RAISE(ABORT, 'test-persistence-fault'); END");
    await expect(settleUsageReceipt(h.db,{channelId:'c1',usageNonce:'n1',amountMicros:249n,meterQuantity:1n,
      receiptSignature:'s',nowMs:at+500,identityInference:{billedInferenceMicros:999n,priorRemainderNumerator:0n,remainderNumerator:7500n}}))
      .rejects.toThrow('test-persistence-fault');
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1')).toMatchObject({committed_micros:0});
    expect((await getUsageReceipt(h.db,'c1','n1'))!.state).toBe('reserved');
  });
  it.each([false,true])('same stale-read race distinguishes the guard from an unconditional update (mutant=%s)',async(mutant)=>{
    const h=harness(); await reserveUsageReceipt(h.db,reservation('ordinary',{releaseRef:'plugin:widget',offerId:'o2',
      meterUnit:'call',identityInferenceCeilingMicros:undefined}));
    const snapshot=await getUsageReceipt(h.db,'c1','ordinary');
    let arrived=0; let release!:()=>void; const barrier=new Promise<void>(r=>{release=r;});
    const db=new Proxy(h.db,{get(target,key){
      if(key!=='prepare')return Reflect.get(target,key);
      return (sql:string)=>{
        // Negative control: remove ONLY the monetary state predicate. If the
        // read barrier failed to produce the race, this would still charge once.
        if(mutant && sql.startsWith('UPDATE payment_channels SET committed_micros')) {
          const unguarded=target.prepare('UPDATE payment_channels SET committed_micros=committed_micros+?,updated_at_ms=? WHERE channel_id=?');
          return new Proxy(unguarded,{get(s,k){return k==='bind' ? (...args:unknown[])=>s.bind(...args.slice(0,3)) : Reflect.get(s,k);}});
        }
        const statement=target.prepare(sql);
        if(!sql.startsWith('SELECT channel_id'))return statement;
        return new Proxy(statement,{get(s,k){if(k!=='bind')return Reflect.get(s,k);
          return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,bk){
            if(bk!=='first')return Reflect.get(b,bk); return async()=>{
              if(arrived>=2)return b.first(); const row=await b.first(); if(++arrived===2)release(); await barrier; return row;
            };}});};}});
      };
    }});
    expect(snapshot!.state).toBe('reserved');
    const input={channelId:'c1',usageNonce:'ordinary',amountMicros:200n,meterQuantity:1n,receiptSignature:'same',nowMs:at+500};
    const results=await Promise.all([settleUsageReceipt(db,input),settleUsageReceipt(db,input)]);
    expect(results.every(r=>r.ok)).toBe(true);
    expect(h.raw.prepare('SELECT committed_micros FROM payment_channels WHERE channel_id=?').get('c1'))
      .toMatchObject({committed_micros:mutant ? 400 : 200});
  });
});
