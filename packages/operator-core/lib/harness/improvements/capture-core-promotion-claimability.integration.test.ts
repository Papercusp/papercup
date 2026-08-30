/**
 * EI-21867819718600027 — a promoted tool-failure probation row must leave the
 * observation lane completely, not store `lane: null`.
 *
 * The scheduler excludes only payload.lane='observation', but keeping a JSON
 * null key is still the wrong admission identity and defeats key-existence
 * readers. This drives the real capture promotion, mergeIssuePayload unset, and
 * issue-family claimability read against a fully migrated Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { FilterNode } from '../../scheduler/claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { readIssueClaimability } = await import('../../scheduler/get-next');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('tool-failure probation promotion → scheduler admission', () => {
  it('removes payload.lane and makes the same row claimable under an exact-id filter', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `tool-failure probation claimability ${suffix}`;
    const watchdogKey = `repeated-tool-error:work_items:get:structural:${suffix}`;
    const probation = (reporter: string) => ({
      state: 'probation' as const,
      class: 'structural',
      watchdogKey,
      correlationFingerprint: `work_items:get|handler_error|500|payload|test|${suffix}`,
      intendedKind: 'change' as const,
      reporters: [reporter],
    });

    const first = await captureImprovement({
      title,
      kind: 'change',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-test',
      payloadExtra: { toolFailureProbation: probation('su-test') },
    });
    expect(first).toMatchObject({
      ok: true,
      created: true,
      issue: { payload: { lane: 'observation' } },
    });

    const promoted = await captureImprovement({
      title,
      kind: 'change',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-peer',
      payloadExtra: { toolFailureProbation: probation('su-peer') },
    });
    expect(promoted).toMatchObject({
      ok: true,
      created: false,
      reason: 'promoted',
      issue: { id: first.issue?.id, payload: { toolFailureProbation: { state: 'promoted' } } },
    });

    const id = first.issue!.id;
    const storedRows = await db.adminSql<{
      workspace_id: string;
      payload: Record<string, unknown>;
    }[]>`
      SELECT workspace_id, payload
        FROM harness_shared.work_items
       WHERE feature_id = ${id}`;
    expect(storedRows).toHaveLength(1);
    const stored = storedRows[0];
    if (!stored) throw new Error(`promoted row ${id} was not persisted`);
    expect(stored.workspace_id).not.toBe('');
    expect(Object.keys(stored.payload)).not.toContain('lane');

    const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
    const claimability = await readIssueClaimability(
      filter,
      {
        harness: 'papercusp',
        workspaceId: stored.workspace_id,
        states: ['open'],
        assignee: 'su-test',
        client: db.adminSql,
      },
      { limit: 10 },
    );

    expect(claimability.breakdown).toMatchObject({
      matchedByFilter: 1,
      claimable: 1,
      excluded: { observationLane: 0 },
    });
    expect(claimability.rows.map((row) => row.id)).toEqual([id]);
  });
});
