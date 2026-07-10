/**
 * wake-frontier-guard.integration.test.ts — the EI-309 frontier query against
 * REAL Postgres. `listUnplacedPotFrontier` is what the pot:declare-wake guard
 * reads to decide whether a no-time-component wake would strand work; this drives
 * it end-to-end so the status/assignee/kind/harness filters are exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL } from '../../test/_work-items-schema';
import { listUnplacedPotFrontier } from './wake-frontier-guard';

const readMigration = (f: string) =>
  readFileSync(join(__dirname, '../../../../libs/papercusp/libs/db/sql', f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

let db: FreshPgDb;

async function seed(
  harness: string,
  id: string,
  opts: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    createdTs?: number;
    origin?: string;
    auditVerdict?: string | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, origin, audit_verdict)
    VALUES (${harness}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'todo'},
            ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0,
            ${opts.origin ?? 'local'}, ${opts.auditVerdict ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wake-frontier');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // WI-3300 — listUnplacedPotFrontier now applies the G2 admission gate
  // (autoPickableWhereSql), whose trust fast-path subquery reads
  // harness_shared.user_trust_list unconditionally whenever a workspaceId is
  // passed (every real call). Must exist or every query in this suite errors
  // "relation does not exist" (mirrors survey.integration.test.ts's EI-8498 setup).
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.user_trust_list`;
});

const POT = 'sb-devboard';

describe('listUnplacedPotFrontier (EI-309)', () => {
  it('returns todo + unassigned feature-family ids in the home harness, oldest-first', async () => {
    await seed(POT, 'WI-117', { createdTs: 2 });
    await seed(POT, 'WI-116', { createdTs: 1 });
    await seed(POT, 'WI-115', { kind: 'chunk', createdTs: 0 });
    const frontier = await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT);
    expect(frontier).toEqual(['WI-115', 'WI-116', 'WI-117']); // oldest-first by created_ts
  });

  it('EXCLUDES assigned items (taken_by set) and non-todo statuses', async () => {
    await seed(POT, 'WI-taken', { takenBy: 'swarm-a' });
    await seed(POT, 'WI-validating', { status: 'validating' });
    await seed(POT, 'WI-passed', { status: 'passed' });
    await seed(POT, 'WI-open', {}); // todo + unassigned — the only frontier item
    expect(await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT)).toEqual(['WI-open']);
  });

  it('is scoped to the home harness (other harnesses are not the frontier)', async () => {
    await seed(POT, 'WI-mine', {});
    await seed('other-harness', 'WI-theirs', {});
    expect(await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT)).toEqual(['WI-mine']);
  });

  it('returns [] when the frontier is empty (everything placed) — the guard then allows', async () => {
    await seed(POT, 'WI-done', { status: 'passed' });
    expect(await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT)).toEqual([]);
  });

  it('respects the limit cap', async () => {
    for (let i = 0; i < 5; i++) await seed(POT, `WI-${i}`, { createdTs: i });
    const frontier = await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT, 3);
    expect(frontier).toEqual(['WI-0', 'WI-1', 'WI-2']);
  });

  it('WI-3300: excludes a REMOTE, un-admitted (quarantined) item — the same G2 gate fetchFrontierRows (EI-8498) enforces', async () => {
    await seed(POT, 'WI-LOCAL', { createdTs: 1 }); // origin defaults 'local'
    await seed(POT, 'WI-REMOTE-ADMITTED', { createdTs: 2, origin: 'remote', auditVerdict: 'admit' });
    await seed(POT, 'WI-REMOTE-QUARANTINED', { createdTs: 3, origin: 'remote', auditVerdict: null });
    const frontier = await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT);
    // Before this fix all three showed up as "unplaced frontier" — forcing
    // pot:declare-wake to refuse a no-time-wake ("PLACE them this turn") for a
    // quarantined item the Mug has no lever to place (WI-3300, mirrors EI-8498).
    expect(frontier.sort()).toEqual(['WI-LOCAL', 'WI-REMOTE-ADMITTED']);
  });

  it('WI-3300: the trust-list fast-path admits a remote item whose verified author is locally trusted', async () => {
    await seed(POT, 'WI-TRUSTED-REMOTE', { createdTs: 1, origin: 'remote', auditVerdict: null });
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET verified_author_github_user_id = 42 WHERE feature_id = 'WI-TRUSTED-REMOTE'`;
    await db.sql`INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id) VALUES ('default', 42)`;
    await seed(POT, 'WI-UNTRUSTED-REMOTE', { createdTs: 2, origin: 'remote', auditVerdict: null });
    const frontier = await listUnplacedPotFrontier(db.sql as unknown as postgres.Sql, 'default', POT);
    expect(frontier).toEqual(['WI-TRUSTED-REMOTE']);
  });
});
