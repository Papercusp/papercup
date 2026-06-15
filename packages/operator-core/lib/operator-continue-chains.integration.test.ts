/**
 * operator-continue-chains.integration.test.ts — the V8 continue-chain ledger
 * (`harness_shared.operator_continue_chains`) against real Postgres. These rows
 * back the deterministic asserts (continue_chain_within_cap, auto_fire_happened,
 * …) in the LLM-testing framework, so the server-side chain-reconstruction logic
 * (extend the recent chain vs mint a new chain_id; resets only when active) needs
 * a real-schema test.
 *
 * The module opens a direct postgres pool via `getHarnessAdminUrl()`, so we mock
 * that to the org-fixture's admin DSN. recordChainEvent is best-effort
 * (console.warn on failure) — the happy paths here never warn.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ dsn: '' }));

vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => h.dsn }));

const { recordChainEvent } = await import('./operator-continue-chains');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('operator_continue_chains ledger (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.dsn = db.adminDsn;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function rowsFor(conversationId: string) {
    return db.adminSql<
      Array<{ chain_id: string; turn_idx: number; trigger: string; elapsed_secs_in_chain: string }>
    >`
      SELECT chain_id, turn_idx, trigger, elapsed_secs_in_chain
        FROM harness_shared.operator_continue_chains
       WHERE conversation_id = ${conversationId}
       ORDER BY started_at, turn_idx`;
  }

  it('a first continue mints a fresh chain at turn_idx 0', async () => {
    const conv = randomUUID();
    const ui = 'ui-a';
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'continue' });
    const rows = await rowsFor(conv);
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_idx).toBe(0);
    expect(rows[0].trigger).toBe('continue');
  });

  it('a follow-up continue EXTENDS the same chain (same chain_id, turn_idx increments)', async () => {
    const conv = randomUUID();
    const ui = 'ui-b';
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'continue' });
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'auto_fire_terminal' });
    const rows = await rowsFor(conv);
    expect(rows).toHaveLength(2);
    expect(rows[0].chain_id).toBe(rows[1].chain_id); // same chain
    expect(rows[1].turn_idx).toBe(1);
    expect(rows[1].trigger).toBe('auto_fire_terminal');
  });

  it('a reset on an active chain writes a reset row that closes it', async () => {
    const conv = randomUUID();
    const ui = 'ui-c';
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'continue' });
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'reset' });
    const rows = await rowsFor(conv);
    expect(rows).toHaveLength(2);
    expect(rows[1].trigger).toBe('reset');
    expect(rows[1].turn_idx).toBe(1);
  });

  it('a reset with NO active chain is a no-op (keeps the ledger lean)', async () => {
    const conv = randomUUID();
    await recordChainEvent({ conversationId: conv, uiClientId: 'ui-d', trigger: 'reset' });
    expect(await rowsFor(conv)).toHaveLength(0);
  });

  it('after a reset, a new continue mints a DIFFERENT chain_id', async () => {
    const conv = randomUUID();
    const ui = 'ui-e';
    // Small gaps so started_at (now() = statement time) is strictly ordered —
    // the chain head lookup is ORDER BY started_at DESC, turn_idx DESC.
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'continue' });
    await new Promise((r) => setTimeout(r, 15));
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'reset' });
    await new Promise((r) => setTimeout(r, 15));
    await recordChainEvent({ conversationId: conv, uiClientId: ui, trigger: 'continue' });
    const rows = await rowsFor(conv);
    expect(rows).toHaveLength(3);
    // rows[0]/rows[1] are the first chain (continue, reset); rows[2] is a fresh chain
    expect(rows[0].chain_id).toBe(rows[1].chain_id); // reset extends the original chain
    expect(rows[2].chain_id).not.toBe(rows[0].chain_id); // fresh continue = new chain
    expect(rows[2].trigger).toBe('continue');
    expect(rows[2].turn_idx).toBe(0);
  });

  it('separate ui_client_ids in the same conversation are independent chains', async () => {
    const conv = randomUUID();
    await recordChainEvent({ conversationId: conv, uiClientId: 'tab-1', trigger: 'continue' });
    await recordChainEvent({ conversationId: conv, uiClientId: 'tab-2', trigger: 'continue' });
    const rows = await rowsFor(conv);
    expect(rows).toHaveLength(2);
    expect(rows[0].chain_id).not.toBe(rows[1].chain_id);
    expect(rows.every((r) => r.turn_idx === 0)).toBe(true);
  });
});
