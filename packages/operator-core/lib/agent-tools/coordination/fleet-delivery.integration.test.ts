/**
 * fleet-delivery.integration.test.ts — the per-member fleet delivery override +
 * @fleet: member resolution end-to-end against REAL Postgres
 * (fleet-delivery-override-mute-digest-2026-06-30 + the @fleet: soft-prefer).
 *
 * The pure logic is unit-tested (fleet-delivery.test.ts / audience.test.ts); this
 * drives the REAL stores: setFleetDelivery → coord_entity_subscriptions, and the
 * @fleet: DELIVERY resolver (hostAudienceResolvers.listFleetMembers) → the
 * heartbeat-gated coord_presence query (liveFleetMemberIds) MINUS muted/digest
 * overrides. Proves: a live full-delivery member is included; muted + digest are
 * excluded from the live `to`; a stale (dead-heartbeat) member is excluded; and the
 * override round-trips ('full' clears it). getOrgPg is pointed at a throwaway DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { ensureCoordPresenceTable } from '@papercusp/coordination/presence';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Pin the coord workspace to 'default' (the workspace our seeded rows use) — otherwise
// coordWorkspaceId() reads whatever coord-log backend the integration harness configured.
vi.mock('./log', async (orig) => {
  const actual = await orig<typeof import('./log')>();
  return { ...actual, coordWorkspaceId: () => 'default', coordScopeWorkspace: () => 'default' };
});

const { hostAudienceResolvers } = await import('./audience-host');
const { setFleetDelivery, getFleetDeliveryOverrides } = await import('./fleet-delivery');

let db: FreshPgDb;
const WS = 'default';

beforeAll(async () => {
  db = await createFreshPgDb('fleet-delivery');
  h.sql = db.sql;
  await ensureCoordPresenceTable(db.sql);
  await ensureCoordCapabilityTables(db.sql);
  // ensureCoordPresenceTable creates the BASE table; the fleet membership label is
  // added by migration 407 (not run in the throwaway DB) — add it here so the
  // heartbeat-gated @fleet: member query has the column to read.
  await db.sql`ALTER TABLE harness_shared.coord_presence
    ADD COLUMN IF NOT EXISTS fleet_slug text, ADD COLUMN IF NOT EXISTS fleet_role text`;
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.coord_presence, harness_shared.coord_entity_subscriptions RESTART IDENTITY`.catch(() => {});
});

/** Seed a coord_presence row, optionally stale (old heartbeat) + with a fleet label.
 *  staleMinutes back-dates the heartbeat (0 ⇒ now() — a live member). */
async function seedMember(owner: string, fleet: string | null, opts: { staleMinutes?: number } = {}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at, fleet_slug)
    VALUES (${owner}, ${owner}, ${WS}, 'omp-hook-session', now() - make_interval(mins => ${opts.staleMinutes ?? 0}), ${fleet})`;
}

describe('fleet delivery override + @fleet: member resolution (real PG)', () => {
  it('listFleetMembers = live FULL-delivery members; excludes muted, digest, and stale; other fleets absent', async () => {
    await seedMember('alice', 'payments'); // full → included
    await seedMember('bob', 'payments'); // muted below → excluded
    await seedMember('carol', 'payments'); // digest below → excluded from live `to`
    await seedMember('dave', 'payments', { staleMinutes: 180 }); // dead heartbeat → excluded
    await seedMember('eve', 'risk'); // different fleet → not a payments member
    await setFleetDelivery('bob', 'payments', 'muted');
    await setFleetDelivery('carol', 'payments', 'digest');

    const members = await hostAudienceResolvers.listFleetMembers('payments');
    expect(new Set(members)).toEqual(new Set(['alice']));
  });

  it('a fleet with no overrides delivers to all its LIVE members', async () => {
    await seedMember('alice', 'payments');
    await seedMember('bob', 'payments');
    const members = await hostAudienceResolvers.listFleetMembers('payments');
    expect(new Set(members)).toEqual(new Set(['alice', 'bob']));
  });

  it('setFleetDelivery round-trips through the subscription store; full clears the override', async () => {
    await seedMember('bob', 'payments');
    await setFleetDelivery('bob', 'payments', 'muted');
    expect((await getFleetDeliveryOverrides('payments')).get('bob')).toBe('muted');

    await setFleetDelivery('bob', 'payments', 'digest');
    expect((await getFleetDeliveryOverrides('payments')).get('bob')).toBe('digest');

    await setFleetDelivery('bob', 'payments', 'full'); // 'full' = clear the override row
    expect((await getFleetDeliveryOverrides('payments')).get('bob')).toBeUndefined();
    // …and a cleared member is back in the live delivery set.
    expect(await hostAudienceResolvers.listFleetMembers('payments')).toEqual(['bob']);
  });

  it('slugifies a human fleet name in the resolver (Payments Squad → payments-squad)', async () => {
    await seedMember('alice', 'payments-squad');
    expect(await hostAudienceResolvers.listFleetMembers('Payments Squad')).toEqual(['alice']);
  });
});
