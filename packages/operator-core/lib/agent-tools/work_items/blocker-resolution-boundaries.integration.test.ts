/** Public blocker contracts over real PostgreSQL. Only the external condition
 * producer and unrelated runtime discovery are replaced; validation, identities,
 * dependencies, lifecycle, decision CAS, claims and checkpoints are production. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, applyDisclosureLedgerForTest,
  createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL,
  applyClaimPathReadDeps } from '../../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import type { BlockerDecisionInput } from '../../blocker-resolution-decision';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, cleared: false }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', async original => ({
  ...(await original<typeof import('../../workspace-registry')>()), activeWorkspaceId: () => 'default',
}));
vi.mock('../../harness-core', async original => ({
  ...(await original<typeof import('../../harness-core')>()),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../../blueprint/operation-worker-binding', async original => ({
  ...(await original<typeof import('../../blueprint/operation-worker-binding')>()),
  readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' as const }),
}));
vi.mock('../coordination/federation-scope', async original => ({
  ...(await original<typeof import('../coordination/federation-scope')>()),
  resolveWorkspaceHiveScope: async () => ({ kind: 'none' as const }),
}));
vi.mock('../../external-condition-reachability', async original => ({
  ...(await original<typeof import('../../external-condition-reachability')>()),
  readEventConditionReachability: async () => ({ verdict: 'reachable' as const,
    basis: h.cleared ? 'fired' as const : 'live-resolver' as const, authoritative: true,
    evidence: 'Isolated condition producer observation', checkedAt: new Date().toISOString() }),
}));
vi.mock('../coordination/presence', async original => ({
  ...(await original<typeof import('../coordination/presence')>()),
  getPresence: async (ownerId: string) => ownerId === 'agent-repair'
    ? { ownerId, workspaceId: 'default', stale: false } : null,
}));

const wi = await import('../../work-items');
const checkpoints = await import('../../work-item-checkpoint');
const { readBlockerResolution } = await import('../../blocker-resolution-decision');
const { default: setBlocker } = await import('./set_blocker');
const { default: setState } = await import('./set_state');
const { default: release } = await import('./release');
const { default: park } = await import('./park');
const { default: link } = await import('./link');

const HARNESS = 'blocker-boundaries';
const OWNER = 'su-blocker-boundaries';
const EVENT = 'fixture:dependency-repaired';
const ref = { kind: 'event' as const, ref: EVENT };
const CTX = { isSuperuser: true, uiClientId: OWNER, workspaceId: 'default', role: 'su',
  signal: new AbortController().signal, log: () => {}, progress: () => {}, metadata: () => {} } as never;
type Result = { ok?: boolean; code?: string; error?: string; nextAction?: string;
  results?: Result[]; replayed?: boolean; blockerDecision?: { id: string } };
async function call(tool: { handler: (args: never, ctx: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const result = await tool.handler(args as never, CTX) as { data?: Result; content?: { text?: string }[] };
  const data = result.data ?? JSON.parse(result.content?.find(entry => entry.text?.startsWith('{'))?.text ?? '{}') as Result;
  return data.results?.[0] ?? data;
}
const checkpointRef = (id: string) => ({ id, harness: HARNESS, workspaceId: 'default' });
const deferral = (key: string): BlockerDecisionInput => ({ schemaVersion: 1, idempotencyKey: key,
  disposition: 'defer', symptom: 'Dependency probe is pending', evidenceRefs: [ref],
  investigation: [{ action: 'Read the condition producer', outcome: 'Repair has not completed', evidenceRefs: [ref] }],
  attempts: [], deferral: { reason: 'external-dependency', responsibleParty: `event:${EVENT}`,
    reasonEvidenceRefs: [ref], nextAction: 'Resume when the producer certifies recovery', recheckRef: ref } });
const resolution = (key: string): BlockerDecisionInput => ({ schemaVersion: 1, idempotencyKey: key,
  disposition: 'self_resolve', symptom: 'Dependency was unavailable', evidenceRefs: [ref],
  investigation: [{ action: 'Read the condition producer', outcome: 'Safe repair is available', evidenceRefs: [ref] }],
  attempts: [{ action: 'Repair the isolated dependency', outcome: 'Producer confirms recovery', evidenceRefs: [ref] }],
  verification: { outcome: 'The original dependency condition is satisfied', evidenceRefs: [ref] } });
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('blocker-boundaries');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'blocker-resolution-boundaries.integration.test.ts' });
  await applyDisclosureLedgerForTest(db.sql);
  for (const name of ['831-issue-occurrence-ledger.sql', '140-plan-item-assignments.sql']) {
    const ddl = readFileSync(fileURLToPath(new URL(`../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url)), 'utf8')
      .split('\n').filter(line => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line)).join('\n');
    await db.sql.unsafe(ddl).simple();
  }
  await applyClaimPathReadDeps(ddl => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL, scope text NOT NULL, note text, journal jsonb NOT NULL DEFAULT '[]',
    updated_ts bigint NOT NULL, deps jsonb, body_ts bigint, attested_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope))`);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  h.cleared = false;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
    harness_shared.carry_notes, harness_shared.coord_event_log RESTART IDENTITY CASCADE`;
});
async function seed(kind: 'task' | 'feature' = 'feature', blocked = true) {
  const item = await wi.createWorkItem({ kind, title: 'Investigate dependency', harness: HARNESS, createdBy: OWNER });
  const blockers = blocked ? [{ kind: 'event', capability: 'live-dependency', ref: EVENT, status: 'active',
    createdBy: OWNER, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' }] : [];
  await db.sql`UPDATE harness_shared.work_items SET status='wip', taken_by=${OWNER}, taken_at=now(),
    payload=payload || ${db.sql.json({ keep: 'original', externalBlockers: blockers,
      _claimHold: true, claim_hold_by: OWNER })} WHERE feature_id=${item.id}
    AND workspace_id='default' AND harness_slug=${HARNESS}`;
  await checkpoints.setWorkItemCheckpoint(checkpointRef(item.id), 'Original checkpoint');
  return item.id;
}
async function snapshot(id: string) {
  const [row] = await db.sql`SELECT to_jsonb(w) AS value FROM harness_shared.work_items w
    WHERE workspace_id='default' AND harness_slug=${HARNESS} AND feature_id=${id}`;
  return { row: row.value, checkpoint: await checkpoints.getWorkItemCheckpoint(checkpointRef(id)),
    edges: [...await db.sql`SELECT * FROM harness_shared.work_item_deps ORDER BY id`],
    events: [...await db.sql`SELECT * FROM harness_shared.coord_event_log ORDER BY id`] };
}
const state = (id: string, key: string) => call(setState, {
  id, harness: HARNESS, state: 'blocked', blockerDecision: deferral(key),
});

describe('public blocker resolution boundaries', () => {
  it('guards all public deferral boundaries before mutation', async () => {
    for (const kind of ['task', 'feature'] as const) {
      const id = await seed(kind);
      const source = await seed('task', false);
      const before = await snapshot(id);
      const requests = [
        [setBlocker, { id, kind: 'event', ref: EVENT }],
        [setBlocker, { id, ref: EVENT, clear: true }],
        [setState, { id, state: 'blocked' }],
        [setState, { id, state: 'open' }],
        [release, { id }],
        [release, { id, claimHold: true }],
        [park, { id, checkpoint: 'Must not overwrite original', reason: 'Dependency remains' }],
        [link, { src: source, dst: id, rel: 'blocks' }],
      ] as const;
      for (const [tool, args] of requests) {
        const result = await call(tool, { ...args, harness: HARNESS });
        expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
        expect(await snapshot(id), JSON.stringify(args)).toEqual(before);
      }
    }
  });
  it('preserves work state and claim on refusal', async () => {
    const id = await seed();
    const before = await snapshot(id);
    const invalid = await call(setBlocker, { id, harness: HARNESS, kind: 'event', ref: EVENT,
      blockerDecision: { ...deferral('invalid'), evidenceRefs: [{ kind: 'work-item', ref: `${HARNESS}#WI-absent` }] } });
    expect(invalid).toMatchObject({ ok: false, code: 'blocker_decision_evidence', nextAction: expect.stringContaining('custody') });
    expect(await snapshot(id)).toEqual(before);
  });
  it('persists one decision across blocker boundaries', async () => {
    const id = await seed();
    const args = { id, harness: HARNESS, kind: 'event', ref: EVENT, blockerDecision: deferral('persist') };
    const first = await call(setBlocker, args);
    expect(first).toMatchObject({ ok: true });
    const recorded = readBlockerResolution((await wi.getWorkItem(id, HARNESS))?.payload);
    expect(recorded.status).toBe('recorded');
    const before = await snapshot(id);
    expect(await call(setBlocker, args)).toMatchObject({ ok: true, replayed: true, blockerDecision: first.blockerDecision });
    expect(await snapshot(id)).toEqual(before);
    expect(await call(setState, { id, harness: HARNESS, state: 'open', blockerDecision: deferral('persist') }))
      .toMatchObject({ ok: false, code: 'blocker_decision_conflict' });
    expect(await snapshot(id)).toEqual(before);
  });
  it('safe repair clears the blocker and retains custody', async () => {
    for (const kind of ['task', 'feature'] as const) {
      const id = await seed(kind);
      const before = await snapshot(id);
      const args = { id, harness: HARNESS, ref: EVENT, clear: true, blockerDecision: resolution('repair') };
      expect(await call(setBlocker, args)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
      expect(await snapshot(id)).toEqual(before);
      h.cleared = true;
      expect(await call(setBlocker, args)).toMatchObject({ ok: true });
      const item = await wi.getWorkItem(id, HARNESS);
      expect(item?.assignee).toBe(OWNER);
      expect(item?.payload).toMatchObject({ externalBlockers: [{ status: 'cleared' }],
        blockerResolution: { history: [{ authorId: OWNER, sessionId: OWNER }] } });
      expect(await checkpoints.getWorkItemCheckpoint(checkpointRef(id))).toBe('Original checkpoint');
      h.cleared = false;
    }
  });
  it('resumes only after measured dependency clearance', async () => {
    const id = await seed();
    expect(await state(id, 'defer-before-resume')).toMatchObject({ ok: true });
    const before = await snapshot(id);
    expect(await call(setBlocker, { id, harness: HARNESS, ref: EVENT, clear: true,
      blockerDecision: resolution('premature-resume') })).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(await snapshot(id)).toEqual(before);
    h.cleared = true;
    expect(await call(setBlocker, { id, harness: HARNESS, ref: EVENT, clear: true,
      blockerDecision: { ...resolution('measured-resume'), priorRevision: 1 } })).toMatchObject({ ok: true });
    expect(await wi.getWorkItem(id, HARNESS)).toMatchObject({ state: 'todo', assignee: OWNER });
  });

  for (const [family, kind] of [['issue', 'task'], ['feature', 'feature']] as const) {
    it(`rolls back decision history when lifecycle mutation fails for ${family} payloads`, async () => {
      const id = await seed(kind);
      const before = await snapshot(id);
      await db.sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.reject_boundary_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.status='blocked' THEN RAISE EXCEPTION 'injected lifecycle failure'; END IF; RETURN NEW; END $fn$;
        CREATE TRIGGER reject_boundary_lifecycle BEFORE UPDATE ON harness_shared.work_items
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_boundary_lifecycle()`);
      try {
        expect(await state(id, 'lifecycle-failure')).toMatchObject({ ok: false });
        expect(await snapshot(id)).toEqual(before);
      } finally { await db.sql.unsafe('DROP TRIGGER reject_boundary_lifecycle ON harness_shared.work_items'); }
      expect(await state(id, 'lifecycle-control')).toMatchObject({ ok: true });
      const second = await seed(kind);
      const race = await Promise.all([state(second, 'lifecycle-race-a'), state(second, 'lifecycle-race-b')]);
      expect(race.filter(result => result.ok)).toHaveLength(1);
      expect(race.filter(result => !result.ok)).toHaveLength(1);
      expect((await snapshot(second)).row.payload.blockerResolution.history).toHaveLength(1);
    });
    it(`rolls back lifecycle custody when decision CAS loses for ${family} payloads`, async () => {
      const id = await seed(kind);
      const before = await snapshot(id);
      await db.sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.reject_boundary_decision() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.payload ? 'blockerResolution' THEN RAISE EXCEPTION 'injected decision commit failure'; END IF; RETURN NEW; END $fn$;
        CREATE CONSTRAINT TRIGGER reject_boundary_decision AFTER UPDATE ON harness_shared.work_items
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_boundary_decision()`);
      try {
        expect(await state(id, 'decision-failure')).toMatchObject({ ok: false });
        expect(await snapshot(id)).toEqual(before);
      } finally { await db.sql.unsafe('DROP TRIGGER reject_boundary_decision ON harness_shared.work_items'); }
      expect(await state(id, 'decision-control')).toMatchObject({ ok: true });
      const committed = await snapshot(id);
      expect(await call(setState, { id, harness: HARNESS, state: 'open',
        blockerDecision: { ...deferral('stale-cas'), priorRevision: 0 } })).toMatchObject({ ok: false });
      expect(await snapshot(id)).toEqual(committed);
      const second = await seed(kind);
      const race = await Promise.all([state(second, 'decision-race-a'), state(second, 'decision-race-b')]);
      expect(race.filter(result => result.ok)).toHaveLength(1);
      expect(race.filter(result => !result.ok)).toHaveLength(1);
      expect((await snapshot(second)).row.payload.blockerResolution.history).toHaveLength(1);
    });
  }
});
