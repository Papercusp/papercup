import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { captureInvocationFriction, recoverInvocationFriction } from './invocation-friction';
import { captureToolInvocationFriction, type CaptureDeps } from './capture-core';
import type { EngineerIssue } from '../../issues-engineer';
import { metadataToolFailure } from '../../agent-tools/plans/coordination-metadata-fixtures';

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../system-health/compute', () => ({ refreshHealthPanel: vi.fn(async () => {}) }));
let db: FreshPgDb;
const source = (name: string) => readFile(fileURLToPath(new URL(
  `../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url)), 'utf8');
beforeAll(async () => {
  db = await createFreshPgDb('invocation-friction');
  await db.sql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL,
    coord_owner_id text, invoked_at timestamptz NOT NULL DEFAULT now(), tool_name text,
    status text, error_code text, error_message text, serving_build_sha text, metadata_json jsonb);
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text,
    feature_id text PRIMARY KEY, item_kind text, status text, payload jsonb)`);
  await db.sql.unsafe(await source('1148-tool-invocation-friction-pending-index.sql.DRAFT'));
  const identityMigration = await source('865-work-items-watchdog-key-identity-guard.sql');
  // Apply the real arbiter DDL, without the unrelated legacy repair population.
  const index = identityMigration.match(/CREATE UNIQUE INDEX IF NOT EXISTS work_items_watchdog_identity_uq[\s\S]*?;/);
  expect(index).not.toBeNull();
  await db.sql.unsafe(index![0]);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql.unsafe('TRUNCATE harness_shared.tool_invocations, harness_shared.work_items RESTART IDENTITY'); });

const sql = () => db.sql as unknown as NonNullable<Parameters<typeof recoverInvocationFriction>[1]>['sql'];
async function seed(workspace = 'ws-a') {
  const [row] = await db.sql`INSERT INTO harness_shared.tool_invocations
    (workspace_id,harness_slug,coord_owner_id,tool_name,status,error_code,error_message,serving_build_sha,metadata_json)
    VALUES (${workspace},'papercusp','su-a','coord:send','invalid-input','invalid_input','body: must be an array',
      'loaded-build','{"frictionCapture":"pending","retained":"evidence"}') RETURNING id::text`;
  return { id: row.id, workspaceId: workspace };
}
const success = async () => ({ ok: true, created: false, issue: { id: 'EI-1' } as EngineerIssue });

describe('R7 private PostgreSQL delivery contract', () => {
  it('rolls back failure, recovers below-threshold invalid calls and preserves other metadata', async () => {
    const ref = await seed();
    await expect(captureInvocationFriction(ref, { sql: sql(), capture: async () => { throw new Error('fixture failure'); } })).rejects.toThrow('fixture failure');
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations`)[0].metadata_json.frictionCapture).toBe('pending');
    expect(await recoverInvocationFriction('ws-a', { sql: sql(), capture: success })).toEqual({ delivered: 1, pending: 0 });
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations`)[0].metadata_json)
      .toEqual({ frictionCapture: 'delivered', retained: 'evidence' });
    expect(await captureInvocationFriction(ref, { sql: sql(), capture: success })).toBe(false);
  });

  it('concurrent delivery skips the row lock and never crosses workspace scope', async () => {
    const ref = await seed();
    await seed('ws-b');
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const capture = vi.fn(async () => { enter(); await held; return success(); });
    const first = captureInvocationFriction(ref, { sql: sql(), capture });
    await entered;
    try {
      expect(await captureInvocationFriction(ref, { sql: sql(), capture: success })).toBe(false);
      expect(await captureInvocationFriction({ ...ref, workspaceId: 'ws-b' }, { sql: sql(), capture: success })).toBe(false);
    } finally { release(); }
    expect(await first).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await db.sql`SELECT metadata_json FROM harness_shared.tool_invocations WHERE workspace_id='ws-b'`)[0].metadata_json.frictionCapture).toBe('pending');
  });

  it('the pending-index predicate matches the actual recovery query', async () => {
    await seed();
    const [{ plan }] = await db.sql.begin(async tx => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT id::text FROM harness_shared.tool_invocations
        WHERE workspace_id='ws-a' AND metadata_json->>'frictionCapture'='pending'
        ORDER BY COALESCE(metadata_json->>'frictionAttemptAt',''),invoked_at,id LIMIT 100`);
      return [{ plan: rows[0]['QUERY PLAN'] }];
    });
    expect(JSON.stringify(plan)).toContain('tool_invocations_friction_pending_idx');
  });

  it('different measured contracts fit the real unique index and cannot promote the old row', async () => {
    const stored: EngineerIssue[] = [];
    const deps: CaptureDeps = {
      searchIssues: async () => [],
      findIssuesByWatchdogKeys: async keys => stored.filter(row => keys.includes(String(row.payload?.watchdogKey))),
      findIssuesByToolFailureClassKeys: async () => stored,
      recordIssueOccurrence: async () => null,
      createIssue: async input => {
        const id = `EI-${stored.length + 1}`;
        await db.sql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,status,payload)
          VALUES ('ws-a',${input.scope},${id},'change','open',${JSON.stringify(input.payload)}::jsonb)`;
        const row = { ...input, id, state: 'open', signalOrigin: 'organic' } as EngineerIssue;
        stored.push(row); return row;
      },
      updateIssuePatch: async () => { throw new Error('Must not mutate the other contract'); },
      mergeIssuePayload: async () => { throw new Error('Must not merge the other contract'); },
    };
    for (const revision of ['schema-one', 'schema-two']) {
      await captureToolInvocationFriction({ workspaceId: 'ws-a', harnessSlug: 'papercusp', ownerId: revision,
        invokedAt: '2026-09-08T12:00:00Z', failure: { ...metadataToolFailure, schemaRevision: revision } }, deps);
    }
    const persisted = await db.sql`SELECT payload FROM harness_shared.work_items ORDER BY feature_id`;
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map(row => row.payload.watchdogKey)).size).toBe(2);
    for (const row of persisted) expect(row.payload.toolFailureProbation.state).toBe('probation');
  });
});
