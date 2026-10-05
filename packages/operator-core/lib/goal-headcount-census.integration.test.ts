/** EI-25166050736574344: execute the production census SQL in isolated Postgres.
 * The oracle seam controls verdicts; existing liveness tests cover that oracle.
 * These synthetic controls do not establish the historical incident's cause.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { goalHeadcount } from './goal-launch-settings';

const oracle = vi.hoisted(() => ({ seen: [] as string[][] }));
vi.mock('./agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: async (subjects: readonly { ownerId: string }[]) => {
    oracle.seen.push(subjects.map((subject) => subject.ownerId));
    return new Map(subjects.map(({ ownerId }) => [ownerId, {
      sessionState: ownerId === 'ended' ? 'ended' : ownerId === 'recorded' ? 'recorded' : 'live',
    }]));
  },
}));

const WS = 'census-workspace';
const GOAL = 'census-goal';
const FLEET = 'census-fleet';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('goal_census');
  // Only columns read by the census: no production workspace or actor is touched.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL, goal_id text,
      first_seen_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE harness_shared.coord_presence (
      owner_id text PRIMARY KEY, fleet_slug text, heartbeat_at timestamptz NOT NULL,
      host text, pid integer, source text
    );
  `);
});
afterAll(async () => { await db?.cleanup(); });

beforeEach(async () => {
  oracle.seen = [];
  await db.sql.unsafe('TRUNCATE harness_shared.coord_presence, harness_shared.session_briefs');
  const rows = [
    { owner: 'live', fleet: FLEET },
    { owner: 'recorded', fleet: FLEET },
    { owner: 'ended', fleet: FLEET },
    { owner: 'other-fleet', fleet: 'another-fleet' },
    { owner: 'boot', fleet: null },
    { owner: 'stale', fleet: FLEET, stale: true },
    { owner: 'expired-boot', fleet: null, stale: true },
    { owner: 'replacement', fleet: FLEET },
    { owner: 'other-goal', fleet: FLEET, goal: 'another-goal' },
    { owner: 'other-workspace', fleet: FLEET, workspace: 'another-workspace' },
  ];
  for (const row of rows) {
    const age = row.stale ? '1 hour' : '5 seconds';
    await db.sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id, updated_at)
      VALUES (${row.owner}, ${row.workspace ?? WS}, ${row.goal ?? GOAL}, now() - ${age}::interval)`;
    if (row.fleet) {
      await db.sql`
        INSERT INTO harness_shared.coord_presence (owner_id, fleet_slug, heartbeat_at, host, pid, source)
        VALUES (${row.owner}, ${row.fleet}, now() - ${age}::interval, 'fixture-host', 123, 'fixture')`;
    }
  }
});

describe('goalHeadcount same-query population in real Postgres', () => {
  it('reconciles aggregate identities, fleet membership, boot grace and oracle exclusions in one query', async () => {
    let censusQueries = 0;
    const sql = new Proxy(db.sql, {
      apply(target, thisArg, args) {
        if (String(args[0]?.[0]).includes('count(*)::int AS total')) censusQueries += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const result = await goalHeadcount({
      workspaceId: WS, goalId: GOAL, fleetSlug: FLEET,
      excludeOwnerIds: ['replacement', 'replacement'], sql,
    });
    expect(result.error).toBeNull();
    expect(censusQueries).toBe(1);
    expect(result.headcount).toEqual({ total: 4, fleet: 2 });
    expect(result.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 5, fleet: 3 },
      excludedOwnerIds: ['replacement'], oracleEndedOwnerIds: ['ended'],
    });
    expect(Number.isFinite(Date.parse(result.measurement!.measuredAt!))).toBe(true);
    const counted = result.measurement!.counted;
    expect(counted.map((row) => row.ownerId).sort()).toEqual(['boot', 'live', 'other-fleet', 'recorded']);
    expect(counted.filter((row) => row.inFleet).map((row) => row.ownerId).sort()).toEqual(['live', 'recorded']);
    expect(counted.find((row) => row.ownerId === 'boot')).toMatchObject({
      basis: 'boot-grace', heartbeatAt: null, inFleet: false,
    });
    expect(counted.find((row) => row.ownerId === 'recorded')).toMatchObject({ basis: 'heartbeat', inFleet: true });
    expect(oracle.seen).toHaveLength(1);
    expect(oracle.seen[0].sort()).toEqual(['ended', 'live', 'other-fleet', 'recorded']);
  });

  it('represents an empty measured population and an omitted fleet without inventing fleet zero', async () => {
    const result = await goalHeadcount({ workspaceId: WS, goalId: GOAL, sql: db.sql });
    expect(result.error).toBeNull();
    expect(result.headcount).toEqual({ total: 5, fleet: null });
    expect(result.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 6, fleet: null },
    });
    const empty = await goalHeadcount({ workspaceId: 'empty-workspace', goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(empty.error).toBeNull();
    expect(empty.headcount).toEqual({ total: 0, fleet: 0 });
    expect(empty.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 0, fleet: 0 }, counted: [], oracleEndedOwnerIds: [],
    });
  });

  it('distinguishes one new identity from an existing identity becoming goal-countable', async () => {
    const count = () => goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    const before = await count();
    await db.sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id)
      VALUES ('sole-new-launch', ${WS}, ${GOAL})`;
    const afterLaunch = await count();
    const identitiesBeforeTransition = await db.sql`SELECT count(*)::int AS n FROM harness_shared.session_briefs`;
    await db.sql`UPDATE harness_shared.session_briefs SET goal_id = ${GOAL} WHERE owner_id = 'other-goal'`;
    const afterTransition = await count();
    const identitiesAfterTransition = await db.sql`SELECT count(*)::int AS n FROM harness_shared.session_briefs`;
    expect([before, afterLaunch, afterTransition].map((r) => r.headcount.total)).toEqual([5, 6, 7]);
    expect([before, afterLaunch, afterTransition].every((r) => r.error === null && r.measurement?.populationComplete)).toBe(true);
    expect(identitiesAfterTransition).toEqual(identitiesBeforeTransition);
    const added = (a: typeof before, b: typeof before) => b.measurement!.counted
      .map((row) => row.ownerId).filter((id) => !a.measurement!.counted.some((row) => row.ownerId === id));
    expect(added(before, afterLaunch)).toEqual(['sole-new-launch']);
    expect(added(afterLaunch, afterTransition)).toEqual(['other-goal']);
  });
});
