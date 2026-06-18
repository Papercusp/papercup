/**
 * control-plane.integration.test.ts — the gym autoloop control plane
 * (getAutoloop/setAutoloop over gym_autoloop_config, mig 110), against a real
 * Postgres. Both take sql directly (injectable).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - setAutoloop is a read-merge-write upsert: a PARTIAL set PRESERVES unset
 *    fields (enabled/spentUsd/status/lastCycle…);
 *  - budgetUsd distinguishes null from undefined — `null` CLEARS the cap,
 *    `undefined` PRESERVES the existing cap (the `q.budgetUsd !== undefined`
 *    test, not `??`);
 *  - full round-trip via getAutoloop; null for an unknown harness.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { getAutoloop, setAutoloop, getPrompts, setPrompt, recordProposal, listProposals, GYM_PROMPT_KEYS } = await import('./control-plane');
const AGENT_ROLE = (GYM_PROMPT_KEYS as readonly string[]).find((k) => k !== 'judge')!; // a valid non-judge editable role

const WS = 'ws-cp';
const HS = 'web';
let rootSql: postgres.Sql;
const read = () => getAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS });

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_autoloop_config (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      budget_usd double precision,
      spent_usd double precision NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'idle',
      last_cycle integer, last_cycle_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_prompt_overrides (
      workspace_id text NOT NULL, harness_slug text NOT NULL, role text NOT NULL,
      prompt_md text NOT NULL, updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, role)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_proposals (
      id text PRIMARY KEY,
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      cycle integer NOT NULL DEFAULT 0, variant_id text, role text NOT NULL,
      original_md text, proposed_md text NOT NULL, rationale text,
      dev_anchor_delta double precision, cost_delta double precision, probe_status text,
      status text NOT NULL DEFAULT 'pending', created_at bigint NOT NULL, decided_at bigint
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.gym_autoloop_config, harness_shared.harness_prompt_overrides, harness_shared.gym_proposals`;
});

describe('setAutoloop / getAutoloop (PG)', () => {
  it('full upsert round-trips every field', async () => {
    const cfg = await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(cfg).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
  });

  it('a PARTIAL set preserves unset fields (read-merge-write)', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 7 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, status: 'running' }); // only status
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 7, status: 'running' }); // rest preserved
  });

  it('budgetUsd: undefined PRESERVES the cap, null CLEARS it', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: 100 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, spentUsd: 5 }); // budgetUsd undefined → preserve
    expect((await read())!.budgetUsd).toBe(100);
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: null }); // explicit null → clear the cap
    expect((await read())!.budgetUsd).toBeNull();
  });

  it('getAutoloop returns null for an unknown harness', async () => {
    expect(await getAutoloop(rootSql, { workspaceId: WS, harnessSlug: 'nope' })).toBeNull();
  });
});

describe('setPrompt / getPrompts (PG)', () => {
  it('upserts role-scoped prompts; getPrompts splits the judge rubric from the role overrides', async () => {
    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'judge', md: 'RUBRIC v1' });
    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: AGENT_ROLE, md: 'ROLE v1' });
    let p = await getPrompts(rootSql, { workspaceId: WS, harnessSlug: HS });
    expect(p.judgeRubric).toBe('RUBRIC v1'); // role='judge' → judgeRubric
    expect(p.roles[AGENT_ROLE]).toBe('ROLE v1'); // other roles → roles map

    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'judge', md: 'RUBRIC v2' }); // same (ws,harness,role) → upsert
    p = await getPrompts(rootSql, { workspaceId: WS, harnessSlug: HS });
    expect(p.judgeRubric).toBe('RUBRIC v2'); // overwritten, not duplicated
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_prompt_overrides WHERE role='judge'`).toHaveLength(1);
  });

  it('rejects a non-editable prompt key (not judge or an agent role)', async () => {
    await expect(setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'definitely-not-a-role', md: 'x' })).rejects.toThrow();
  });
});

describe('recordProposal (PG)', () => {
  const propose = (over: Record<string, unknown> = {}) =>
    recordProposal(rootSql, { workspaceId: WS, harnessSlug: HS, cycle: 1, variantId: 'v1', role: AGENT_ROLE, proposedMd: 'P v1', ...over });

  it('upserts a pending proposal deterministically; a retried cycle updates the PENDING row', async () => {
    const id = await propose({ proposedMd: 'P v1' });
    expect(id).toBe(`v1__${AGENT_ROLE}`); // deterministic id per (variant, role)
    await propose({ proposedMd: 'P v2' }); // retry same (variant, role) → same id → update
    const rows = await rootSql<{ proposed_md: string }[]>`SELECT proposed_md FROM harness_shared.gym_proposals WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_md).toBe('P v2'); // pending row updated
  });

  it('NEVER resurrects a DECIDED proposal — the conflict-update only touches a still-pending row', async () => {
    const id = await propose({ proposedMd: 'P v1' });
    await rootSql`UPDATE harness_shared.gym_proposals SET status='accepted' WHERE id=${id}`; // human decided
    await propose({ proposedMd: 'P v2-should-be-ignored' }); // re-record the same id
    const row = (await rootSql<{ proposed_md: string; status: string }[]>`SELECT proposed_md, status FROM harness_shared.gym_proposals WHERE id=${id}`)[0]!;
    expect(row.status).toBe('accepted'); // decision survives
    expect(row.proposed_md).toBe('P v1'); // NOT overwritten — the WHERE status='pending' blocked it
  });

  it('listProposals filters by status + variant, newest cycle first', async () => {
    await propose({ id: 'a', cycle: 1, variantId: 'v1', proposedMd: 'A' });
    await propose({ id: 'b', cycle: 3, variantId: 'v1', proposedMd: 'B' });
    await propose({ id: 'c', cycle: 2, variantId: 'v2', proposedMd: 'C' });
    const v1 = await listProposals(rootSql, { workspaceId: WS, harnessSlug: HS, variantId: 'v1' });
    expect(v1.map((p) => p.id)).toEqual(['b', 'a']); // cycle DESC, only v1
    const pending = await listProposals(rootSql, { workspaceId: WS, harnessSlug: HS, status: 'pending' });
    expect(pending).toHaveLength(3); // all pending
  });
});
