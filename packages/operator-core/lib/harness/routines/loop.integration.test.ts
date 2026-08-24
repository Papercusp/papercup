/**
 * loop — the loop surface (B-LOOP-5) proven against a REAL migrated Postgres
 * (testcontainer): materializeLoop writes a routine row the B-LOOP-3 fire consumes,
 * getLoopStatus reads it (incl. the 'infinity' parked sentinel) and deactivateLoop
 * stops it. Exercises the raw SQL the mocked unit test (loop.test.ts) cannot.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/loop.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { SESSION_END_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import {
  materializeLoop,
  getLoopStatus,
  deactivateLoop,
  transferLoopOwnership,
  loopRoutineName,
  autoArmFleetMemberLoop,
  countAgentToolCallsInWindow,
  LOOP_WAKE_ACTION,
} from './loop';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-loop';
const HARNESS = 'papercusp';
const OWNER = 'su-pinned-test';
const NEXT_OWNER = 'su-successor-test';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql; // RLS-bypass; the loop helpers take sql as a seam
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines, harness_shared.carry_notes`;
  await sql`TRUNCATE harness_shared.event_awaits, harness_shared.predicate_watches`;
});

async function rawRow(ownerId: string) {
  const rows = await sql<
    Array<{
      trigger_kind: string;
      trigger_config: Record<string, unknown>;
      target_role: string;
      payload_template: Record<string, unknown> | null;
      active: boolean;
      reschedule_interval_sec: number | null;
      target_owner_id: string | null;
      next_fire_at: Date | null;
    }>
  >`
    SELECT trigger_kind, trigger_config, target_role, payload_template, active,
           reschedule_interval_sec, target_owner_id, next_fire_at
      FROM harness_shared.routines
     WHERE name = ${loopRoutineName(ownerId)}
  `;
  return rows[0] ?? null;
}

describe('loop surface round-trip (real PG)', () => {
  it('materializeLoop writes a PURE loop row the B-LOOP-3 fire consumes', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 120,
      kickoff: 'work the plan',
      costCapCents: 500,
      now,
      sql,
    });

    const r = await rawRow(OWNER);
    expect(r).not.toBeNull();
    expect(r!.trigger_kind).toBe('cron'); // rides listDueCronRoutines + the 30s tick
    expect(r!.trigger_config).toEqual({}); // pure loop ⇒ claim parks at 'infinity'
    expect(r!.target_role).toBe(LOOP_WAKE_ACTION);
    expect(Number(r!.reschedule_interval_sec)).toBe(120);
    expect(r!.target_owner_id).toBe(OWNER);
    expect(r!.active).toBe(true);
    // fire reads kickoff + cost-cap from here
    expect(r!.payload_template).toMatchObject({ kickoff: 'work the plan', costCapCents: 500 });
    // first fire one interval out (finite — the existing claim path fires it)
    expect(r!.next_fire_at?.getTime()).toBe(now.getTime() + 120_000);
  });

  it('getLoopStatus reads an armed loop, and null for an unknown owner', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 300,
      kickoff: 'k',
      costCapCents: 1000,
      now,
      sql,
    });

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      name: loopRoutineName(OWNER),
      ownerId: OWNER,
      harnessSlug: HARNESS,
      active: true,
      intervalSec: 300,
      parked: false,
      costCapCents: 1000,
      carry: 'warm', // default lifecycle (su-cold-auto P-008)
      mode: 'work', // default (WI-5345 observability)
      fireCount: 0, // never fired
    });
    expect(status!.nextFireAt).toBe(new Date(now.getTime() + 300_000).toISOString());

    expect(await getLoopStatus('su-nobody', { sql })).toBeNull();
  });

  it('EI-20313321954782474: transfers the cold carry-note, journal, declared deps, and loop-nag with the routine', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 300,
      kickoff: 'continue from the carry-note',
      goal: 'finish the source objective',
      carry: 'cold',
      sql,
    });
    const sourceCarry = `loop:${HARNESS}:${OWNER}`;
    const targetCarry = `loop:${HARNESS}:${NEXT_OWNER}`;
    const sourceNag = `loopnag:${HARNESS}:${OWNER}`;
    const targetNag = `loopnag:${HARNESS}:${NEXT_OWNER}`;
    const journal = [{ at: 1_700_000_000_000, note: 'earlier source checkpoint' }];
    const deps = { v: 1, stamps: [{ dep: 'work-item:EI-source', token: 'open', at: 1_700_000_000_000 }] };
    await sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts, deps)
      VALUES
        ('default', ${sourceCarry}, 'SOURCE carry-note', ${JSON.stringify(journal)}::text::jsonb,
         1700000000000, ${JSON.stringify(deps)}::text::jsonb),
        ('default', ${targetCarry}, 'STALE destination note', '[]'::jsonb, 1700000001000, NULL),
        ('default', ${sourceNag}, 'source pending-wall nag', '[]'::jsonb, 1700000000000, NULL),
        ('default', ${targetNag}, 'stale destination nag', '[]'::jsonb, 1700000001000, NULL)`;

    await expect(transferLoopOwnership(OWNER, NEXT_OWNER, { sql })).resolves.toMatchObject({
      transferred: true,
    });

    expect(await getLoopStatus(OWNER, { sql })).toBeNull();
    expect(await getLoopStatus(NEXT_OWNER, { sql })).toMatchObject({
      ownerId: NEXT_OWNER,
      carry: 'cold',
      goal: 'finish the source objective',
    });
    const notes = await sql<Array<{ scope: string; note: string; journal: unknown; deps: unknown; updated_ts: number }>>`
      SELECT scope, note, journal, deps, updated_ts
        FROM harness_shared.carry_notes
       WHERE scope IN (${sourceCarry}, ${targetCarry}, ${sourceNag}, ${targetNag})
       ORDER BY (scope = ${targetCarry}) DESC`;
    expect(notes).toEqual([
      {
        scope: targetCarry,
        note: 'SOURCE carry-note',
        journal,
        deps,
        updated_ts: 1_700_000_000_000,
      },
      {
        scope: targetNag,
        note: 'source pending-wall nag',
        journal: [],
        deps: null,
        updated_ts: 1_700_000_000_000,
      },
    ]);
  });

  it('EI-20313321954782474: rolls the routine transfer back when carry-note rekeying fails', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 300,
      kickoff: 'source loop',
      carry: 'cold',
      sql,
    });
    const sourceCarry = `loop:${HARNESS}:${OWNER}`;
    const targetCarry = `loop:${HARNESS}:${NEXT_OWNER}`;
    await sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
      VALUES
        ('default', ${sourceCarry}, 'SOURCE carry-note', '[]'::jsonb, 1700000000000),
        ('default', ${targetCarry}, 'STALE destination note', '[]'::jsonb, 1700000001000)`;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.fail_test_loop_carry_rekey() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope = 'loop:papercusp:su-successor-test' THEN
          RAISE EXCEPTION 'forced carry-note rekey failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER fail_test_loop_carry_rekey
        BEFORE UPDATE OF scope ON harness_shared.carry_notes
        FOR EACH ROW EXECUTE FUNCTION public.fail_test_loop_carry_rekey();
    `);

    try {
      await expect(transferLoopOwnership(OWNER, NEXT_OWNER, { sql })).rejects.toThrow(
        'forced carry-note rekey failure',
      );
    } finally {
      await sql`DROP TRIGGER IF EXISTS fail_test_loop_carry_rekey ON harness_shared.carry_notes`;
      await sql`DROP FUNCTION IF EXISTS public.fail_test_loop_carry_rekey()`;
    }

    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({ ownerId: OWNER, carry: 'cold' });
    expect(await getLoopStatus(NEXT_OWNER, { sql })).toBeNull();
    const notes = await sql<Array<{ scope: string; note: string }>>`
      SELECT scope, note FROM harness_shared.carry_notes
       WHERE scope IN (${sourceCarry}, ${targetCarry}) ORDER BY scope`;
    expect(notes).toEqual([
      { scope: sourceCarry, note: 'SOURCE carry-note' },
      { scope: targetCarry, note: 'STALE destination note' },
    ]);
  });

  it('EI-19316779460752535: lastRealTurnAt sees an ordinary assistant turn with NO journal row — and still excludes the session-end marker (WI-6951)', async () => {
    // WHY THIS EXISTS: `last_real_turn_at` was sourced from session_turn_journal ALONE, on
    // WI-6069's premise that the Stop hook journals EVERY ordinary turn. It does not —
    // `journal:record-turn` writes only when the turn text carries an extractable note
    // (measured 2026-08-02: 17 rows vs 750 assistant turns for one owner, 2.3%). So the
    // field — and the cold-wake staleness hint that is its only consumer — was silent for
    // the ~98% of turns that produce no journal row. The fix unions in session_turns'
    // assistant turns; this test pins BOTH halves: the new coverage, and the WI-6951
    // exclusion it must not undo.
    await sql`TRUNCATE harness_shared.session_turns CASCADE`;
    await sql`TRUNCATE harness_shared.session_turn_journal`;
    await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id = ${OWNER}`;
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });

    // No journal row anywhere — the ~98% case. Only an ordinary ingested assistant turn.
    const realTurn = new Date('2026-06-20T00:05:00.000Z');
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text)
      VALUES (${WS}, 'claude', 'sess-1', 1, ${realTurn.toISOString()}::timestamptz,
              ${OWNER}, ${HARNESS}, 'assistant', 'ordinary turn, no journal note')`;

    expect((await getLoopStatus(OWNER, { sql }))!.lastRealTurnAt).toBe(realTurn.toISOString());

    // TEETH, pinned rather than argued: the expression this REPLACED, run against the very
    // same rows. It returns NULL — so the assertion above genuinely fails without the fix,
    // and this stays true for anyone who later narrows the source back to the journal.
    const journalOnly = await sql<Array<{ ts: Date | null }>>`
      SELECT max(j.created_at) AS ts FROM harness_shared.session_turn_journal j
       WHERE j.owner_id = ${OWNER}`;
    expect(journalOnly[0]?.ts ?? null).toBeNull();

    // A LATER user turn is a wake injection, not a completed turn — it must not advance it.
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text)
      VALUES (${WS}, 'claude', 'sess-1', 2, ${'2026-06-20T00:09:00.000Z'}::timestamptz,
              ${OWNER}, ${HARNESS}, 'user', '❄️ COLD LOOP WAKE (fire #59)')`;

    expect((await getLoopStatus(OWNER, { sql }))!.lastRealTurnAt).toBe(realTurn.toISOString());

    // WI-6951's whole point: the '■ session ended' lifecycle marker is a session DEATH, not a
    // turn. A cold reset kills its predecessor, so the marker lands AFTER the final
    // loop:checkpoint — reporting it as a completed turn is what made the staleness hint
    // advertise phantom post-note work. Widening the source must not resurrect that.
    await sql`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, kind, summary, created_at)
      VALUES (${WS}, ${OWNER}, 'lifecycle', ${SESSION_END_MARKER},
              ${'2026-06-20T00:35:00.000Z'}::timestamptz)`;

    const afterDeath = await getLoopStatus(OWNER, { sql });
    expect(afterDeath!.lastRealTurnAt).toBe(realTurn.toISOString()); // marker EXCLUDED
    expect(afterDeath!.lastTurnAt).toBe(new Date('2026-06-20T00:35:00.000Z').toISOString()); // union INCLUDES it
  });

  it('WI-6639 regression: a continuously-WARM loop (no lifecycle marker, no journal note) must NOT read turnsStalled — caught LIVE by dry-running stalled-loops-guard against this session\'s own real loop before it shipped', async () => {
    // The exact live shape this closes: `carry:'warm'` never restarts, so the lifecycle
    // 'ended' marker never fires for it; `journal:record-turn` covers only ~2.3% of turns
    // (EI-19316779460752535), so the journal leg is also silent. Before this fix, BOTH legs
    // of last_turn_at were empty for this (dominant) population despite the session
    // genuinely, continuously producing real turns.
    await sql`TRUNCATE harness_shared.session_turns CASCADE`;
    await sql`TRUNCATE harness_shared.session_turn_journal`;
    await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id = ${OWNER}`;
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k', sql });

    // Relative to REAL now (computeTurnsStalled defaults its nowMs to Date.now() when fed
    // from a live row) so this test is not fragile to when it happens to run: many fires,
    // most recently 2 minutes ago; a genuine assistant turn 5 minutes before THAT fire —
    // well inside the 30-min stall floor either way, no journal row, no lifecycle marker.
    const lastFired = new Date(Date.now() - 2 * 60_000);
    const recentTurn = new Date(lastFired.getTime() - 5 * 60_000);
    await sql`
      UPDATE harness_shared.routines
         SET last_fired_at = ${lastFired.toISOString()}::timestamptz,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'fire_count', 209,
               'armed_at', ${new Date(recentTurn.getTime() - 60_000).toISOString()}::text
             )
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text,
         turn_origin, turn_origin_verdict, turn_origin_classifier_version)
      VALUES
        (${WS}, 'claude', 'sess-1', 0, ${new Date(recentTurn.getTime() - 1000).toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'user', '⟦turn-origin:loop-fire nonce:fedcba9876543210⟧ wake',
         'loop-fire', 'agent-injected', 1),
        (${WS}, 'claude', 'sess-1', 1, ${recentTurn.toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'assistant', 'ordinary turn, no journal note', NULL, 'not-user-turn', 1)`;

    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.fireCount).toBe(209);
    // TEETH: without the session_turns leg this fix adds, lastTurnAt would be NULL here
    // (no journal row, no lifecycle marker) and computeTurnsStalled's "no turn has EVER
    // completed" branch would fire unconditionally — flagging a genuinely healthy,
    // actively-working loop as turnsStalled:true. This is not hypothetical: it is exactly
    // what a live dry-run of stalled-loops-guard reported for this session's own loop
    // (WI-6639) before this fix landed.
    expect(status!.lastTurnAt).toBe(recentTurn.toISOString());
    expect(status!.turnsStalled).toBe(false);
  });

  it('EI-21303383797798186: only a completed loop-origin turn clears turnsStalled; manual assistant output does not', async () => {
    await sql`TRUNCATE harness_shared.session_turns CASCADE`;
    await sql`TRUNCATE harness_shared.session_turn_journal`;
    await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id = ${OWNER}`;
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k', sql });

    const lastFired = new Date(Date.now() - 2 * 60_000);
    const manualTurn = new Date(lastFired.getTime() + 30_000);
    await sql`
      UPDATE harness_shared.routines
         SET last_fired_at = ${lastFired.toISOString()}::timestamptz,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'fire_count', 5,
               'armed_at', ${new Date(lastFired.getTime() - 10 * 60_000).toISOString()}::text
             )
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text,
         turn_origin, turn_origin_verdict, turn_origin_classifier_version)
      VALUES
        (${WS}, 'codex', 'manual-session', 0, ${new Date(manualTurn.getTime() - 1000).toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'user', 'owner asks for status', NULL, 'owner-typed', 1),
        (${WS}, 'codex', 'manual-session', 1, ${manualTurn.toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'assistant', 'status response', NULL, 'not-user-turn', 1)
    `;

    const maskedBefore = await getLoopStatus(OWNER, { sql });
    expect(maskedBefore!.lastTurnAt).toBe(manualTurn.toISOString());
    expect(maskedBefore!.lastLoopTurnAt).toBeNull();
    expect(maskedBefore!.turnsStalled).toBe(true);

    const loopPrompt = new Date(manualTurn.getTime() + 10_000);
    const loopAssistant = new Date(loopPrompt.getTime() + 20_000);
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text,
         turn_origin, turn_origin_verdict, turn_origin_classifier_version)
      VALUES
        (${WS}, 'codex', 'loop-session', 0, ${loopPrompt.toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'user', '⟦turn-origin:loop-fire nonce:0123456789abcdef⟧ wake',
         'loop-fire', 'agent-injected', 1),
        (${WS}, 'codex', 'loop-session', 1, ${loopAssistant.toISOString()}::timestamptz,
         ${OWNER}, ${HARNESS}, 'assistant', 'autonomous loop work completed', NULL, 'not-user-turn', 1)
    `;

    const recovered = await getLoopStatus(OWNER, { sql });
    expect(recovered!.lastLoopTurnAt).toBe(loopAssistant.toISOString());
    expect(recovered!.turnsStalled).toBe(false);
  });

  it('getLoopStatus surfaces carry:"cold" for a cold-armed loop (su-cold-auto P-008 observability)', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      carry: 'cold',
      sql,
    });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ carry: 'cold', fireCount: 0 });
  });

  it("WI-5345: getLoopStatus surfaces mode:'monitor' for a monitor-armed loop (leader-brief observability)", async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      mode: 'monitor',
      sql,
    });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ mode: 'monitor', fireCount: 0 });
  });

  it("getLoopStatus reports parked=true (and nextFireAt=null) when the loop is in-flight ('infinity')", async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    // Simulate claim.ts parking the loop while its turn runs.
    await sql`
      UPDATE harness_shared.routines
         SET next_fire_at = 'infinity'::timestamptz
       WHERE name = ${loopRoutineName(OWNER)}
    `;

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status!.parked).toBe(true);
    expect(status!.nextFireAt).toBeNull(); // never hand a NaN-Date out
    expect(status!.active).toBe(true); // a parked loop is still armed
  });

  it('EI-16202: armedAt advances on every re-arm even while fireCount/lastFiredAt/parked legitimately stay unchanged (distinguishes a real re-arm from a no-op)', async () => {
    const t0 = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k', now: t0, sql });

    const first = await getLoopStatus(OWNER, { sql });
    expect(first!.armedAt).not.toBeNull();
    expect(first!.fireCount).toBe(0);
    expect(first!.lastFiredAt).toBeNull();

    // Simulate the exact repro: the loop's turn is in flight (parked at 'infinity',
    // the claim.ts sentinel) — e.g. a re-arm called from WITHIN the loop's own
    // in-flight turn, or a re-arm racing a stuck/never-completion-rebased park.
    await sql`
      UPDATE harness_shared.routines
         SET next_fire_at = 'infinity'::timestamptz
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    const parked = await getLoopStatus(OWNER, { sql });
    expect(parked!.parked).toBe(true);

    // Re-arm while parked (materializeLoop's CASE deliberately preserves 'infinity'
    // here — EI-6878 — so parked/fireCount/lastFiredAt are UNCHANGED, which is the
    // exact observation the bug report couldn't distinguish from "the arm no-op'd").
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    await materializeLoop({ workspaceId: WS, harnessSlug: HARNESS, ownerId: OWNER, intervalSec: 60, kickoff: 'k2', now: t1, sql });

    const second = await getLoopStatus(OWNER, { sql });
    expect(second!.parked).toBe(true); // legitimately unchanged (EI-6878)
    expect(second!.fireCount).toBe(0); // legitimately unchanged — no fire happened
    expect(second!.lastFiredAt).toBeNull(); // legitimately unchanged
    // ...but armedAt DOES move — proof the re-arm actually touched the row.
    expect(second!.armedAt).not.toBeNull();
    expect(new Date(second!.armedAt!).getTime()).toBeGreaterThan(new Date(first!.armedAt!).getTime());
    expect(new Date(second!.armedAt!).getTime()).toBe(t1.getTime());
  });

  it('EI-21207093794475760: an inactive-only repair cannot clobber an explicit active 1200-second arm', async () => {
    const explicitGoal = 'continue the fleet monitor at the widened fallback cadence';
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 1200,
      kickoff: 'explicit monitor kickoff',
      goal: explicitGoal,
      mode: 'monitor',
      sql,
    });

    // Model the stale leader-control repair: it still carries the old 60-second
    // defaults, but its row lock is acquired after the explicit arm committed.
    const staleRepair = await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'stale leader-control kickoff',
      mode: 'monitor',
      onlyIfInactive: true,
      sql,
    });

    expect(staleRepair.changed).toBe(false);
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({
      active: true,
      intervalSec: 1200,
      mode: 'monitor',
      goal: explicitGoal,
    });
  });

  it('EI-21269207450101133: inactive-only repair loses the stale-read race to an explicit arm', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'initial leader-control loop',
      sql,
    });
    expect(await deactivateLoop(OWNER, { sql })).toBe(true);

    let releaseRepair!: () => void;
    const repairMayWrite = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let repairReadResolve!: () => void;
    const repairRead = new Promise<void>((resolve) => {
      repairReadResolve = resolve;
    });
    let interceptedRepairRead = false;
    const repairSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const queryText = strings.join(' ');
      const taggedSql = sql as unknown as (
        template: TemplateStringsArray,
        ...parameters: readonly unknown[]
      ) => PromiseLike<unknown[]>;
      const result = taggedSql(strings, ...values);
      if (!interceptedRepairRead && queryText.includes('harness_shared.routines') && queryText.includes('FOR UPDATE')) {
        interceptedRepairRead = true;
        return result.then(async (rows) => {
          repairReadResolve();
          await repairMayWrite;
          return rows;
        });
      }
      return result;
    }) as unknown as Sql;

    const staleRepairPromise = materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'stale leader-control loop',
      mode: 'monitor',
      onlyIfInactive: true,
      sql: repairSql,
    });
    await repairRead;

    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 1200,
      kickoff: 'explicit leader loop',
      goal: 'preserve this explicit leader mission',
      mode: 'monitor',
      sql,
    });
    releaseRepair();

    const staleRepair = await staleRepairPromise;
    expect(staleRepair.changed).toBe(false);
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({
      active: true,
      intervalSec: 1200,
      mode: 'monitor',
      goal: 'preserve this explicit leader mission',
    });
  });

  it('deactivateLoop stops the loop (idempotent on the active guard)', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });

    expect(await deactivateLoop(OWNER, { sql })).toBe(true);
    const after = await getLoopStatus(OWNER, { sql });
    expect(after!.active).toBe(false);

    // Already inactive ⇒ no row matches the active=TRUE guard ⇒ false (no double-stop).
    expect(await deactivateLoop(OWNER, { sql })).toBe(false);

    // Unknown owner ⇒ false.
    expect(await deactivateLoop('su-nobody', { sql })).toBe(false);
  });

  it('EI-21178284518430314: loop:end retires fleet leadership watches even when already inactive', async () => {
    const fleet = { kind: 'fleet-leadership', ref: 'fleet-alpha' };
    const other = { kind: 'work-item-claim', ref: 'WI-1' };
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    await sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, once, bound_to)
      VALUES
        ('default', ${OWNER}, 'fleet:member-dead:fleet-alpha', false, ${JSON.stringify(fleet)}::text::jsonb),
        ('default', ${OWNER}, 'work-item:claim:WI-1', false, ${JSON.stringify(other)}::text::jsonb)`;
    await sql`
      INSERT INTO harness_shared.predicate_watches
        (owner_id, event_key, tool, path, op, once, bound_to)
      VALUES
        (${OWNER}, 'predicate:fleet-alpha', 'fake:read', 'value', 'gt', false, ${JSON.stringify(fleet)}::text::jsonb),
        (${OWNER}, 'predicate:WI-1', 'fake:read', 'value', 'gt', false, ${JSON.stringify(other)}::text::jsonb)`;

    expect(await deactivateLoop(OWNER, { sql })).toBe(true);
    expect(
      await sql<{ event_key: string; cancelled_at: Date | null }[]>`
        SELECT event_key, cancelled_at
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${OWNER}
         ORDER BY event_key`,
    ).toEqual([
      { event_key: 'fleet:member-dead:fleet-alpha', cancelled_at: expect.any(Date) },
      { event_key: 'work-item:claim:WI-1', cancelled_at: null },
    ]);
    expect(
      await sql<{ event_key: string; active: boolean }[]>`
        SELECT event_key, active
          FROM harness_shared.predicate_watches
         WHERE owner_id = ${OWNER}
         ORDER BY event_key`,
    ).toEqual([
      { event_key: 'predicate:fleet-alpha', active: false },
      { event_key: 'predicate:WI-1', active: true },
    ]);

    // Re-seed a fleet watch after the row is inactive: loop:end must still clean
    // the predecessor's residue even though the routine UPDATE returns no row.
    await sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, once, bound_to)
      VALUES ('default', ${OWNER}, 'fleet:member-dead:fleet-alpha-2', false,
              ${JSON.stringify({ kind: 'fleet-leadership', ref: 'fleet-alpha-2' })}::text::jsonb)`;
    expect(await deactivateLoop(OWNER, { sql })).toBe(false);
    expect(
      await sql<{ cancelled_at: Date | null }[]>`
        SELECT cancelled_at
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${OWNER}
           AND event_key = 'fleet:member-dead:fleet-alpha-2'`,
    ).toEqual([{ cancelled_at: expect.any(Date) }]);
  });

  it('EI-3748: deactivateLoop clears a stale last_error stamp — the routine can no longer fire, so a residual error is moot', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    // Simulate what dbos-executor-reaper.ts stamps on a stuck-fire auto-requeue.
    await sql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'last_error', 'DBOS routineFire produced no DBOS operation output',
               'last_error_at', now()::text,
               'last_error_source', 'dbos-executor-reaper'
             )
       WHERE name = ${loopRoutineName(OWNER)}
    `;
    const before = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}`;
    expect(before[0]!.metadata.last_error).toBeTruthy();

    expect(await deactivateLoop(OWNER, { sql })).toBe(true);

    const after = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}`;
    expect(after[0]!.metadata.last_error).toBeUndefined();
    expect(after[0]!.metadata.last_error_at).toBeUndefined();
    expect(after[0]!.metadata.last_error_source).toBeUndefined();
  });

  it('omits costCapCents from payload_template (and status) when no cap given', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'k',
      sql,
    });
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toEqual({ kickoff: 'k' });
    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.costCapCents).toBeNull();
  });

  it('re-arming the same owner upserts the ONE row (new interval + kickoff)', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ n: string }>>`
      SELECT name AS n FROM harness_shared.routines WHERE name = ${loopRoutineName(OWNER)}
    `;
    expect(rows.length).toBe(1); // upsert, not a second row
    const status = await getLoopStatus(OWNER, { sql });
    expect(status!.intervalSec).toBe(600);
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toMatchObject({ kickoff: 'second' });
  });

  it('WI-3179: re-arming the same owner under a different harness updates the one logical loop row', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: '*',
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ install_slug: string; active: boolean }>>`
      SELECT install_slug, active
        FROM harness_shared.routines
       WHERE name = ${loopRoutineName(OWNER)}
       ORDER BY updated_at DESC
    `;
    expect(rows).toEqual([{ install_slug: '*', active: true }]);

    const status = await getLoopStatus(OWNER, { sql });
    expect(status).toMatchObject({ harnessSlug: '*', intervalSec: 600, active: true });
    const r = await rawRow(OWNER);
    expect(r!.payload_template).toMatchObject({ kickoff: 'second' });
  });

  it('WI-3179: re-arm coalesces pre-existing active shadow rows for the same owner loop', async () => {
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OWNER,
      intervalSec: 60,
      kickoff: 'first',
      sql,
    });
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, next_fire_at, workspace_id,
         reschedule_interval_sec, target_owner_id)
      VALUES (
        'rt_shadow_loop',
        '*',
        ${loopRoutineName(OWNER)},
        'cron',
        '{}'::jsonb,
        ${LOOP_WAKE_ACTION},
        '{"kickoff":"shadow"}'::jsonb,
        'skip',
        'skip-old',
        true,
        now(),
        ${WS},
        120,
        ${OWNER}
      )
    `;

    await materializeLoop({
      workspaceId: WS,
      harnessSlug: '*',
      ownerId: OWNER,
      intervalSec: 600,
      kickoff: 'second',
      sql,
    });

    const rows = await sql<Array<{ install_slug: string; active: boolean; payload_template: Record<string, unknown> }>>`
      SELECT install_slug, active, payload_template
        FROM harness_shared.routines
       WHERE name = ${loopRoutineName(OWNER)}
       ORDER BY active DESC, install_slug
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ install_slug: '*', active: true, payload_template: { kickoff: 'second' } });
    expect(rows[1]).toMatchObject({ install_slug: HARNESS, active: false });
    expect(await getLoopStatus(OWNER, { sql })).toMatchObject({ harnessSlug: '*', intervalSec: 600, active: true });
  });
});

describe('autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001, real PG)', () => {
  const MEMBER_OWNER = 'su-fleet-member-test';
  const PLAN_SLUG = 'backlog-drain-2026-07-16';
  const FLEET_SLUG = 'backlog-drain';

  it('arms a fresh member/plan-bound member: a real routine row lands and getLoopStatus reads it back active', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res.armed).toBe(true);
    expect(res.reason).toBe('armed');
    expect(res.loopName).toBe(loopRoutineName(MEMBER_OWNER));

    const status = await getLoopStatus(MEMBER_OWNER, { sql });
    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      name: loopRoutineName(MEMBER_OWNER),
      ownerId: MEMBER_OWNER,
      active: true,
      intervalSec: 60, // LOOP_INTERVAL_FLOOR_SEC — the AUTO-mode standing default
    });
    const r = await rawRow(MEMBER_OWNER);
    expect(r!.payload_template!.kickoff).toContain(PLAN_SLUG);
    expect(r!.payload_template!.kickoff).toContain(FLEET_SLUG);
    expect(r!.payload_template!.goal).toBe(
      `Drive plan \`${PLAN_SLUG}\` per your member role in fleet \`${FLEET_SLUG}\` (coord:orient to pull your lane).`,
    );
    expect((await getLoopStatus(MEMBER_OWNER, { sql }))!.goal).toBe(r!.payload_template!.goal);
  });

  it('is idempotent: calling it again against the now-active loop reports already-armed and does NOT mutate the row', async () => {
    await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    const before = await rawRow(MEMBER_OWNER);

    const second = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: MEMBER_OWNER,
      harnessSlug: HARNESS,
      // A different plan/fleet on the second call — proves the existing armed
      // loop is left COMPLETELY untouched (never re-derives a new goal/kickoff),
      // not merely that a second call is a same-input no-op.
      planSlug: 'some-other-plan',
      fleetSlug: 'some-other-fleet',
      fleetRole: 'member',
      sql,
    });
    expect(second).toEqual({ armed: false, reason: 'already-armed', loopName: loopRoutineName(MEMBER_OWNER) });

    const after = await rawRow(MEMBER_OWNER);
    expect(after).toEqual(before); // byte-identical — never clobbered
  });

  it('never arms a fleet LEADER, and never touches the routines table for one', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: 'su-fleet-leader-test',
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'leader',
      sql,
    });
    expect(res).toEqual({ armed: false, reason: 'not-a-member' });
    expect(await getLoopStatus('su-fleet-leader-test', { sql })).toBeNull();
  });

  it('never arms an unplanned member (no plan to derive a goal from)', async () => {
    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: 'su-unplanned-member-test',
      harnessSlug: HARNESS,
      planSlug: null,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res).toEqual({ armed: false, reason: 'no-plan-bound' });
    expect(await getLoopStatus('su-unplanned-member-test', { sql })).toBeNull();
  });

  it("re-arming a DIFFERENT member's own existing loop after loop:end (inactive) re-activates it, not merely already-armed", async () => {
    // First arm normally, then end it (mirrors a member self-retuning: loop:end + re-arm) —
    // autoArmFleetMemberLoop should treat an INACTIVE existing loop as armable, not as a
    // live clobber target (only an ACTIVE loop short-circuits).
    const OTHER = 'su-fleet-member-reended-test';
    await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: OTHER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(await deactivateLoop(OTHER, { sql })).toBe(true);
    expect((await getLoopStatus(OTHER, { sql }))!.active).toBe(false);

    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: OTHER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });
    expect(res.armed).toBe(true);
    expect((await getLoopStatus(OTHER, { sql }))!.active).toBe(true);

    const expectedGoal =
      `Drive plan \`${PLAN_SLUG}\` per your member role in fleet \`${FLEET_SLUG}\` (coord:orient to pull your lane).`;
    expect((await rawRow(OTHER))!.payload_template!.goal).toBe(expectedGoal);

    // A member retune/reset can omit goal while changing cadence and kickoff. The
    // durable mission must survive that lower-level re-arm path as well.
    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OTHER,
      intervalSec: 120,
      kickoff: 'member reset retained goal',
      sql,
    });
    const retained = await rawRow(OTHER);
    expect(retained!.payload_template).toMatchObject({ kickoff: 'member reset retained goal', goal: expectedGoal });
    expect((await getLoopStatus(OTHER, { sql }))!.goal).toBe(expectedGoal);
  });

  it('EI-21206138277595747: inactive recovery preserves an explicit cadence and lifecycle payload', async () => {
    const OTHER = 'su-fleet-member-inactive-config-test';
    const priorGoal = 'continue the monitor at the widened fallback cadence';
    const priorKickoff = '⏸ BACKOFF PREMISE — re-check the release gate before proceeding';

    await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId: OTHER,
      intervalSec: 1200,
      kickoff: priorKickoff,
      customWakePrompt: true,
      goal: priorGoal,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
      sql,
    });
    await deactivateLoop(OTHER, { sql });

    expect(await getLoopStatus(OTHER, { sql })).toMatchObject({
      active: false,
      intervalSec: 1200,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
      goal: priorGoal,
    });

    const res = await autoArmFleetMemberLoop({
      workspaceId: WS,
      ownerId: OTHER,
      harnessSlug: HARNESS,
      planSlug: PLAN_SLUG,
      fleetSlug: FLEET_SLUG,
      fleetRole: 'member',
      sql,
    });

    expect(res).toEqual({ armed: true, reason: 'armed', loopName: loopRoutineName(OTHER) });
    expect(await getLoopStatus(OTHER, { sql })).toMatchObject({
      active: true,
      intervalSec: 1200,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
      goal: priorGoal,
    });
    expect((await rawRow(OTHER))!.payload_template).toMatchObject({
      kickoff: priorKickoff,
      customWakePrompt: true,
      goal: priorGoal,
      carry: 'cold',
      continuation: 'gated',
      mode: 'monitor',
    });
  });
});

/**
 * EI-20543456503122446 — the cold-wake bounced-fire guard's evidence check, against REAL
 * SQL. The mocked unit test (loop.test.ts) canNOT prove this: its fake `sql` returns a
 * canned count without ever executing the predicate, which is exactly why every one of
 * those tests stayed green for the whole time the guard was structurally dead.
 *
 * The bug: countAgentToolCallsInWindow's window opens at the carry note's `updated_at`,
 * but a tool_invocations row is stamped at INSERT — after the handler's write commits — so
 * the loop:checkpoint that WROTE the note lands inside the window and counted ITSELF. Any
 * session that checkpointed and then died scored >= 1, so the `0` downgrade that suppresses
 * a false "un-checkpointed work" alarm could never fire.
 */
describe('countAgentToolCallsInWindow — carry-note bookkeeping exclusion (EI-20543456503122446)', () => {
  const EV_OWNER = 'su-evidence-window-test';
  // The window under test, mirroring the real caller: (noteUpdatedAt, lastTurnAt].
  const SINCE = Date.parse('2026-08-15T18:20:06.840Z');
  const UNTIL = Date.parse('2026-08-15T18:35:00.000Z');

  async function seedCall(
    toolName: string,
    atIso: string,
    callOrigin: string | null = 'agent',
  ) {
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role,
         spawn_id, window_key, status, coord_owner_id, invoked_at, call_origin)
      VALUES (${WS}, ${HARNESS}, 'papercusp-su', ${toolName}, 'su',
              'spawn-ev', 'win-ev', 'ok', ${EV_OWNER}, ${atIso}::timestamptz, ${callOrigin})`;
  }

  beforeEach(async () => {
    // The outer beforeEach truncates routines/carry_notes only; scope our own cleanup by
    // owner so rows cannot survive into a later case (and so we touch no peer's fixtures).
    await sql`DELETE FROM harness_shared.tool_invocations WHERE coord_owner_id = ${EV_OWNER}`;
  });

  it('counts 0 when the ONLY call in the window is the loop:checkpoint that wrote the note', async () => {
    // The real measured shape: note updated_at 18:20:06.840Z, its own checkpoint row
    // stamped 18:20:07.136Z — 296ms INSIDE the window that note opens.
    await seedCall('loop:checkpoint', '2026-08-15T18:20:07.136Z');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(0);
  });

  it('counts 0 for a work_items:checkpoint refresh — its content is checkpointed by definition', async () => {
    await seedCall('work_items:checkpoint', '2026-08-15T18:21:00.000Z');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(0);
  });

  it('still counts REAL agent work — the exclusion must not suppress a genuine alarm', async () => {
    await seedCall('work_items:get', '2026-08-15T18:22:00.000Z');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(1);
  });

  it('counts only the real work when a checkpoint accompanies it (1, not 2)', async () => {
    await seedCall('work_items:get', '2026-08-15T18:22:00.000Z');
    await seedCall('loop:checkpoint', '2026-08-15T18:23:00.000Z');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(1);
  });

  it('preserves the pre-existing origin filter: hook traffic is still excluded', async () => {
    await seedCall('coord:orient', '2026-08-15T18:22:00.000Z', 'hook');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(0);
  });

  it('respects the window bounds: real work BEFORE the note opens the window is not counted', async () => {
    await seedCall('work_items:get', '2026-08-15T18:00:00.000Z');
    expect(await countAgentToolCallsInWindow(EV_OWNER, SINCE, UNTIL, { sql })).toBe(0);
  });
});
