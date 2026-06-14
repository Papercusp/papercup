/**
 * tick-ledger.integration.test.ts — the Scout tick ledger (migration 208's
 * harness_shared.scout_ticks) against real Postgres. Validates recordScoutTick's
 * INSERT + readScoutTicks' newest-first / workspace-scoped / installSlug-filtered
 * read + the camelCase + spend/detail mapping against the full migrated schema.
 *
 * Follows the established org-fixture pattern (see attention/triage-store.integration.test.ts):
 * the runtime seam routes through getOrgPg().sql as the table owner, so we mock it
 * to the fixture's admin (RLS-bypass) client and mock the workspace resolver. The
 * fire-and-forget sync-sse push is mocked to a no-op (operator-core is fail-on-console).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-scout-default' }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => Promise.resolve() }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { recordScoutTick, readScoutTicks } = await import('./tick-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('scout_ticks ledger (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('records a full "ran" tick and reads it back with counts, spend, and detail mapped', async () => {
    const ws = 'ws-scout-ran';
    await recordScoutTick({
      workspaceId: ws,
      installSlug: 'harness-1',
      status: 'ran',
      ideasGenerated: 5,
      ideasRouted: 3,
      ideasDeduped: 2,
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'c1', reason: 'full cycle' },
    });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ran',
      installSlug: 'harness-1',
      ideasGenerated: 5,
      ideasRouted: 3,
      ideasDeduped: 2,
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'c1', reason: 'full cycle' },
    });
    expect(typeof rows[0].tickAt).toBe('string');
    expect(Number.isNaN(Date.parse(rows[0].tickAt))).toBe(false);
  });

  it('records a "gated" tick: gate is named, spend + detail omitted, counts default to 0', async () => {
    const ws = 'ws-scout-gated';
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'min-interval' });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('gated');
    expect(rows[0].gate).toBe('min-interval');
    expect(rows[0].ideasGenerated).toBe(0);
    expect(rows[0].budgetUsedUsd).toBeUndefined();
    expect(rows[0].detail).toBeUndefined();
  });

  it('reads newest-first', async () => {
    const ws = 'ws-scout-order';
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'first' });
    await new Promise((r) => setTimeout(r, 25)); // distinct tick_at (now() = statement time)
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'second' });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(2);
    expect(rows[0].gate).toBe('second');
    expect(rows[1].gate).toBe('first');
  });

  it('is workspace-scoped — another workspace\'s ticks are not returned', async () => {
    await recordScoutTick({ workspaceId: 'ws-scout-iso-a', status: 'ran' });
    await recordScoutTick({ workspaceId: 'ws-scout-iso-b', status: 'ran' });
    expect(await readScoutTicks({ workspaceId: 'ws-scout-iso-a' })).toHaveLength(1);
    expect(await readScoutTicks({ workspaceId: 'ws-scout-iso-b' })).toHaveLength(1);
  });

  it('filters by installSlug when given', async () => {
    const ws = 'ws-scout-slug';
    await recordScoutTick({ workspaceId: ws, status: 'ran', installSlug: 'alpha' });
    await recordScoutTick({ workspaceId: ws, status: 'ran', installSlug: 'beta' });
    const alpha = await readScoutTicks({ workspaceId: ws, installSlug: 'alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].installSlug).toBe('alpha');
  });

  it('caps the read at the requested limit (newest-first)', async () => {
    const ws = 'ws-scout-limit';
    for (let i = 0; i < 3; i++) await recordScoutTick({ workspaceId: ws, status: 'gated', gate: `g${i}` });
    expect(await readScoutTicks({ workspaceId: ws, limit: 2 })).toHaveLength(2);
  });
});
