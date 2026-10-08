/**
 * The idle repair-queue actuator's persistence, against a REAL migrated Postgres (WI-10007476).
 *
 * Why not a mock: the three properties pinned here are all things a fake `sql` tag accepts
 * silently. The per-tick lease is an `ON CONFLICT ... DO UPDATE ... WHERE` that must return NO
 * row to a second host. `escalation` is a TEXT column whose JSON comes back as a STRING, which is
 * how the sibling stranded-queue alarm lost its same-rung dedup. And the self-managed note must
 * keep the real `collectEscalationSignals` query from filing an "Unresolved escalation" bug.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/release/idle-repair-queue-actuator.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  IDLE_PASS_LEASE_MS,
  IDLE_REPAIR_QUEUE_PHASE,
  claimIdleActuatorPass,
  saveIdleActuatorEpisode,
  type IdleQueueEpisode,
} from './idle-repair-queue-actuator';
import { parseEscalationRecord } from './green-stall-watchdog';
import { collectEscalationSignals } from '../harness/improvements/watchdog';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-idle-repair-queue';
const SLUG = 'idle-queue-install';
const T0 = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60_000;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.harness_escalations WHERE workspace_id = ${WS}`;
});

const episode: IdleQueueEpisode = {
  candidate: 'ad82b273dc9c29151e363b11d8b524d993d1b72c',
  idleSinceMs: T0 - 90 * MIN,
  rungs: { 'dispatch-fixer': { atMs: T0, outcome: 'failed', detail: 'dispatcher declined' } },
};
const claim = (nowMs: number) => claimIdleActuatorPass(sql, { installSlug: SLUG, workspaceId: WS, nowMs });

describe('idle repair-queue actuator persistence (real Postgres)', () => {
  it('lets exactly one host run a pass per lease window', async () => {
    expect(await claim(T0)).toEqual({ claimed: true, episode: null }); // first host, fresh row
    expect(await claim(T0 + 1)).toEqual({ claimed: false }); // a second host the same tick
    expect(await claim(T0 + IDLE_PASS_LEASE_MS - 1)).toEqual({ claimed: false });
    expect((await claim(T0 + IDLE_PASS_LEASE_MS)).claimed).toBe(true);
  });

  it('round-trips the episode through the TEXT column, and clears it', async () => {
    await claim(T0);
    await saveIdleActuatorEpisode(sql, { installSlug: SLUG, workspaceId: WS, nowMs: T0, episode });
    const next = await claim(T0 + IDLE_PASS_LEASE_MS);
    expect(next).toEqual({ claimed: true, episode });

    await saveIdleActuatorEpisode(sql, { installSlug: SLUG, workspaceId: WS, nowMs: T0 + 2 * IDLE_PASS_LEASE_MS, episode: null });
    expect(await claim(T0 + 4 * IDLE_PASS_LEASE_MS)).toEqual({ claimed: true, episode: null });
  });

  it('the stored row is self-managed, so the triage watchdog files nothing for it', async () => {
    await claim(T0);
    await saveIdleActuatorEpisode(sql, { installSlug: SLUG, workspaceId: WS, nowMs: T0, episode });
    // Control: an ordinary row in the same workspace IS collected, so an empty result below is
    // the note working, not a query that matches nothing.
    await sql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
      VALUES (${SLUG}, 'control-phase', '{"x":1}', ${T0}, ${WS})`;
    const keys = (await collectEscalationSignals(sql, WS)).map((s) => s.key);
    expect(keys).toContain(`escalation:${SLUG}:control-phase`);
    expect(keys).not.toContain(`escalation:${SLUG}:${IDLE_REPAIR_QUEUE_PHASE}`);
  });

  it('a JSON row read back from the TEXT column is a string that parseEscalationRecord recovers', async () => {
    const stored = { candidate: 'ad82b273', rung: 4, stranded: false };
    await sql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
      VALUES (${SLUG}, 'stranded-repair-queue-watchdog', ${JSON.stringify(stored)}, ${T0}, ${WS})`;
    const [row] = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${SLUG} AND phase = 'stranded-repair-queue-watchdog'`;
    expect(typeof row.escalation).toBe('string'); // the premise of the dedup bug
    expect((row.escalation as { candidate?: string }).candidate).toBeUndefined(); // the old raw read
    expect(parseEscalationRecord<typeof stored>(row.escalation)).toEqual(stored);
    expect(parseEscalationRecord('not json')).toBeNull();
  });
});
