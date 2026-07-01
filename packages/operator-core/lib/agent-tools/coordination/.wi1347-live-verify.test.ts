/**
 * THROWAWAY (not committed, deleted after run) live-PG verification for
 * WI-1347. Runs `reapEndedPresenceRows()` against the REAL shared dev-box
 * Postgres (same DB :3070 uses) as a substitute for
 * presence-reaper.integration.test.ts, which needs testcontainers/Docker —
 * unavailable in this bee sandbox (docker socket permission denied,
 * confirmed independently by two bees; tracked as its own infra bug, not a
 * defect in this reaper). Uses a unique owner_id prefix; cleans up
 * unconditionally in afterAll.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { reapEndedPresenceRows } from './presence-reaper';
import { listPresence } from './presence';

const PREFIX = 'wi1347-live-verify-';
const TTL = 60 * 60 * 1000; // 1h
const ids = {
  dead: `${PREFIX}dead`,
  freshEnded: `${PREFIX}fresh-ended`,
  parked: `${PREFIX}parked`,
};

async function cleanup() {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.coord_presence WHERE owner_id LIKE ${PREFIX + '%'}`;
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE ${PREFIX + '%'}`;
}

afterAll(cleanup);

describe('WI-1347 live-PG verification (real dev-box Postgres, not testcontainers)', () => {
  it('reaps an ended row past TTL, keeps a fresh-ended row, NEVER reaps a wakeable parked row', async () => {
    await cleanup();
    const { sql } = getOrgPg();

    await sql`
      INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
      VALUES
        (${ids.dead}, ${ids.dead}, 'default', 'static-client', now() - interval '2 hours'),
        (${ids.freshEnded}, ${ids.freshEnded}, 'default', 'static-client', now() - interval '60 seconds'),
        (${ids.parked}, ${ids.parked}, 'default', 'static-client', now() - interval '10 hours')
    `;
    await sql`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
      VALUES (${ids.parked}, ${'coord:inbox-wake:' + ids.parked}, NULL, NULL, NULL)
    `;

    const before = await listPresence({});
    const beforeIds = new Set(before.map((r) => r.ownerId));
    expect(beforeIds.has(ids.dead)).toBe(true);
    expect(beforeIds.has(ids.freshEnded)).toBe(true);
    expect(beforeIds.has(ids.parked)).toBe(true);

    const result = await reapEndedPresenceRows({ ttlMs: TTL });

    expect(result.ownerIds).toContain(ids.dead);

    const after = await sql<{ owner_id: string }[]>`
      SELECT owner_id FROM harness_shared.coord_presence WHERE owner_id LIKE ${PREFIX + '%'} ORDER BY owner_id
    `;
    const afterIds = after.map((r) => r.owner_id);
    expect(afterIds).not.toContain(ids.dead);
    expect(afterIds).toContain(ids.freshEnded);
    expect(afterIds).toContain(ids.parked); // never reaped, however old, because it's wakeable
  });
});
