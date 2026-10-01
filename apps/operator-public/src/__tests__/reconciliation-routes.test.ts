/**
 * P-043 (agent-economy-flywheel-2026-08-30, D-025 §4): the two HMAC-signed
 * routes the operator's reconciliation run uses, against REAL SQLite with the
 * shipped migrations applied.
 *
 * The signing helper is the same module the operator imports, so a drift in
 * the signed input (method, path, body, timestamp) fails here as well as there.
 */
import { describe, expect, it } from 'vitest';
import {
  RECONCILIATION_INPUTS_PATH,
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_PATH,
  parseReconciliationInputs,
  signReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

// A low-entropy test key, not a credential.
const KEY = 'k'.repeat(32);
const WS = 'ws-recon';

function harness(overrides: Record<string, string | undefined> = { RECONCILIATION_GATE_SECRET: KEY }) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.RECONCILIATION_GATE_WORKSPACE = WS;
  Object.assign(env, overrides);
  return { api: buildApi(), raw, env };
}

type H = ReturnType<typeof harness>;

function gatePush(overrides: Record<string, unknown> = {}) {
  return { workspaceId: WS, open: true, reasons: [], runId: 'run-1', atMs: Date.now(), treasuryReconciled: true, ...overrides };
}

async function putGate(h: H, push: unknown, options: { key?: string; signedPath?: string; signedMethod?: string; nowMs?: number } = {}) {
  const body = JSON.stringify(push);
  const signature = await signReconciliationRequest({
    secret: options.key ?? KEY,
    method: options.signedMethod ?? 'PUT',
    pathname: options.signedPath ?? TRANSFER_GATE_PATH,
    body,
    nowMs: options.nowMs ?? Date.now(),
  });
  return h.api.request(
    TRANSFER_GATE_PATH,
    { method: 'PUT', headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature }, body },
    h.env,
  );
}

async function getInputs(h: H, options: { signedPath?: string } = {}) {
  const signature = await signReconciliationRequest({
    secret: KEY,
    method: 'GET',
    pathname: options.signedPath ?? RECONCILIATION_INPUTS_PATH,
    body: '',
    nowMs: Date.now(),
  });
  return h.api.request(RECONCILIATION_INPUTS_PATH, { headers: { [RECONCILIATION_SIGNATURE_HEADER]: signature } }, h.env);
}

function gateRow(h: H) {
  return h.raw
    .prepare(`SELECT open, treasury_reconciled, reasons_json, run_id, at_ms FROM treasury_transfer_gate WHERE workspace_id = ?`)
    .get(WS) as { open: number; treasury_reconciled: number; reasons_json: string; run_id: string; at_ms: number } | undefined;
}

function insertTransfer(h: H, row: { id: string; share: string; amount: number; createdAtMs: number; tx: string }) {
  h.raw
    .prepare(
      `INSERT INTO treasury_transfers
         (transfer_id, batch_id, channel_id, principal_id, settlement_id, receipt_hash, split_manifest_hash,
          share, role, chain_id, safe_address, roles_module_address, token, recipient, amount_micros,
          safe_tx_hash, transaction_hash, block_number, proof_event_id, created_at_ms)
       VALUES (?, 'batch-1', 'chan-1', 'gh:7', 'settle-1', ?, 'sha256:split', ?, 'settlement', 84532,
               ?, ?, ?, ?, ?, ?, ?, '300', NULL, ?)`,
    )
    .run(
      row.id,
      `receipt-${row.id}`,
      row.share,
      `0x${'6'.repeat(40)}`,
      `0x${'7'.repeat(40)}`,
      `0x${'3'.repeat(40)}`,
      `0x${'5'.repeat(40)}`,
      row.amount,
      `0x${'9'.repeat(64)}`,
      row.tx,
      row.createdAtMs,
    );
}

describe('PUT /commerce/treasury/transfer-gate', () => {
  it('records a signed push and reports what the treasury door now decides', async () => {
    const h = harness();
    const response = await putGate(h, gatePush());
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      applied: true,
      transfers: 'open',
      gate: { workspaceId: WS, open: true, treasuryReconciled: true, runId: 'run-1' },
    });
    expect(gateRow(h)).toMatchObject({ open: 1, treasury_reconciled: 1, reasons_json: '[]', run_id: 'run-1' });

    const closed = await putGate(h, gatePush({ open: false, reasons: ['credit-reserve broke'], runId: 'run-2', atMs: Date.now() + 1 }));
    expect((await closed.json()) as Record<string, unknown>).toMatchObject({ applied: true, transfers: 'paused' });
    expect(gateRow(h)).toMatchObject({ open: 0, reasons_json: '["credit-reserve broke"]', run_id: 'run-2' });
  });

  it('ignores a delayed push from an earlier run, so it cannot reopen a closed gate', async () => {
    const h = harness();
    const now = Date.now();
    await putGate(h, gatePush({ open: false, reasons: ['dao-payable broke'], runId: 'run-late', atMs: now }));
    const stale = await putGate(h, gatePush({ open: true, runId: 'run-early', atMs: now - 60_000 }));
    expect(stale.status).toBe(200);
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({ applied: false, transfers: 'paused' });
    expect(gateRow(h)).toMatchObject({ open: 0, run_id: 'run-late' });
  });

  it('refuses unsigned, mis-signed, replayed and stale requests, and fails closed without a secret', async () => {
    const h = harness();
    const missing = await h.api.request(TRANSFER_GATE_PATH, { method: 'PUT', body: JSON.stringify(gatePush()) }, h.env);
    expect(missing.status).toBe(401);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({ reason: 'missing' });

    const wrongKey = await putGate(h, gatePush(), { key: 'j'.repeat(32) });
    expect(wrongKey.status).toBe(401);
    expect((await wrongKey.json()) as Record<string, unknown>).toMatchObject({ reason: 'mismatch' });

    // A signature minted for the inputs read cannot be replayed as a gate push.
    const replayed = await putGate(h, gatePush(), { signedMethod: 'GET', signedPath: RECONCILIATION_INPUTS_PATH });
    expect(replayed.status).toBe(401);

    const old = await putGate(h, gatePush(), { nowMs: Date.now() - 10 * 60_000 });
    expect((await old.json()) as Record<string, unknown>).toMatchObject({ reason: 'stale' });
    expect(gateRow(h)).toBeUndefined();

    const unconfigured = harness({ RECONCILIATION_GATE_SECRET: undefined });
    const refused = await putGate(unconfigured, gatePush());
    expect(refused.status).toBe(503);
    expect(gateRow(unconfigured)).toBeUndefined();
  });

  it('refuses a malformed push, a contradictory open-with-reasons push, and a gate dated in the future', async () => {
    const h = harness();
    expect((await putGate(h, { workspaceId: WS })).status).toBe(400);
    expect((await putGate(h, gatePush({ open: true, reasons: ['x'] }))).status).toBe(400);
    const future = await putGate(h, gatePush({ atMs: Date.now() + 60 * 60_000 }));
    expect(future.status).toBe(400);
    expect((await future.json()) as Record<string, unknown>).toMatchObject({ detail: expect.stringContaining('future') });
    expect(gateRow(h)).toBeUndefined();
  });
});

describe('GET /commerce/treasury/reconciliation-inputs', () => {
  it('returns outstanding credits and every DAO-share transfer, oldest first, in the shape the operator parses', async () => {
    const h = harness();
    const insertBalance = h.raw.prepare(
      `INSERT INTO prepaid_credit_balances (principal_id, available_micros, reserved_micros, spent_micros, updated_at_ms)
       VALUES (?, ?, ?, ?, 1)`,
    );
    insertBalance.run('gh:7', 4_000_000, 1_000_000, 9_000_000);
    insertBalance.run('gh:8', 2_500_000, 0, 0);
    insertTransfer(h, { id: 't-2', share: 'dao', amount: 2_000, createdAtMs: 2_000, tx: `0x${'b'.repeat(64)}` });
    insertTransfer(h, { id: 't-1', share: 'dao', amount: 1_000, createdAtMs: 1_000, tx: `0x${'a'.repeat(64)}` });
    insertTransfer(h, { id: 't-r', share: 'reserve', amount: 500, createdAtMs: 1_500, tx: `0x${'c'.repeat(64)}` });

    const response = await getInputs(h);
    expect(response.status).toBe(200);
    const inputs = parseReconciliationInputs(await response.json());
    // available + reserved is still owed; spent is money already consumed.
    expect(inputs.outstandingCreditsMicros).toBe(7_500_000);
    expect(inputs.daoTransfers.map((t) => t.transferId)).toEqual(['t-1', 't-2']);
    expect(inputs.daoTransfers[0]).toMatchObject({
      chainId: 84532,
      amountMicros: 1_000,
      createdAtMs: 1_000,
      transactionHash: `0x${'a'.repeat(64)}`,
    });
  });

  it('answers zero credits and no transfers on an empty treasury', async () => {
    const inputs = parseReconciliationInputs(await (await getInputs(harness())).json());
    expect(inputs).toMatchObject({ outstandingCreditsMicros: 0, daoTransfers: [] });
  });

  it('refuses an unsigned read, a gate-push signature replayed as a read, and fails closed without a secret', async () => {
    const h = harness();
    expect((await h.api.request(RECONCILIATION_INPUTS_PATH, {}, h.env)).status).toBe(401);
    expect((await getInputs(h, { signedPath: TRANSFER_GATE_PATH })).status).toBe(401);
    expect((await getInputs(harness({ RECONCILIATION_GATE_SECRET: undefined }))).status).toBe(503);
  });
});
