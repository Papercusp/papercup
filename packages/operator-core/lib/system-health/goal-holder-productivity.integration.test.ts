/**
 * goal-holder-productivity.integration.test.ts — the wedge leg's SQL against
 * REAL Postgres.
 *
 * This seam has to be guarded at a real driver, not a mocked `sql` tag. The
 * wedge leg is the ONLY detector that looks at a goal whose holder is present
 * but producing nothing — `classifyGoalLiveness` returns null the instant a
 * goal resolves `held`, so without this leg "somebody is on it" ends the
 * enquiry. And on 2026-08-27 it was throwing on EVERY tick in bg-host:
 *
 *   [goal-liveness-watchdog] holder-productivity read failed (non-fatal, wedge
 *   leg skipped): The "string" argument must be of type string or an instance
 *   of Buffer or ArrayBuffer. Received an instance of Array
 *
 * The catch around it converts a failure into `productivity = new Map()`, which
 * by design means "not measured" and SUPPRESSES every wedge alert. So the
 * detector was dark, loudly, into a log nobody reads — while its own unit
 * suite stayed green, because a mocked `sql` never runs the driver's parameter
 * serializer that was actually failing.
 *
 * Whatever the specific serialization fault, the property worth pinning is the
 * one the leg depends on: calling this against a real connection must RETURN A
 * MEASUREMENT, not throw. Test 1 fails on today's code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { makeReadHolderProductivity } from './goal-liveness-watchdog';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'wedge-productivity-ws';
const GOAL_A = 'goal-wedge-a';
const GOAL_B = 'goal-wedge-b';
const OWNER_A = 'su-wedge-owner-a';
const OWNER_B = 'su-wedge-owner-b';

/** setAtMs one hour ago: every seeded call below lands after the hold starts. */
const HELD_SINCE = () => Date.now() - 60 * 60_000;

async function seedCall(opts: {
  ownerId: string;
  callOrigin: string | null;
  agoSec?: number;
}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
       window_key, status, coord_owner_id, call_origin, invoked_at)
    VALUES (
      ${WS}, 'papercusp', 'test', 'test:verb', 'su', 'spawn-test',
      'w', 'ok', ${opts.ownerId}, ${opts.callOrigin},
      now() - ${`${opts.agoSec ?? 60} seconds`}::interval
    )
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`.catch(
    () => {},
  );
  await fx.dispose();
});
beforeEach(async () => {
  await admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`;
});

describe('makeReadHolderProductivity against real Postgres', () => {
  it('RETURNS a measurement instead of throwing — the wedge leg is not dark', async () => {
    // The regression itself. A throw here is indistinguishable, downstream,
    // from "every goal measured as productive": the caller catches it and
    // substitutes an empty map, which suppresses every alert.
    const read = makeReadHolderProductivity(admin);
    const out = await read([
      { workspaceId: WS, goalId: GOAL_A, ownerId: OWNER_A, setAtMs: HELD_SINCE() },
      { workspaceId: WS, goalId: GOAL_B, ownerId: OWNER_B, setAtMs: HELD_SINCE() },
    ]);
    expect(out).toBeInstanceOf(Map);
    // A hold with no calls must still APPEAR, at zero. If it were merely
    // absent, a wedged holder would be reported as "not measured" and stay
    // silent — the same suppression the throw causes, one layer down.
    expect(out.get(`${WS}:${GOAL_A}`)).toBe(0);
    expect(out.get(`${WS}:${GOAL_B}`)).toBe(0);
  });

  it('counts agent-origin work and ignores hook traffic', async () => {
    await seedCall({ ownerId: OWNER_A, callOrigin: 'agent' });
    await seedCall({ ownerId: OWNER_A, callOrigin: 'agent' });
    await seedCall({ ownerId: OWNER_A, callOrigin: 'hook' });
    const read = makeReadHolderProductivity(admin);
    const out = await read([
      { workspaceId: WS, goalId: GOAL_A, ownerId: OWNER_A, setAtMs: HELD_SINCE() },
    ]);
    expect(out.get(`${WS}:${GOAL_A}`)).toBe(2);
  });

  it('counts a NULL call_origin as work — it must never manufacture a false wedge', async () => {
    // `<> 'hook'` is FALSE for NULL, which would drop pre-migration rows and
    // undercount toward a FALSE wedge; `IS DISTINCT FROM` errs toward silence.
    await seedCall({ ownerId: OWNER_A, callOrigin: null });
    const read = makeReadHolderProductivity(admin);
    const out = await read([
      { workspaceId: WS, goalId: GOAL_A, ownerId: OWNER_A, setAtMs: HELD_SINCE() },
    ]);
    expect(out.get(`${WS}:${GOAL_A}`)).toBe(1);
  });

  it('does not credit work the holder did BEFORE it picked the goal up', async () => {
    // `since` travels per row, not as a global floor: an owner is answerable
    // only for calls made after IT took this goal.
    await seedCall({ ownerId: OWNER_A, callOrigin: 'agent', agoSec: 3 * 60 * 60 });
    const read = makeReadHolderProductivity(admin);
    const out = await read([
      { workspaceId: WS, goalId: GOAL_A, ownerId: OWNER_A, setAtMs: HELD_SINCE() },
    ]);
    expect(out.get(`${WS}:${GOAL_A}`)).toBe(0);
  });

  it('keeps per-hold `since` independent across a batch', async () => {
    // Two holds, same owner activity window, different pickup times. A shared
    // floor would give both the same count and hide a genuinely idle holder.
    await seedCall({ ownerId: OWNER_A, callOrigin: 'agent', agoSec: 30 * 60 });
    await seedCall({ ownerId: OWNER_B, callOrigin: 'agent', agoSec: 30 * 60 });
    const read = makeReadHolderProductivity(admin);
    const out = await read([
      { workspaceId: WS, goalId: GOAL_A, ownerId: OWNER_A, setAtMs: Date.now() - 60 * 60_000 },
      { workspaceId: WS, goalId: GOAL_B, ownerId: OWNER_B, setAtMs: Date.now() - 5 * 60_000 },
    ]);
    expect(out.get(`${WS}:${GOAL_A}`)).toBe(1);
    expect(out.get(`${WS}:${GOAL_B}`)).toBe(0);
  });

  it('returns an empty map for an empty hold list without touching the driver', async () => {
    const read = makeReadHolderProductivity(admin);
    expect((await read([])).size).toBe(0);
  });
});
