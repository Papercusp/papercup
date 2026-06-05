/**
 * triage-store.integration.test.ts — the operator inbox-triage store against
 * real Postgres (inbox-tiering-and-message-agent-2026-06-05, P-016/P-006).
 *
 * Validates migration 162's `attention_triage` table + the store's upsert /
 * read / clear SQL against the full migrated schema. Follows the established
 * org-fixture mock pattern (see test/_org-test-db.ts): the runtime store routes
 * through `getOrgPg().sql` as the table owner, so we mock it to the fixture's
 * admin (RLS-bypass) client and mock the workspace resolver.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-triage-test' }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { upsertTriage, readTriageByWorkspace, clearTriage } = await import('./triage-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('attention_triage store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('upserts and reads back a triage record', async () => {
    await upsertTriage({
      itemId: 'coord-escalation:m-1',
      action: 'downgrade',
      note: 'auto lifecycle, not a real decision',
      triagedBy: 'system:operator',
    });
    const map = await readTriageByWorkspace();
    const rec = map.get('coord-escalation:m-1');
    expect(rec).toBeDefined();
    expect(rec!.action).toBe('downgrade');
    expect(rec!.note).toBe('auto lifecycle, not a real decision');
    expect(rec!.triagedBy).toBe('system:operator');
    expect(typeof rec!.triagedAt).toBe('string');
  });

  it('latest triage wins (upsert overwrites)', async () => {
    await upsertTriage({ itemId: 'plan-item:p:P-1', action: 'downgrade', note: 'first', triagedBy: 'op' });
    await upsertTriage({ itemId: 'plan-item:p:P-1', action: 'escalate', note: 'on second look, urgent', triagedBy: 'op' });
    const rec = (await readTriageByWorkspace()).get('plan-item:p:P-1');
    expect(rec!.action).toBe('escalate');
    expect(rec!.note).toBe('on second look, urgent');
  });

  it('clearTriage removes the row', async () => {
    await upsertTriage({ itemId: 'smoke-fail:h', action: 'resolve', note: 'restarted the harness', triagedBy: 'op' });
    expect((await readTriageByWorkspace()).has('smoke-fail:h')).toBe(true);
    await clearTriage('smoke-fail:h');
    expect((await readTriageByWorkspace()).has('smoke-fail:h')).toBe(false);
  });

  it('is workspace-scoped — another workspace\'s triage is not returned', async () => {
    await upsertTriage({ itemId: 'coord-message:x', action: 'confirm', note: null, triagedBy: 'op', workspaceId: 'ws-other' });
    const map = await readTriageByWorkspace(); // default ws = ws-triage-test
    expect(map.has('coord-message:x')).toBe(false);
    const other = await readTriageByWorkspace('ws-other');
    expect(other.has('coord-message:x')).toBe(true);
  });
});
