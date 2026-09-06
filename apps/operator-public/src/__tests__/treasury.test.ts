/**
 * P-034 DAO treasury routing through the shipped Worker production door.
 *
 * The Safe is injected as a deterministic fake adapter; everything else is
 * production code — authentication, the operator allowlist, the real migrated
 * D1 schema (migs 026 + 027), the P-032 channel funding door, the P-033
 * claim-then-finality lifecycle, the P-018 reconciliation, the P-023 policy
 * bounds, and the P-016 commerce event log.
 *
 * A settlement is driven to FINAL through the real settlements route rather
 * than seeded as a row, because "routing requires finality" is the property
 * under test and seeding a `final` row would assert it against a fixture rather
 * than against the lifecycle that produces one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EvmSettlementFacilitator,
  EvmTransactionObservation,
} from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import type { PaymentChannelFundingAdapter } from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import {
  paymentVoucherDigest,
  unsignedVoucher,
  type CumulativePaymentVoucher,
} from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import { revenueSplitManifest } from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import { buildApi } from '../routes/index.ts';
import type { SafeTreasuryAdapter } from '../treasury-adapter.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const CHAIN_ID = 84_532;
const SIGNER = `0x${'1'.repeat(40)}`;
const AUTOMATION = `0x${'2'.repeat(40)}`;
const STABLECOIN = `0x${'3'.repeat(40)}`;
const SETTLEMENT_CONTRACT = `0x${'4'.repeat(40)}`;
const TREASURY = `0x${'5'.repeat(40)}`;
const SAFE = `0x${'6'.repeat(40)}`;
const ROLES_MODULE = `0x${'7'.repeat(40)}`;
const OWNER_A = `0x${'8'.repeat(40)}`;
const OWNER_B = `0x${'9'.repeat(40)}`;
const DEPLOY_TX = `0x${'e'.repeat(64)}`;
const TRANSFER_TX = `0x${'f'.repeat(64)}`;
const CHANNEL = 'chan-treasury-1';
const ESCROW = 1_000_000;

const SHARES = {
  creator: 6_000,
  host: 2_000,
  component: 500,
  dao: 1_000,
  reserve: 300,
  tax: 100,
  operating: 100,
} as const;
const SPLIT = revenueSplitManifest({ version: 'v1', sharesBps: SHARES });

const CLAIM_TX = `0x${'a'.repeat(64)}`;
const CLAIM_BLOCK_HASH = `0x${'b'.repeat(64)}`;

function fakeFacilitator(observation?: EvmTransactionObservation): EvmSettlementFacilitator {
  return {
    chainId: CHAIN_ID,
    settlementContract: SETTLEMENT_CONTRACT,
    stablecoin: STABLECOIN,
    signerAddress: SIGNER,
    requiredConfirmations: 1,
    submitBatchClaim: async () => ({ transactionHash: CLAIM_TX, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH }),
    submitRefund: async () => ({ transactionHash: `0x${'c'.repeat(64)}`, blockNumber: 150n, blockHash: `0x${'d'.repeat(64)}` }),
    observeTransaction: async () =>
      observation ?? { present: true, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH, headBlockNumber: 200n },
    signSettlementProof: async () => 'fake-proof-signature',
  };
}

function fakeTreasuryAdapter(options: { failTransfer?: boolean } = {}) {
  const submitTransfer = vi.fn<SafeTreasuryAdapter['submitTransfer']>(async () => {
    if (options.failTransfer) throw new Error('fake Zodiac role refusal');
    return { transactionHash: TRANSFER_TX, blockNumber: 300n };
  });
  const adapter: SafeTreasuryAdapter = {
    chainId: CHAIN_ID,
    safeAddress: SAFE,
    rolesModuleAddress: ROLES_MODULE,
    automationSigner: AUTOMATION,
    submitTransfer,
    signTreasuryProof: async () => 'fake-treasury-signature',
  };
  return { adapter, submitTransfer };
}

function fakeChannelAdapter(): PaymentChannelFundingAdapter {
  return {
    rail: 'evm-x402',
    chainId: CHAIN_ID,
    stablecoinAddress: STABLECOIN,
    settlementContractAddress: SETTLEMENT_CONTRACT,
    signerAddress: SIGNER,
    openChannel: async () => ({ transactionHash: `0x${'1'.repeat(64)}`, blockNumber: 1n }),
    closeChannel: async () => ({ transactionHash: `0x${'2'.repeat(64)}`, blockNumber: 2n }),
  };
}

function harness(
  overrides: Partial<Record<string, string>> = {},
  adapter?: SafeTreasuryAdapter,
  observation?: EvmTransactionObservation,
) {
  const { db } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.REVENUE_SPLIT_MANIFEST = JSON.stringify({ version: 'v1', sharesBps: SHARES });
  env.DAO_TREASURY_ADDRESS = TREASURY;
  env.PAYMENT_CHANNEL_STABLECOIN = STABLECOIN;
  env.TREASURY_SAFE_ADDRESS = SAFE;
  env.TREASURY_ROLES_MODULE_ADDRESS = ROLES_MODULE;
  env.TREASURY_SAFE_OWNERS = `${OWNER_A},${OWNER_B}`;
  env.TREASURY_SAFE_THRESHOLD = '2';
  env.TREASURY_SETTLEMENT_MAX_MICROS = '1000000';
  // Operator id 9 records deployments; the buyer (id 7) must not be able to.
  env.CUPBOARD_OPERATOR_GITHUB_IDS = '9';
  Object.assign(env, overrides);
  return {
    api: buildApi({
      paymentChannelAdapter: fakeChannelAdapter(),
      settlementFacilitator: fakeFacilitator(observation),
      treasuryAdapter: adapter,
    }),
    db,
    env,
  };
}

type Env2 = ReturnType<typeof harness>['env'];
type Api = ReturnType<typeof buildApi>;

function bearer(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function voucher(nonce: string, cumulative: number): CumulativePaymentVoucher {
  return {
    channelId: CHANNEL,
    payer: 'gh:7',
    seller: 'gh:9',
    releaseRef: 'release:widget@1.0.0',
    usageNonce: nonce,
    meterQuantity: 1n,
    pricePerUnitMicros: BigInt(cumulative),
    priceVersion: 'p1',
    splitManifestHash: SPLIT.manifestHash,
    expiresAtMs: 4_000_000_000_000,
    cumulativeClaimMicros: BigInt(cumulative),
    signature: `sig-${nonce}`,
  };
}

async function bindWallet(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_bindings
         (principal_id, wallet_address, chain_id, challenge_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind('gh:7', SIGNER, CHAIN_ID, 'challenge-1', 1, 1, 1)
    .run();
}

async function seedSettledReceipt(db: D1Database, nonce: string, cumulative: number): Promise<void> {
  const v = voucher(nonce, cumulative);
  await db
    .prepare(
      `INSERT INTO usage_receipts
         (channel_id, usage_nonce, principal_id, offer_id, payer, seller, release_ref,
          meter_unit, meter_quantity, unit_price_micros, price_version, split_manifest_hash,
          reserved_micros, amount_micros, cumulative_claim_micros, expires_at_ms,
          voucher_digest, voucher_signature, receipt_signature, state, reserved_at_ms, settled_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt-sig', 'settled', ?, ?)`,
    )
    .bind(
      CHANNEL,
      nonce,
      'gh:7',
      'offer-1',
      v.payer,
      v.seller,
      v.releaseRef,
      Number(v.meterQuantity),
      Number(v.pricePerUnitMicros),
      v.priceVersion,
      SPLIT.manifestHash,
      cumulative,
      cumulative,
      cumulative,
      v.expiresAtMs,
      paymentVoucherDigest(unsignedVoucher(v)),
      v.signature,
      1,
      2,
    )
    .run();
}

function deploymentBody(overrides: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN_ID,
    safeAddress: SAFE,
    rolesModuleAddress: ROLES_MODULE,
    deploymentTransactionHash: DEPLOY_TX,
    network: 'testnet',
    owners: [OWNER_A, OWNER_B],
    threshold: 2,
    automationSigner: AUTOMATION,
    deployedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** Record the testnet Safe deployment as the operator, then return to the buyer. */
async function recordDeployment(api: Api, env: Env2, overrides: Record<string, unknown> = {}): Promise<Response> {
  auth.resolveGithubBearer.mockResolvedValue({ id: 9, login: 'operator' });
  const response = await api.request('/commerce/treasury/safe-deployments', bearer(deploymentBody(overrides)), env);
  auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  return response;
}

/** Drive a settlement all the way to FINAL through the real P-033 routes. */
async function settleToFinal(api: Api, db: D1Database, env: Env2): Promise<string> {
  await bindWallet(db);
  const opened = await api.request(
    '/commerce/payment-channels',
    bearer({ channelId: CHANNEL, escrowMicros: ESCROW, fundingSource: 'bound-wallet' }),
    env,
  );
  if (opened.status !== 201) throw new Error(`channel open failed: ${opened.status} ${await opened.text()}`);
  await seedSettledReceipt(db, 'n1', 10_000);

  const claimed = await api.request(`/commerce/payment-channels/${CHANNEL}/settlements`, bearer(), env);
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status} ${await claimed.text()}`);
  const batchId = ((await claimed.json()) as { batch: { batchId: string } }).batch.batchId;

  const final = await api.request(
    `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/finality`,
    bearer(),
    env,
  );
  if (final.status !== 200) throw new Error(`finality failed: ${final.status} ${await final.text()}`);
  const verdict = (await final.json()) as { batch: { state: string } };
  if (verdict.batch.state !== 'final') throw new Error(`batch did not reach finality: ${verdict.batch.state}`);
  return batchId;
}

async function route(api: Api, env: Env2, batchId: string): Promise<Response> {
  return api.request(`/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/treasury`, bearer(), env);
}

beforeEach(() => {
  auth.resolveGithubBearer.mockReset();
  auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
});

describe('POST /commerce/treasury/safe-deployments', () => {
  it('records a testnet Safe deployment for an operator and reads it back', async () => {
    const { api, env } = harness();
    const response = await recordDeployment(api, env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { deployment: Record<string, unknown> };
    expect(body.deployment).toMatchObject({
      chainId: CHAIN_ID,
      safeAddress: SAFE,
      rolesModuleAddress: ROLES_MODULE,
      rolesVersion: 'v2',
      network: 'testnet',
      threshold: 2,
      automationSigner: AUTOMATION,
      deploymentTransactionHash: DEPLOY_TX,
      recordedBy: 'gh:9',
    });

    const listed = await api.request('/commerce/treasury/safe-deployments', { headers: { Authorization: 'Bearer test-token' } }, env);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { deployments: unknown[] }).deployments).toHaveLength(1);
  });

  it('refuses a non-operator, an automation signer that is a Safe owner, and a malformed record', async () => {
    const { api, env } = harness();

    // The buyer is authenticated but not an operator.
    const forbidden = await api.request('/commerce/treasury/safe-deployments', bearer(deploymentBody()), env);
    expect(forbidden.status).toBe(403);

    // The separation invariant, refused at RECORD time: an automation key that
    // is also an owner counts toward the owner threshold.
    const merged = await recordDeployment(api, env, { automationSigner: OWNER_A });
    expect(merged.status).toBe(400);
    expect((await merged.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('must not be a Safe owner'),
    });

    const malformed = await recordDeployment(api, env, { rolesModuleAddress: SAFE });
    expect(malformed.status).toBe(400);
  });
});

describe('POST /commerce/payment-channels/:channelId/settlements/:batchId/treasury', () => {
  it('routes the reconciled DAO share into the Safe and records an auditable receipt', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transfers: Array<Record<string, unknown>>;
      alreadyRouted: string[];
      unprovenTransfers: string[];
      network: string;
    };

    // This split allocates the full 10_000 bps, so there is no rounding
    // remainder for the DAO to absorb: 1_000 bps of 10_000 micros is exactly
    // 1_000, and that is what reaches the Safe.
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect(submitTransfer.mock.calls[0]![0]).toMatchObject({
      share: 'dao',
      token: STABLECOIN,
      recipient: TREASURY,
      amountMicros: 1_000n,
    });
    expect(body.network).toBe('testnet');
    expect(body.unprovenTransfers).toEqual([]);
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0]).toMatchObject({
      share: 'dao',
      role: 'settlement',
      amountMicros: '1000',
      transactionHash: TRANSFER_TX,
      safeAddress: SAFE,
      rolesModuleAddress: ROLES_MODULE,
    });

    // The auditable DAO treasury receipt reached the P-016 commerce event log.
    const proofEventId = body.transfers[0]!.proofEventId as string;
    const event = await db
      .prepare(`SELECT kind, payload, signature FROM commerce_event_log WHERE event_id = ?`)
      .bind(proofEventId)
      .first<{ kind: string; payload: string; signature: string }>();
    expect(event?.kind).toBe('revenue-split');
    expect(event?.signature).toBe('fake-treasury-signature');
    const payload = JSON.parse(event!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      share: 'dao',
      amountMicros: '1000',
      splitManifestHash: SPLIT.manifestHash,
      rolesVersion: 'v2',
      network: 'testnet',
      transactionHash: TRANSFER_TX,
    });

    const listed = await api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/treasury`,
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(((await listed.json()) as { transfers: unknown[] }).transfers).toHaveLength(1);
  });

  it('refuses a batch that has only been CLAIMED — a reorg can still drop it', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    // headBlockNumber == claim block, so the claim never reaches the required
    // confirmation depth and the batch stays 'claimed'.
    const { api, db, env } = harness({}, adapter, {
      present: true,
      blockNumber: 100n,
      blockHash: CLAIM_BLOCK_HASH,
      headBlockNumber: 100n,
    });
    await bindWallet(db);
    await api.request('/commerce/payment-channels', bearer({ channelId: CHANNEL, escrowMicros: ESCROW, fundingSource: 'bound-wallet' }), env);
    await seedSettledReceipt(db, 'n1', 10_000);
    const claimed = await api.request(`/commerce/payment-channels/${CHANNEL}/settlements`, bearer(), env);
    const batchId = ((await claimed.json()) as { batch: { batchId: string } }).batch.batchId;
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'batch_not_final', state: 'claimed' });
    // Nothing left the Safe.
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('refuses to route without a recorded Safe deployment', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'safe_deployment_unrecorded' });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('refuses a settlement whose recorded allocations no longer reconcile', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    // Tamper with the stored allocations, moving the DAO's share to the host
    // while keeping the total intact — the row is what sits between claim and
    // routing, and this is exactly what re-reconciliation exists to catch.
    const row = await db
      .prepare(`SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?`)
      .bind(batchId)
      .first<{ allocations_micros: string }>();
    const allocations = JSON.parse(row!.allocations_micros) as Record<string, string>;
    const moved = {
      ...allocations,
      dao: String(BigInt(allocations.dao!) - 500n),
      host: String(BigInt(allocations.host!) + 500n),
    };
    await db
      .prepare(`UPDATE settlement_batches SET allocations_micros = ? WHERE batch_id = ?`)
      .bind(JSON.stringify(moved), batchId)
      .run();

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'reconciliation_failed',
      code: 'allocation-mismatch',
    });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('is idempotent: re-routing the same settlement does not transfer twice', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const first = await route(api, env, batchId);
    expect(first.status).toBe(200);
    const second = await route(api, env, batchId);
    expect(second.status).toBe(200);

    // The receipt hash is derived from the settlement's own contents, so the
    // retry resolves to the SAME durable row rather than a second transfer.
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect((await second.json()) as { alreadyRouted: string[] }).toMatchObject({ alreadyRouted: ['dao'] });
    const { results } = await db
      .prepare(`SELECT transfer_id FROM treasury_transfers WHERE batch_id = ?`)
      .bind(batchId)
      .all<{ transfer_id: string }>();
    expect(results).toHaveLength(1);
  });

  it('gates mainnet capital on explicit owner approval', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env, { network: 'mainnet' });

    const refused = await route(api, env, batchId);
    expect(refused.status).toBe(409);
    expect((await refused.json()) as Record<string, unknown>).toMatchObject({
      error: 'routing_refused',
      code: 'mainnet-capital-not-approved',
    });
    expect(submitTransfer).not.toHaveBeenCalled();

    // The owner's approval is the ONLY thing that changes between these two.
    env.TREASURY_MAINNET_CAPITAL_APPROVED = 'true';
    const approved = await route(api, env, batchId);
    expect(approved.status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(1);
  });

  it('reports a rail refusal instead of recording a transfer that never happened', async () => {
    const { adapter } = fakeTreasuryAdapter({ failTransfer: true });
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(502);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'treasury_transfer_failed', share: 'dao' });
    const { results } = await db.prepare(`SELECT transfer_id FROM treasury_transfers`).all<{ transfer_id: string }>();
    expect(results).toHaveLength(0);
  });

  it('fails closed when the treasury policy is unconfigured, and refuses routing a payee share', async () => {
    const { adapter } = fakeTreasuryAdapter();
    const unconfigured = harness({}, adapter);
    delete (unconfigured.env as unknown as Record<string, unknown>).TREASURY_SAFE_ADDRESS;
    const batchId = await settleToFinal(unconfigured.api, unconfigured.db, unconfigured.env);
    const missing = await route(unconfigured.api, unconfigured.env, batchId);
    expect(missing.status).toBe(503);
    expect((await missing.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('TREASURY_SAFE_ADDRESS'),
    });

    // `creator` is money owed outward to a person, not DAO capital: routing it
    // into the Safe would sweep a creator's earnings into the treasury.
    const payee = harness({ TREASURY_ROUTED_SHARES: 'creator' }, adapter);
    const payeeBatch = await settleToFinal(payee.api, payee.db, payee.env);
    const refused = await route(payee.api, payee.env, payeeBatch);
    expect(refused.status).toBe(503);
    expect((await refused.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining("may not route payee share 'creator'"),
    });
  });
});
