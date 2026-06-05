/**
 * operator-report-source.integration.test.ts — the operator-report attention
 * source against real Postgres (report-cards-inbox-reconciliation-2026-06-05,
 * P-003/P-004).
 *
 * Validates the windowed, workspace-scoped read over
 * `operator_turns.report` (migration 160; partial index 169) plus the
 * end-to-end composition the reader performs: rows → reportTurnsToAttention
 * → triage overlay (resolve → handled). Follows the established org-fixture
 * mock pattern (see triage-store.integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-report-test' }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { readRecentOperatorReports } = await import('./operator-report-source');
const { reportTurnsToAttention } = await import('./sources');
const { upsertTriage, readTriageByWorkspace } = await import('./triage-store');
const { applyTriage } = await import('./types');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const NOW = 1_900_000_000_000; // fixed epoch-ms anchor for deterministic windows

type Sql = (strings: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>;

describe('operator-report source (real PG)', () => {
  let db: OrgTestDb;
  let convId: string;
  let otherConvId: string;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql as unknown as Sql;

    const mkConv = async (ws: string): Promise<string> => {
      const rows = (await sql`
        INSERT INTO harness_shared.operator_conversations (workspace_id, started_at)
        VALUES (${ws}, ${NOW - 10_000})
        RETURNING id
      `) as { id: string }[];
      return rows[0]!.id;
    };
    convId = await mkConv(h.ws);
    otherConvId = await mkConv('ws-other');

    const insertTurn = async (
      conv: string,
      seq: number,
      role: string,
      report: unknown,
      createdAt: number,
      text = 'say text',
    ) => {
      await sql`
        INSERT INTO harness_shared.operator_turns
          (conversation_id, seq, role, text, created_at, report)
        VALUES (${conv}, ${seq}, ${role}, ${text}, ${createdAt},
                ${report === null ? null : JSON.stringify(report)}::jsonb)
      `;
    };

    const rep = (title: string, status = 'active') => ({
      plans: [{ title, status }],
    });

    // In-window assistant turns with reports (the ones that should surface).
    await insertTurn(convId, 1, 'assistant', rep('Plan A'), NOW - 3_600_000, 'older say');
    await insertTurn(convId, 2, 'assistant', rep('Plan B', 'needs-human'), NOW - 60_000, 'newer say');
    // Report-less assistant turn — excluded by the predicate.
    await insertTurn(convId, 3, 'assistant', null, NOW - 30_000);
    // User turn carrying a report-shaped payload — excluded by role.
    await insertTurn(convId, 4, 'user', rep('User noise'), NOW - 20_000);
    // Outside the 48h window — excluded by the cutoff.
    await insertTurn(convId, 5, 'assistant', rep('Stale'), NOW - 72 * 3_600_000);
    // Another workspace — excluded by the join scope.
    await insertTurn(otherConvId, 1, 'assistant', rep('Foreign'), NOW - 60_000);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('returns only in-window, report-carrying assistant turns for the workspace, newest first', async () => {
    const rows = await readRecentOperatorReports({ nowMs: NOW });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('newer say');
    expect(rows[1]!.text).toBe('older say');
    expect(rows[0]!.conversationId).toBe(convId);
    expect(rows[0]!.createdAt).toBe(NOW - 60_000);
  });

  it('honors the limit (newest kept)', async () => {
    const rows = await readRecentOperatorReports({ nowMs: NOW, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('newer say');
  });

  it('composes to attention items and the triage overlay resolves to handled (reader path)', async () => {
    const rows = await readRecentOperatorReports({ nowMs: NOW });
    const items = reportTurnsToAttention(rows);
    expect(items).toHaveLength(2);
    const decision = items[0]!;
    expect(decision.tier).toBe('decision'); // Plan B is needs-human
    expect(decision.report?.plans[0]?.title).toBe('Plan B');

    // The human resolves it from the inbox → standard triage machinery.
    await upsertTriage({
      itemId: decision.id,
      action: 'resolve',
      note: 'reviewed',
      triagedBy: 'human',
    });
    const triage = await readTriageByWorkspace();
    const rec = triage.get(decision.id);
    expect(rec).toBeDefined();
    const handled = applyTriage(decision, rec!);
    expect(handled.tier).toBe('handled');
    expect(handled.needsHuman).toBe(false);
  });
});
