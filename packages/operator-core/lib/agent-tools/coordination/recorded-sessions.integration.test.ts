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
import { listRecordedLiveSessions, reactivateAdvSession } from '../../adv-sessions';

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
    await seedAdv({ coordOwnerId: 's-live-1', role: 'queen', label: 'hive · papercusp/queen' });
    const rows = await listRecordedLiveSessions({ workspaceId: WS });
    expect(rows.map((r) => r.coordOwnerId)).toEqual(['s-live-1']);
    expect(rows[0].role).toBe('queen');
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

describe('reactivateAdvSession (resume re-activates an ended row → roster surfaces it)', () => {
  it('clears ended_at/exit_code so an ended (resumed) session becomes live + listable', async () => {
    // An ended session — invisible to the live roster, exactly like a session
    // the user exited and is about to `psu --resume`.
    const rows = await admin`
      INSERT INTO harness_shared.adv_sessions (workspace_id, agent, mode, coord_owner_id, started_at, ended_at, exit_code)
      VALUES (${WS}, 'claude', 'console', 's-resumed', now() - interval '90 minutes', now() - interval '30 minutes', 0)
      RETURNING id`;
    const id = Number(rows[0].id);
    expect((await listRecordedLiveSessions({ workspaceId: WS })).map((r) => r.coordOwnerId)).toEqual([]);

    // Resume re-activates the row.
    expect(await reactivateAdvSession(id)).toBe(true);

    const live = await listRecordedLiveSessions({ workspaceId: WS });
    expect(live.map((r) => r.coordOwnerId)).toEqual(['s-resumed']);
    expect(live[0].endedAt).toBeNull();
  });

  it('is idempotent — re-activating an already-live row is a no-op (returns false)', async () => {
    const rows = await admin`
      INSERT INTO harness_shared.adv_sessions (workspace_id, agent, mode, coord_owner_id, started_at, ended_at)
      VALUES (${WS}, 'claude', 'console', 's-live2', now() - interval '5 minutes', NULL)
      RETURNING id`;
    expect(await reactivateAdvSession(Number(rows[0].id))).toBe(false);
  });

  it('returns false for an unknown id', async () => {
    expect(await reactivateAdvSession(99999999)).toBe(false);
  });
});
