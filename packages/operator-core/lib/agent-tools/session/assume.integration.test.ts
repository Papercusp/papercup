/** Real PostgreSQL custody coverage. Managed PTY/routing journeys are separate
 * acceptance coverage; a database lease alone does not prove a takeover. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { acquireAdvSessionResume, releaseAdvSessionResume, type AdvSessionResumePin } from '../../adv-sessions';

let database: OrgTestDb;
let fixture: BaselineCoordFixture;
const workspaceId = 'assume-isolated-custody';

beforeAll(async () => {
  database = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: database.adminDsn });
});

afterAll(async () => {
  try { await fixture?.dispose(); }
  finally { await database?.cleanup(); }
});

async function target() {
  const ownerId = `su-assume-fixture-${randomUUID()}`;
  const nativeId = randomUUID();
  const [row] = await fixture.admin<{ id: string; started: string }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, ended_by)
    VALUES (${workspaceId}, 'codex', 'console', ${ownerId}, ${nativeId}, now(), now(), 'self')
    RETURNING id, started_at::text AS started
  `;
  const id = Number(row.id);
  const pin: AdvSessionResumePin = { workspaceId, requireTerminal: true,
    binding: { coordOwnerId: ownerId, sessionId: nativeId, startedAt: row.started } };
  return { id, pin };
}

describe('session:assume existing resume reservation (real PG)', () => {
  it('serializes different caller keys on the exact same ended incarnation', async () => {
    const { id, pin } = await target();
    const keys = ['caller-a', 'caller-b'];
    const results = await Promise.all(keys.map(key =>
      acquireAdvSessionResume(id, key, 120, undefined, undefined, false, pin)));
    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(results.filter(result => result.status === 'reserved')).toHaveLength(1);
    const [stored] = await fixture.admin<{ key: string; ended: boolean }[]>`
      SELECT resume_claim_key AS key, ended_at IS NOT NULL AS ended
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(stored.ended).toBe(true);
    const winner = keys[results.findIndex(result => result.acquired)];
    expect(stored.key).toBe(winner);
    expect(await acquireAdvSessionResume(id, winner, 120, undefined, undefined, false, pin))
      .toMatchObject({ acquired: true, replayed: true });
    expect(await releaseAdvSessionResume(id, 'not-the-owner')).toBe(false);
    expect(await releaseAdvSessionResume(id, winner)).toBe(true);
  });

  it('refuses stale incarnation and foreign workspace without writing a lease', async () => {
    const { id, pin } = await target();
    await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'stale', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'binding-changed', acquired: false });
    const other = await target();
    expect(await acquireAdvSessionResume(other.id, 'foreign', 120, undefined, undefined, false,
      { ...other.pin, workspaceId: 'foreign-workspace' }))
      .toEqual({ status: 'binding-changed', acquired: false });
    const rows = await fixture.admin<{ key: string | null }[]>`
      SELECT resume_claim_key AS key FROM harness_shared.adv_sessions WHERE id IN (${id}, ${other.id})
    `;
    expect(rows.map(row => row.key)).toEqual([null, null]);
  });

  it('refuses ended-to-live changes despite a stale or replayed claim', async () => {
    const { id, pin } = await target();
    await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin);
    await fixture.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL, ended_by = NULL WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'live', acquired: false });
  });
});
