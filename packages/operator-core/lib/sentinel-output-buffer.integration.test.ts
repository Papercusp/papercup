/**
 * sentinel-output-buffer.integration.test.ts — the cross-process voice-OUT FIFO
 * (`harness_shared.sentinel_says`, migration 390) against real migrated PG.
 *
 * Proves the round-trip the Sentinel↔webview voice-out seam needs: a push in one
 * process (the agent-mcp host where `voice:say` runs) is drained by another (the
 * webview's operator), because both share the database. Follows the org-fixture
 * pattern (test/_org-test-db.ts): mock getOrgPg onto the fixture's admin client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { pushSentinelSay, drainSentinelSays } = await import('./sentinel-output-buffer');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('sentinel_says voice-out FIFO (real PG, migration 390)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  afterEach(async () => {
    await drainSentinelSays(); // leave the table empty between cases
  });

  it('pushes then drains in FIFO order, then is empty', async () => {
    await pushSentinelSay('first line');
    await pushSentinelSay('second line');
    expect(await drainSentinelSays()).toEqual(['first line', 'second line']);
    // Drained — a second poll sees nothing.
    expect(await drainSentinelSays()).toEqual([]);
  });

  it('no-ops on blank/whitespace input', async () => {
    await pushSentinelSay('');
    await pushSentinelSay('   ');
    expect(await drainSentinelSays()).toEqual([]);
  });

  it('trims leading/trailing whitespace on stored lines', async () => {
    await pushSentinelSay('  spoken  ');
    expect(await drainSentinelSays()).toEqual(['spoken']);
  });

  it('bounds the queue to the most-recent 32 lines', async () => {
    for (let i = 1; i <= 37; i++) await pushSentinelSay(`line ${i}`);
    const drained = await drainSentinelSays();
    expect(drained).toHaveLength(32);
    // The 5 oldest were dropped; the survivors are 6..37 in order.
    expect(drained[0]).toBe('line 6');
    expect(drained[drained.length - 1]).toBe('line 37');
  });

  it('survives a value containing SQL-significant characters (parameterized)', async () => {
    const tricky = `O'Brien said "deploy"; DROP TABLE -- not really`;
    await pushSentinelSay(tricky);
    expect(await drainSentinelSays()).toEqual([tricky]);
  });
});
