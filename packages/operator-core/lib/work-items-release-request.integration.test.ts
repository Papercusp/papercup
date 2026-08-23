/**
 * work-items-release-request.integration.test.ts — WI-5974: the storage layer behind
 * work_items:request_release ("announced consequence" rail).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • setWorkItemReleaseRequest stamps the flat `release_request_*` payload keys;
 *   • readWorkItemReleaseRequest parses them back faithfully (including the null-until-
 *     resolved fields);
 *   • resolveWorkItemReleaseRequest is a genuine CAS — the FIRST resolve wins and returns
 *     the resolved request; a SECOND resolve attempt (already-resolved, or nothing pending)
 *     is a no-op returning null, so a holder-release racing the sweep's deadline-fire can
 *     never double-fire a consequence;
 *   • findDueReleaseRequests returns only UNRESOLVED requests whose deadline has passed —
 *     not a future deadline, not an already-resolved one, not an item with no request at all.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-release-request.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, activeWs: 'default' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.activeWs };
});

const rr = await import('./work-items-release-request');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedIssue(
  id: string,
  opts: { takenBy?: string | null; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, 'open', ${opts.takenBy ?? null},
       ${WS}, 0, 0, ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
}

async function readPayload(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return rows[0]?.payload ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-release-request');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  h.activeWs = 'default';
});
afterEach(() => {
  h.activeWs = 'default';
});

describe('readWorkItemReleaseRequest (pure)', () => {
  it('returns null for a payload with no release request', () => {
    expect(rr.readWorkItemReleaseRequest(null)).toBeNull();
    expect(rr.readWorkItemReleaseRequest({})).toBeNull();
    expect(rr.readWorkItemReleaseRequest({ release_request_by: 'a' })).toBeNull(); // missing holder/deadline
  });

  it('parses a full unresolved request', () => {
    const req = rr.readWorkItemReleaseRequest({
      release_request_by: 'peer-a',
      release_request_holder: 'peer-b',
      release_request_reason: 'looks orphaned',
      release_request_on_silence: 'reclaim',
      release_request_deadline_at: 1000,
      release_request_requested_at: 500,
      release_request_resolved: false,
      release_request_resolution: null,
      release_request_resolved_at: null,
    });
    expect(req).toEqual({
      by: 'peer-a',
      holder: 'peer-b',
      reason: 'looks orphaned',
      onSilence: 'reclaim',
      deadlineAt: 1000,
      requestedAt: 500,
      resolved: false,
      resolution: null,
      resolvedAt: null,
    });
  });
});

describe('setWorkItemReleaseRequest + resolveWorkItemReleaseRequest (CAS)', () => {
  it('stamps the flat payload keys, unresolved', async () => {
    await seedIssue('WI-rr-1', { takenBy: 'peer-b' });
    const rec = await rr.setWorkItemReleaseRequest('WI-rr-1', {
      harness: H,
      by: 'peer-a',
      holder: 'peer-b',
      reason: 'orphan-looking',
      onSilence: 'reclaim',
      deadlineAt: Date.now() + 60_000,
    });
    expect(rec).toMatchObject({ id: 'WI-rr-1', harness: H });
    const payload = await readPayload('WI-rr-1');
    const req = rr.readWorkItemReleaseRequest(payload);
    expect(req).toMatchObject({ by: 'peer-a', holder: 'peer-b', reason: 'orphan-looking', onSilence: 'reclaim', resolved: false, resolution: null });
  });

  it('returns null when the item does not exist', async () => {
    const rec = await rr.setWorkItemReleaseRequest('WI-does-not-exist', {
      harness: H,
      by: 'peer-a',
      holder: 'peer-b',
      reason: 'x',
      onSilence: 'nothing',
      deadlineAt: Date.now() + 1000,
    });
    expect(rec).toBeNull();
  });

  it('a fresh request OVERWRITES a prior resolved one (resolved resets to false)', async () => {
    await seedIssue('WI-rr-2', { takenBy: 'peer-b' });
    await rr.setWorkItemReleaseRequest('WI-rr-2', { harness: H, by: 'a', holder: 'peer-b', reason: 'r1', onSilence: 'nothing', deadlineAt: Date.now() - 1 });
    const resolved1 = await rr.resolveWorkItemReleaseRequest('WI-rr-2', { harness: H, resolution: 'consequence-nothing' });
    expect(resolved1?.resolved).toBe(true);

    await rr.setWorkItemReleaseRequest('WI-rr-2', { harness: H, by: 'c', holder: 'peer-b', reason: 'r2', onSilence: 'escalate', deadlineAt: Date.now() + 60_000 });
    const req = rr.readWorkItemReleaseRequest(await readPayload('WI-rr-2'));
    expect(req).toMatchObject({ by: 'c', reason: 'r2', onSilence: 'escalate', resolved: false, resolution: null });
  });

  it('CAS: the FIRST resolve wins and returns the resolved request', async () => {
    await seedIssue('WI-rr-3', { takenBy: 'peer-b' });
    await rr.setWorkItemReleaseRequest('WI-rr-3', { harness: H, by: 'a', holder: 'peer-b', reason: 'r', onSilence: 'reclaim', deadlineAt: 12345 });
    const resolved = await rr.resolveWorkItemReleaseRequest('WI-rr-3', { harness: H, resolution: 'holder-released' });
    expect(resolved).toMatchObject({ by: 'a', holder: 'peer-b', resolved: true, resolution: 'holder-released' });
    expect(resolved!.resolvedAt).toEqual(expect.any(Number));
  });

  it('CAS: a SECOND resolve attempt on an already-resolved request is a no-op (null)', async () => {
    await seedIssue('WI-rr-4', { takenBy: 'peer-b' });
    await rr.setWorkItemReleaseRequest('WI-rr-4', { harness: H, by: 'a', holder: 'peer-b', reason: 'r', onSilence: 'reclaim', deadlineAt: 1 });
    const first = await rr.resolveWorkItemReleaseRequest('WI-rr-4', { harness: H, resolution: 'holder-released' });
    expect(first).not.toBeNull();
    // simulate the sweep racing in right after — must NOT re-fire the consequence
    const second = await rr.resolveWorkItemReleaseRequest('WI-rr-4', { harness: H, resolution: 'consequence-reclaim' });
    expect(second).toBeNull();
    // the original resolution (holder-released) is preserved, not overwritten
    const req = rr.readWorkItemReleaseRequest(await readPayload('WI-rr-4'));
    expect(req?.resolution).toBe('holder-released');
  });

  it('terminalized before the deadline → resolves the request as superseded, not as a consequence', async () => {
    await seedIssue('WI-rr-terminal', { takenBy: 'peer-b' });
    await rr.setWorkItemReleaseRequest('WI-rr-terminal', {
      harness: H,
      by: 'requester',
      holder: 'peer-b',
      reason: 'stalled',
      onSilence: 'reclaim',
      deadlineAt: Date.now() - 1,
    });
    await db.sql`
      UPDATE harness_shared.work_items
         SET status = 'done', updated_ts = ${Date.now()}
       WHERE workspace_id = ${WS} AND feature_id = 'WI-rr-terminal'`;

    const resolved = await rr.resolveWorkItemReleaseRequest('WI-rr-terminal', {
      harness: H,
      resolution: 'consequence-reclaim',
    });

    expect(resolved).toMatchObject({ resolved: true, resolution: 'superseded' });
    expect(rr.readWorkItemReleaseRequest(await readPayload('WI-rr-terminal'))).toMatchObject({
      resolved: true,
      resolution: 'superseded',
    });
  });

  it('resolving an item with NO pending request is a no-op (null)', async () => {
    await seedIssue('WI-rr-5', { takenBy: 'peer-b' });
    const res = await rr.resolveWorkItemReleaseRequest('WI-rr-5', { harness: H, resolution: 'holder-released' });
    expect(res).toBeNull();
  });
});

describe('findDueReleaseRequests', () => {
  it('returns only UNRESOLVED requests whose deadline has passed', async () => {
    const now = Date.now();

    await seedIssue('WI-due-past-unresolved', { takenBy: 'holder-1' });
    await rr.setWorkItemReleaseRequest('WI-due-past-unresolved', { harness: H, by: 'req-1', holder: 'holder-1', reason: 'r', onSilence: 'reclaim', deadlineAt: now - 5000 });

    await seedIssue('WI-future-unresolved', { takenBy: 'holder-2' });
    await rr.setWorkItemReleaseRequest('WI-future-unresolved', { harness: H, by: 'req-2', holder: 'holder-2', reason: 'r', onSilence: 'reclaim', deadlineAt: now + 60_000 });

    await seedIssue('WI-due-past-resolved', { takenBy: 'holder-3' });
    await rr.setWorkItemReleaseRequest('WI-due-past-resolved', { harness: H, by: 'req-3', holder: 'holder-3', reason: 'r', onSilence: 'escalate', deadlineAt: now - 5000 });
    await rr.resolveWorkItemReleaseRequest('WI-due-past-resolved', { harness: H, resolution: 'holder-declined' });

    await seedIssue('WI-no-request', { takenBy: 'holder-4' });

    const due = await rr.findDueReleaseRequests(db.sql, { nowMs: now });
    const ids = due.map((d) => d.id).sort();
    expect(ids).toEqual(['WI-due-past-unresolved']);
    const row = due.find((d) => d.id === 'WI-due-past-unresolved')!;
    expect(row).toMatchObject({ harness: H, holderNow: 'holder-1' });
    expect(row.request).toMatchObject({ by: 'req-1', holder: 'holder-1', onSilence: 'reclaim' });
  });

  it('returns an empty list when nothing is due', async () => {
    await seedIssue('WI-nothing-due', { takenBy: 'holder-1' });
    const due = await rr.findDueReleaseRequests(db.sql, { nowMs: Date.now() });
    expect(due).toEqual([]);
  });
});
