/**
 * liveness-constants-drift.test.ts — single-source threshold guards
 * (presence-derivation-unification-2026-07-17 P-009, audit F8/F10).
 *
 * The liveness thresholds live in code (PRESENCE_STALE_MS in
 * @papercusp/pubsub-substrate, mirrored by lib/liveness.ts's STALE_MS under an
 * existing drift-guard in adv-roster.test.ts) — but the `fleet_assignment` SQL
 * view bakes its own copy as a literal `interval '10 minutes'` with NO guard:
 * a change to PRESENCE_STALE_MS would silently diverge the view's
 * `holder_alive` from every TS reader. This test pins the LATEST migration
 * that (re)defines the view to the code constant.
 *
 * F10 (D-002): the stale-claim reclaim's parked grace and the presence DEAD
 * ceiling are the SAME 30-minute policy by design (see PRESENCE_DEAD_MS's
 * doc: "matching the parked-claim reclaim grace … consistent policy, not a
 * new one") — previously only aligned by folklore. Assert it structurally.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESENCE_STALE_MS } from '../agent-tools/coordination/presence';
import { PRESENCE_DEAD_MS, LIVE_TURN_WINDOW_MS } from '../agent-tools/coordination/presence-wakeability';
import { STALE_CLAIM_PARKED_GRACE_MS } from '../work-items-stale-claims';

const SQL_DIR = join(__dirname, '../../../../libs/papercusp/libs/db/sql');

/** The latest migration file that (re)defines harness_shared.fleet_assignment. */
function latestFleetAssignmentViewSql(): { file: string; sql: string } {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
  let found: { file: string; sql: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(SQL_DIR, f), 'utf8');
    if (/CREATE OR REPLACE VIEW\s+harness_shared\.fleet_assignment/i.test(sql)) {
      found = { file: f, sql };
    }
  }
  if (!found) throw new Error(`no migration defining harness_shared.fleet_assignment under ${SQL_DIR}`);
  return found;
}

describe('liveness threshold single-sourcing (P-009)', () => {
  it("fleet_assignment view's freshness literal matches PRESENCE_STALE_MS", () => {
    const { file, sql } = latestFleetAssignmentViewSql();
    // The presence CTE derives `alive` from heartbeat recency:
    //   (now() - heartbeat_at) < interval 'N minutes' AS alive
    const m = sql.match(/heartbeat_at\)?\s*<\s*interval\s*'(\d+)\s*minutes?'/i);
    expect(m, `expected the heartbeat-freshness interval literal in ${file}`).toBeTruthy();
    const minutes = Number(m![1]);
    expect(
      minutes * 60_000,
      `${file}: the view's interval '${minutes} minutes' must equal PRESENCE_STALE_MS ` +
        `(${PRESENCE_STALE_MS}ms) — if you change one, ship a migration + update the constant together`,
    ).toBe(PRESENCE_STALE_MS);
  });

  it('the reclaim parked-grace and the presence DEAD ceiling are the same policy (D-002)', () => {
    expect(STALE_CLAIM_PARKED_GRACE_MS).toBe(PRESENCE_DEAD_MS);
  });

  it('the liveTurn window rides the presence stale window (one clock)', () => {
    expect(LIVE_TURN_WINDOW_MS).toBe(PRESENCE_STALE_MS);
  });
});
