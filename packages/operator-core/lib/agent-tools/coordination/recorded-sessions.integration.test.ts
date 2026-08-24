/**
 * recorded-sessions.integration.test.ts — the `listRecordedLiveSessions` SQL
 * against REAL Postgres (the shared baseline-schema DB via the coord fixture)
 * (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * The pure projection (synthesizeRecordedRosterRows) is unit-tested; this guards
 * the IO seam — the recency bound, the ended_at / coord_owner_id / workspace
 * filters, and the per-owner dedup — end-to-end, through the module's own
 * getOrgPg() handle. Explicitly covers claude + codex + omp recorded sessions
 * (the owner's "works for codex and omp" requirement) since those CLIs weren't
 * present to live-test when the fix landed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { claimAdvSessionResume, listRecordedLiveSessions } from '../../adv-sessions';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const WS = 'rec-ws';

async function seedAdv(opts: {
  coordOwnerId: string | null;
  workspaceId?: string;
  agent?: string;
  mode?: 'omp' | 'console';
  role?: string | null;
  label?: string | null;
  startedAgoSec?: number;
  ended?: boolean;
}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, role, label, coord_owner_id, started_at, ended_at)
    VALUES (
      ${opts.workspaceId ?? WS}, ${opts.agent ?? 'claude'}, ${opts.mode ?? 'console'},
      ${opts.role ?? null}, ${opts.label ?? null}, ${opts.coordOwnerId},
      now() - ${`${opts.startedAgoSec ?? 60} seconds`}::interval,
      ${opts.ended ? new Date() : null}
    )
  `;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.adv_sessions`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.adv_sessions`;
});

describe('listRecordedLiveSessions (real PG)', () => {
  it('surfaces a live recorded session with a coord_owner_id', async () => {
    await seedAdv({ coordOwnerId: 's-live-1', role: 'mug', label: 'hive · papercusp/queen' });
    const rows = await listRecordedLiveSessions({ workspaceId: WS });
    expect(rows.map((r) => r.coordOwnerId)).toEqual(['s-live-1']);
    expect(rows[0].role).toBe('mug');
  });

  it('excludes ended sessions (ended_at IS NOT NULL)', async () => {
    await seedAdv({ coordOwnerId: 's-ended', ended: true });
    await seedAdv({ coordOwnerId: 's-live' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-live']);
  });

  it('excludes rows with a NULL coord_owner_id (unaddressable)', async () => {
    await seedAdv({ coordOwnerId: null });
    await seedAdv({ coordOwnerId: 's-has-owner' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-has-owner']);
  });

  it('excludes sessions older than the recency bound (zombie guard)', async () => {
    await seedAdv({ coordOwnerId: 's-old', startedAgoSec: 7200 });
    await seedAdv({ coordOwnerId: 's-fresh', startedAgoSec: 30 });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS, maxAgeMs: 60_000 })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-fresh']);
  });

  it('filters by workspace when given', async () => {
    await seedAdv({ coordOwnerId: 's-mine', workspaceId: WS });
    await seedAdv({ coordOwnerId: 's-other', workspaceId: 'other-ws' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId);
    expect(owners).toEqual(['s-mine']);
  });

  it('dedups to the most-recent row per coord_owner_id', async () => {
    await seedAdv({ coordOwnerId: 's-dup', label: 'older', startedAgoSec: 300 });
    await seedAdv({ coordOwnerId: 's-dup', label: 'newer', startedAgoSec: 10 });
    const rows = await listRecordedLiveSessions({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('newer');
  });

  it('is CLI-agnostic — claude, codex AND omp recorded sessions all surface', async () => {
    await seedAdv({ coordOwnerId: 's-claude', agent: 'claude', mode: 'console' });
    await seedAdv({ coordOwnerId: 'su-codex', agent: 'codex', mode: 'console' });
    await seedAdv({ coordOwnerId: 'su-omp', agent: 'omp', mode: 'omp', label: 'su · engineer' });
    const owners = (await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId).sort();
    expect(owners).toEqual(['s-claude', 'su-codex', 'su-omp']);
  });
});

/**
 * claimAdvSessionResume (EI-21247460909447431) — the single-winner resume claim.
 *
 * The regression this pins: an `ended_at IS NOT NULL`-only predicate cannot
 * claim a row whose process died WITHOUT recording its exit, making such a
 * session permanently un-resumable (the wake parks forever, reporting a race
 * that never happened). That state is the common one, not an edge case.
 */
describe('claimAdvSessionResume (single-winner Channel 2 resume claim)', () => {
  async function seedRow(startedAgo: string, ended: boolean): Promise<number> {
    const rows = await admin`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, started_at, ended_at, exit_code)
      VALUES (${WS}, 'claude', 'console', ${`s-claim-${Math.random().toString(36).slice(2, 10)}`},
              now() - ${startedAgo}::interval, ${ended ? new Date() : null}, ${ended ? 137 : null})
      RETURNING id`;
    return Number(rows[0].id);
  }

  it('claims a cleanly-ENDED row and makes it live/listable', async () => {
    const id = await seedRow('90 minutes', true);

    expect(await claimAdvSessionResume(id)).toBe(true);

    const [row] = await admin`
      SELECT coord_owner_id, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.exit_code).toBeNull();
    expect((await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId))
      .toContain(row.coord_owner_id);
  });

  it('claims a row that was NEVER marked ended (process died without recording its exit)', async () => {
    // The regression: this row is indistinguishable from a live one by ended_at
    // alone, but its process is long gone. It must be resumable.
    const id = await seedRow('2 days', false);
    expect(await claimAdvSessionResume(id)).toBe(true);
  });

  it('LOSES to a resumer that just claimed the same row (single-winner preserved)', async () => {
    // A winning claim bumps started_at to now(), so a second claimant inside the
    // window must lose — this is what stops two writers on one session.
    const id = await seedRow('2 days', false);
    expect(await claimAdvSessionResume(id)).toBe(true);
    expect(await claimAdvSessionResume(id)).toBe(false);
  });

  it('returns false for an unknown id', async () => {
    expect(await claimAdvSessionResume(99999999)).toBe(false);
  });
});
