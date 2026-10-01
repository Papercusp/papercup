/**
 * user-actions.integration.test.ts — the OperatorActionLog WRITE path
 * (`recordUserAction` / `updateUserAction` over `harness_shared.user_actions`)
 * against real testcontainer Postgres. The READ side (listUserActions) has its
 * own unit test (user-actions-data.test.ts); this pins the durable INSERT +
 * status-transition UPDATEs that drive the UI panel.
 *
 * The SUT routes every write through `getOrgPg().db` (a Drizzle instance), so we
 * mock db-org's getOrgPg to a real drizzle() over the org-fixture's admin client
 * (RLS-bypass — same choice as audit-writer.integration.test.ts). activeWorkspaceId
 * is pinned per test; the fire-and-forget sync-invalidate is mocked to a spy so we
 * can assert it fires and so operator-core's fail-on-console stays quiet.
 *
 * Covers: running→succeeded (summary/detailUrl/invocationId/finishedAt stamped),
 * running→failed (errorText truncated to 1000, finishedAt stamped, error rethrown),
 * the async-mode running row (status stays 'running', invocationId/detailUrl/summary
 * stamped, no finishedAt), workspace_id stamping, updateUserAction COALESCE
 * semantics (omitted summary/detailUrl preserved, errorText cleared), the
 * succeeded/failed/cancelled finalize states, the sync-invalidate fire (and that
 * updateUserAction on a missing id is a silent no-op), all end-to-end against the
 * real migrated schema.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 (integration tier).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  db: null as unknown,
  ws: 'ws-ua-default',
}));

// getOrgPg returns { db, sql }; recordUserAction/updateUserAction use db (drizzle)
// and updateUserAction also destructures sql. Point both at the fixture admin client.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: h.db, sql: h.sql }) };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
const notifySyncInvalidate = vi.fn(() => Promise.resolve());
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...a),
}));

const { recordUserAction, updateUserAction } = await import('./user-actions');
const { createOrgTestDb } = await import('../test/_org-test-db');

interface UaRow {
  id: string;
  harness_slug: string;
  kind: string;
  status: string;
  summary: string | null;
  detail_url: string | null;
  error_text: string | null;
  invocation_id: string | null;
  started_at: string;
  finished_at: string | null;
  actor: string | null;
  workspace_id: string;
}

describe('user_actions write path (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    h.db = drizzle(db.adminSql);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    notifySyncInvalidate.mockClear();
  });

  async function rowsFor(slug: string): Promise<UaRow[]> {
    return db.adminSql<UaRow[]>`
      SELECT id::text AS id, harness_slug, kind, status, summary, detail_url,
             error_text, invocation_id, started_at::text AS started_at,
             finished_at::text AS finished_at, actor, workspace_id
        FROM harness_shared.user_actions
       WHERE harness_slug = ${slug}
       -- id::bigint, not the text alias (WI-10004608): '10' would sort before '9'
       ORDER BY id::bigint`;
  }

  it('records a running row then transitions it to succeeded with summary/detailUrl/invocationId', async () => {
    h.ws = 'ws-ua-ok';
    const result = await recordUserAction('slug-ok', 'replan', async (id) => {
      expect(typeof id).toBe('number'); // the fn receives the freshly minted row id
      return {
        summary: 'Replanned 3 items',
        detailUrl: '/harness/slug-ok/plan',
        invocationId: 'inv-123',
        result: { ok: true, value: 7 },
      };
    });
    // The wrapper forwards the action's `result` to the route handler's caller.
    expect(result).toEqual({ ok: true, value: 7 });

    const rows = await rowsFor('slug-ok');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('replan');
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].summary).toBe('Replanned 3 items');
    expect(rows[0].detail_url).toBe('/harness/slug-ok/plan');
    expect(rows[0].invocation_id).toBe('inv-123');
    expect(rows[0].error_text).toBeNull();
    expect(rows[0].workspace_id).toBe('ws-ua-ok');
    // started_at stamped on insert; finished_at stamped on the succeeded update.
    expect(Number(rows[0].started_at)).toBeGreaterThan(0);
    expect(Number(rows[0].finished_at)).toBeGreaterThanOrEqual(Number(rows[0].started_at));
    expect(notifySyncInvalidate).toHaveBeenCalledWith('userActions.byHarness', {
      harnessSlug: 'slug-ok',
    });
  });

  it('stamps the actor when provided', async () => {
    h.ws = 'ws-ua-actor';
    await recordUserAction(
      'slug-actor',
      'cleanup',
      async () => ({ summary: 'done', result: null }),
      { actor: 'avi@example.com' },
    );
    const rows = await rowsFor('slug-actor');
    expect(rows[0].actor).toBe('avi@example.com');
    expect(rows[0].status).toBe('succeeded');
  });

  it('marks the row failed, truncates errorText to 1000 chars, stamps finishedAt, and rethrows', async () => {
    h.ws = 'ws-ua-fail';
    const longMsg = 'x'.repeat(2000);
    await expect(
      recordUserAction('slug-fail', 'consolidate', async () => {
        throw new Error(longMsg);
      }),
    ).rejects.toThrow(longMsg);

    const rows = await rowsFor('slug-fail');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_text).toHaveLength(1000); // sliced to 1000
    expect(rows[0].summary).toBeNull();
    expect(Number(rows[0].finished_at)).toBeGreaterThan(0);
    expect(notifySyncInvalidate).toHaveBeenCalledWith('userActions.byHarness', {
      harnessSlug: 'slug-fail',
    });
  });

  it('async mode leaves the row running, stamping invocationId/detailUrl/summary (no finishedAt)', async () => {
    h.ws = 'ws-ua-async';
    const out = await recordUserAction(
      'slug-async',
      'replan',
      async () => ({
        summary: 'background started',
        detailUrl: '/x',
        invocationId: 'inv-async',
        result: 'forwarded',
      }),
      { async: true },
    );
    expect(out).toBe('forwarded');

    const rows = await rowsFor('slug-async');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('running'); // NOT finalized — caller will updateUserAction later
    expect(rows[0].summary).toBe('background started');
    expect(rows[0].detail_url).toBe('/x');
    expect(rows[0].invocation_id).toBe('inv-async');
    expect(rows[0].finished_at).toBeNull();
  });

  it('updateUserAction finalizes an async row to succeeded and fires the invalidate', async () => {
    h.ws = 'ws-ua-finok';
    let capturedId = -1;
    await recordUserAction(
      'slug-finok',
      'plugin.install',
      async (id) => {
        capturedId = id;
        return { summary: 'installing…', detailUrl: '/keep-me', result: null };
      },
      { async: true },
    );
    notifySyncInvalidate.mockClear();

    await updateUserAction({ id: capturedId, status: 'succeeded', summary: 'installed v2' });

    const rows = await rowsFor('slug-finok');
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].summary).toBe('installed v2');
    // detailUrl was NOT passed → COALESCE keeps the running-row value.
    expect(rows[0].detail_url).toBe('/keep-me');
    expect(rows[0].error_text).toBeNull();
    expect(Number(rows[0].finished_at)).toBeGreaterThan(0);
    expect(notifySyncInvalidate).toHaveBeenCalledWith('userActions.byHarness', {
      harnessSlug: 'slug-finok',
    });
  });

  it('updateUserAction preserves the prior summary when summary is omitted (COALESCE-via-self)', async () => {
    h.ws = 'ws-ua-coalesce';
    let id = -1;
    await recordUserAction(
      'slug-coalesce',
      'cleanup',
      async (rowId) => {
        id = rowId;
        return { summary: 'original summary', result: null };
      },
      { async: true },
    );
    await updateUserAction({ id, status: 'failed', errorText: 'boom' });

    const rows = await rowsFor('slug-coalesce');
    expect(rows[0].status).toBe('failed');
    expect(rows[0].summary).toBe('original summary'); // untouched — only status/errorText changed
    expect(rows[0].error_text).toBe('boom');
  });

  it('updateUserAction supports the cancelled terminal state and clears errorText when omitted', async () => {
    h.ws = 'ws-ua-cancel';
    let id = -1;
    await recordUserAction(
      'slug-cancel',
      'branch.action',
      async (rowId) => {
        id = rowId;
        return { summary: 's', result: null };
      },
      { async: true },
    );
    await updateUserAction({ id, status: 'cancelled' });

    const rows = await rowsFor('slug-cancel');
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].error_text).toBeNull(); // errorText omitted → set to null
  });

  it('updateUserAction on a non-existent id is a silent no-op (no rows, no invalidate)', async () => {
    h.ws = 'ws-ua-noop';
    await expect(
      updateUserAction({ id: 999_999_999, status: 'succeeded', summary: 'ghost' }),
    ).resolves.toBeUndefined();
    // No matching row → returning([]) → slug undefined → no invalidate fired.
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('isolates rows by harness_slug (one slug never sees another slug\'s actions)', async () => {
    h.ws = 'ws-ua-iso';
    await recordUserAction('slug-iso-a', 'replan', async () => ({ summary: 'a', result: null }));
    await recordUserAction('slug-iso-b', 'replan', async () => ({ summary: 'b', result: null }));
    expect(await rowsFor('slug-iso-a')).toHaveLength(1);
    expect(await rowsFor('slug-iso-b')).toHaveLength(1);
    expect((await rowsFor('slug-iso-a'))[0].summary).toBe('a');
  });
});
