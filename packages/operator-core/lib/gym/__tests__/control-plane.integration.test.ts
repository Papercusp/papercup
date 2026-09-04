/**
 * Live-PG tests for the gym control plane (gym-ui-handoff backend, D-019). Provisions
 * a throwaway DB with the FULL live baseline (so harness_shared.harness_prompt_overrides
 * + the 110 gym_proposals/gym_autoloop_config tables exist), then round-trips the
 * helpers the gym:* endpoints wrap: prompts CRUD, proposal record → list → accept/reject
 * (accept promotes into harness_prompt_overrides), and autoloop config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../gym-db-init';
import {
  getPrompts,
  setPrompt,
  recordProposal,
  listProposals,
  decideProposal,
  getAutoloop,
  setAutoloop,
  makeLoopProposalRecorder,
} from '../control-plane';
import { createCandidateVersionVerdict } from '../loop';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `gymcp_${randomBytes(5).toString('hex')}`;
const WS = 'ws-test';

beforeAll(async () => {
  // This fixture provisions the GYM database only — decideProposal's best-effort
  // behavior-change-ledger hook (FB-02) would warn against it (no migration 242
  // table here). The hook's own coverage is change-ledger.integration.test.ts;
  // here the flag turns it into a no-op.
  process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER = '0';
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  delete process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER;
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try { await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } catch { /* best-effort */ } finally { await maint.end({ timeout: 5 }); }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('gym control plane — prompts', () => {
  it('round-trips the judge rubric + role prompts, split correctly', async () => {
    await setPrompt(sql, { workspaceId: WS, harnessSlug: 'alpha', role: 'judge', md: '# rubric v1' });
    await setPrompt(sql, { workspaceId: WS, harnessSlug: 'alpha', role: 'worker', md: 'worker prompt' });
    const p = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'alpha' });
    expect(p.judgeRubric).toBe('# rubric v1');
    expect(p.roles.worker).toBe('worker prompt');
    expect('judge' in p.roles).toBe(false); // judge is surfaced separately, not in roles
  });

  it('upserts an existing prompt in place', async () => {
    await setPrompt(sql, { workspaceId: WS, harnessSlug: 'alpha', role: 'worker', md: 'worker v2' });
    const p = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'alpha' });
    expect(p.roles.worker).toBe('worker v2');
  });

  it('rejects an unknown prompt key', async () => {
    await expect(
      setPrompt(sql, { workspaceId: WS, harnessSlug: 'alpha', role: 'not-a-role', md: 'x' }),
    ).rejects.toThrow(/role|key/i);
  });
});

describe('gym control plane — proposals', () => {
  it('records a proposal, lists it pending, accepts it → promotes the prompt', async () => {
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: 'beta', cycle: 1, variantId: 'v-1', role: 'validator',
      originalMd: 'old validator', proposedMd: 'new validator', rationale: 'tighter checks',
      devAnchorDelta: 0.12, costDelta: -0.01, probeStatus: 'pass',
    });
    const pending = await listProposals(sql, { workspaceId: WS, harnessSlug: 'beta', status: 'pending' });
    expect(pending.map((r) => r.id)).toContain(id);
    const row = pending.find((r) => r.id === id)!;
    expect(row.proposedMd).toBe('new validator');
    expect(row.devAnchorDelta).toBeCloseTo(0.12, 5);
    expect(typeof row.createdAt).toBe('number'); // bigint mapped to number

    const res = await decideProposal(sql, { id, workspaceId: WS, harnessSlug: 'beta', decision: 'accepted' });
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    // promoted → the validator override now holds the proposed prompt
    const prompts = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'beta' });
    expect(prompts.roles.validator).toBe('new validator');
    // no longer pending
    const stillPending = await listProposals(sql, { workspaceId: WS, harnessSlug: 'beta', status: 'pending' });
    expect(stillPending.map((r) => r.id)).not.toContain(id);
  });

  it('decides correctly when called INSIDE an outer transaction (route path: tx has no .begin)', async () => {
    // Regression: the gym:accept route runs decideProposal via routeWithWorkspace, which
    // passes a TransactionSql (no `.begin`). decideProposal must NOT try to open a nested
    // transaction there — it should run directly in the outer tx. (Caught by live e2e.)
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: 'tx', cycle: 1, variantId: 'v-tx', role: 'reviewer', proposedMd: 'tx reviewer',
    });
    const res = await sql.begin((tx) => decideProposal(tx as unknown as typeof sql, { id, workspaceId: WS, harnessSlug: 'tx', decision: 'accepted' }));
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);
    const prompts = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'tx' });
    expect(prompts.roles.reviewer).toBe('tx reviewer');
  });

  it('rejects a proposal without promoting', async () => {
    const id = await recordProposal(sql, {
      workspaceId: WS, harnessSlug: 'beta', cycle: 2, variantId: 'v-2', role: 'worker', proposedMd: 'risky worker',
    });
    const res = await decideProposal(sql, { id, workspaceId: WS, harnessSlug: 'beta', decision: 'rejected' });
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(false);
    const prompts = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'beta' });
    expect(prompts.roles.worker).not.toBe('risky worker'); // never promoted
  });

  it('deciding a non-existent / already-decided proposal returns ok:false', async () => {
    const missing = await decideProposal(sql, { id: 'nope', workspaceId: WS, harnessSlug: 'beta', decision: 'accepted' });
    expect(missing.ok).toBe(false);
  });

  it('re-recording a pending proposal (same variant+role) is idempotent', async () => {
    const a = await recordProposal(sql, { workspaceId: WS, harnessSlug: 'gamma', cycle: 1, variantId: 'v-x', role: 'worker', proposedMd: 'p1' });
    const b = await recordProposal(sql, { workspaceId: WS, harnessSlug: 'gamma', cycle: 1, variantId: 'v-x', role: 'worker', proposedMd: 'p2' });
    expect(a).toBe(b);
    const pending = await listProposals(sql, { workspaceId: WS, harnessSlug: 'gamma', status: 'pending' });
    const mine = pending.filter((r) => r.id === a);
    expect(mine).toHaveLength(1);
    expect(mine[0].proposedMd).toBe('p2'); // content updated in place
  });
});

describe('gym control plane — autoloop', () => {
  it('is null before configured, then round-trips, and partial updates preserve fields', async () => {
    expect(await getAutoloop(sql, { workspaceId: WS, harnessSlug: 'delta' })).toBeNull();
    await setAutoloop(sql, { workspaceId: WS, harnessSlug: 'delta', enabled: true, budgetUsd: 25 });
    let cfg = await getAutoloop(sql, { workspaceId: WS, harnessSlug: 'delta' });
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.budgetUsd).toBe(25);
    // partial update: only status — enabled + budget preserved
    await setAutoloop(sql, { workspaceId: WS, harnessSlug: 'delta', status: 'running' });
    cfg = await getAutoloop(sql, { workspaceId: WS, harnessSlug: 'delta' });
    expect(cfg!.status).toBe('running');
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.budgetUsd).toBe(25);
  });
});

describe('gym control plane — loop recorder bridge', () => {
  it('records only the candidate\'s CHANGED roles as pending + bumps autoloop lastCycle', async () => {
    const recorder = makeLoopProposalRecorder(sql, { workspaceId: WS, harnessSlug: 'rec' });
    await recorder({
      cycle: 4,
      candidateId: 'cand-rec-1',
      parentId: 'p',
      parentOverlay: { promptOverrides: { worker: 'old worker', validator: 'same val' } },
      overlay: { promptOverrides: { worker: 'new worker', validator: 'same val', reviewer: 'added' } },
      rationale: 'why',
      devAnchorDelta: 0.2,
      costDelta: 0.0,
      probeStatus: 'pass',
      verdict: 'accept',
      candidateVersion: createCandidateVersionVerdict({
        candidateId: 'cand-rec-1',
        parentId: 'p',
        variant: { promptOverrides: { worker: 'new worker', validator: 'same val', reviewer: 'added' } },
        parent: { promptOverrides: { worker: 'old worker', validator: 'same val' } },
        // ONE measured, passing gate — not an empty list. Under P-003 an empty
        // gate set derives 'inconclusive' (nothing was measured), which would
        // contradict this record's own verdict:'accept'.
        gateResults: [{ gate: 'dev-anchor', pass: true, status: 'pass', detail: 'fixture' }],
        recordedAt: 0,
      }),
    });
    const pending = await listProposals(sql, { workspaceId: WS, harnessSlug: 'rec', status: 'pending' });
    expect(pending.map((p) => p.role).sort()).toEqual(['reviewer', 'worker']); // validator unchanged → skipped
    const worker = pending.find((p) => p.role === 'worker')!;
    expect(worker.originalMd).toBe('old worker');
    expect(worker.proposedMd).toBe('new worker');
    expect(worker.cycle).toBe(4);
    const reviewer = pending.find((p) => p.role === 'reviewer')!;
    expect(reviewer.originalMd).toBeNull(); // newly added role → no parent prompt
    const cfg = await getAutoloop(sql, { workspaceId: WS, harnessSlug: 'rec' });
    expect(cfg!.lastCycle).toBe(4);
  });
});

describe('gym control plane — workspace/harness scoping', () => {
  it('does not leak proposals or prompts across harnesses', async () => {
    await recordProposal(sql, { workspaceId: WS, harnessSlug: 'iso-a', cycle: 1, variantId: 'va', role: 'worker', proposedMd: 'a' });
    const bPending = await listProposals(sql, { workspaceId: WS, harnessSlug: 'iso-b', status: 'pending' });
    expect(bPending).toHaveLength(0);
    await setPrompt(sql, { workspaceId: WS, harnessSlug: 'iso-a', role: 'worker', md: 'a-only' });
    const bPrompts = await getPrompts(sql, { workspaceId: WS, harnessSlug: 'iso-b' });
    expect(bPrompts.roles.worker).toBeUndefined();
  });
});
