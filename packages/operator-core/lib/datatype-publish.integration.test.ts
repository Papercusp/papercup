/**
 * datatype-publish.integration.test — the D-010 shared-tier publish + moderation lifecycle
 * against real Postgres (migration 425 `review_status`). Proves: publish marks PENDING
 * without touching LOCAL usability; the moderation queue spans workspaces (admin handle);
 * approve/reject transition only a pending row; a published datatype stays locally usable.
 *
 * Mirrors the datatype-registry fixture: createOrgTestDb + apply 421 + 425.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertDatatype,
  getDatatype,
  getGenericKindDatatype,
  publishDatatype,
  listPendingPublishedDatatypes,
  moderatePublishedDatatype,
  findSimilarPublishedDatatypes,
} from './datatype-registry-store';

const { createOrgTestDb } = await import('../test/_org-test-db');
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

async function declare(db: OrgTestDb, ws: string, id: string) {
  return upsertDatatype(db.adminSql, {
    id,
    workspaceId: ws,
    title: id,
    description: `the ${id} datatype`,
    tier: 'generic-kind',
    workItemKind: id,
  });
}

describe('datatype publish + moderation lifecycle (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(join(SQL_DIR, '421-datatype-registry.sql'), 'utf8'));
    await db.adminSql.unsafe(readFileSync(join(SQL_DIR, '425-datatype-review-status.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declare ⇒ review_status none; publish ⇒ pending; local usability unchanged', async () => {
    const ws = 'ws-pub';
    const declared = await declare(db, ws, 'bet');
    expect(declared.reviewStatus).toBe('none');
    expect(declared.published).toBe(false);

    const published = await publishDatatype(db.adminSql, ws, 'bet');
    expect(published).not.toBeNull();
    expect(published!.reviewStatus).toBe('pending');
    expect(published!.published).toBe(true);

    // LOCAL usability is untouched — the kind is still an active generic-kind locally.
    const local = await getGenericKindDatatype(db.adminSql, ws, 'bet');
    expect(local).not.toBeNull();
    expect(local!.status).toBe('active');
    expect(local!.reviewStatus).toBe('pending');

    // Re-publish is a no-op (already in a lifecycle).
    expect(await publishDatatype(db.adminSql, ws, 'bet')).toBeNull();
  });

  it('the moderation queue spans workspaces (admin handle)', async () => {
    const a = 'ws-q-a';
    const b = 'ws-q-b';
    await declare(db, a, 'wager');
    await declare(db, b, 'forecast');
    await publishDatatype(db.adminSql, a, 'wager');
    await publishDatatype(db.adminSql, b, 'forecast');

    const pending = await listPendingPublishedDatatypes(db.adminSql);
    const ids = pending.map((d) => `${d.workspaceId}/${d.id}`);
    expect(ids).toContain('ws-q-a/wager');
    expect(ids).toContain('ws-q-b/forecast');
  });

  it('approve ⇒ approved; reject ⇒ rejected; only a pending row transitions', async () => {
    const ws = 'ws-mod';
    await declare(db, ws, 'edge');
    await declare(db, ws, 'spread');
    await publishDatatype(db.adminSql, ws, 'edge');
    await publishDatatype(db.adminSql, ws, 'spread');

    const approved = await moderatePublishedDatatype(db.adminSql, ws, 'edge', 'approve');
    expect(approved!.reviewStatus).toBe('approved');
    const rejected = await moderatePublishedDatatype(db.adminSql, ws, 'spread', 'reject');
    expect(rejected!.reviewStatus).toBe('rejected');

    // Re-moderating a non-pending row is a no-op.
    expect(await moderatePublishedDatatype(db.adminSql, ws, 'edge', 'reject')).toBeNull();

    // Neither is in the pending queue any more.
    const stillPending = (await listPendingPublishedDatatypes(db.adminSql)).map((d) => `${d.workspaceId}/${d.id}`);
    expect(stillPending).not.toContain('ws-mod/edge');
    expect(stillPending).not.toContain('ws-mod/spread');

    // A re-declare of an approved datatype PRESERVES its review_status (doesn't reset it).
    await declare(db, ws, 'edge');
    expect((await getDatatype(db.adminSql, ws, 'edge'))!.reviewStatus).toBe('approved');
  });

  it('global dedup: finds a PUBLISHED datatype across workspaces, ignores local-only ones', async () => {
    // ws-A publishes a "kelly-stake" datatype (→ pending, globally visible to dedup).
    await upsertDatatype(db.adminSql, {
      id: 'kelly-stake',
      workspaceId: 'ws-g-a',
      title: 'Kelly stake',
      description: 'optimal stake sizing from edge and bankroll',
      tier: 'generic-kind',
      workItemKind: 'kelly-stake',
    });
    await publishDatatype(db.adminSql, 'ws-g-a', 'kelly-stake');
    // ws-B declares a near-identical one but does NOT publish it (review_status none).
    await upsertDatatype(db.adminSql, {
      id: 'kelly-stake-local',
      workspaceId: 'ws-g-b',
      title: 'Kelly stake local',
      description: 'optimal stake sizing from edge and bankroll',
      tier: 'generic-kind',
      workItemKind: 'kelly-stake-local',
    });

    const hits = await findSimilarPublishedDatatypes(db.adminSql, {
      title: 'Kelly stake',
      description: 'optimal stake sizing from edge and bankroll',
    });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('kelly-stake'); // the PUBLISHED one (cross-workspace)
    expect(ids).not.toContain('kelly-stake-local'); // unpublished ⇒ not in the global namespace
  });
});
