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
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Pin the coord workspace to 'default' (the workspace our seeded rows use) — otherwise
// coordWorkspaceId() reads whatever coord-log backend the integration harness configured.
vi.mock('./log', async (orig) => {
  const actual = await orig<typeof import('./log')>();
  return { ...actual, coordWorkspaceId: () => 'default', coordScopeWorkspace: () => 'default' };
});

// WI-37162: liveFleetMemberIds used to ALSO require a live psu-pty HOST process
// for that ownerId on this machine (livePsuFleetMemberIds → findLiveHost,
// WI-1764 #4 / P-006) before counting a fleet member as a deliverable @fleet:
// audience — but that requirement silently dropped every IDLE headless fleet
// member (cold carry legitimately has no live host process between loop wakes)
// from fleet broadcasts. liveFleetMemberIds no longer calls findLiveHost at all;
// the heartbeat gate + the oracle dead-check (ended|suspect) are the sole
// authority for audience membership now (see the WI-37162 comment on
// liveFleetMemberIds in fleet-roster.ts). This mock is kept only so a
// `findLiveHost === null` owner ('headless-idle' below) is provably NOT what
// determines inclusion here — the regression this file now guards.
vi.mock('../../events/await/psu-pty-discovery', async (orig) => {
  const actual = await orig<typeof import('../../events/await/psu-pty-discovery')>();
  return {
    ...actual,
    findLiveHost: (ownerId: string) => (ownerId === 'headless-idle' ? null : { ownerId }),
  };
});

const { hostAudienceResolvers } = await import('./audience-host');
const { setFleetDelivery, getFleetDeliveryOverrides } = await import('./fleet-delivery');
// Imported AFTER the @papercusp/db-org mock above, so it binds the throwaway-DB `sql`.
const { liveFleetMemberIdsDiagnosed, liveFleetMemberIds } = await import('../../fleet/fleet-roster');

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

  // WI-37162 regression: a live (fresh-heartbeat, not authoritatively-dead) member
  // with NO live psu-pty host — the shape of a headless fleet member on cold carry,
  // idle between loop wakes — must still be a deliverable @fleet: audience member.
  // Excluding it silently dropped exactly the idle members a leader most needs to
  // reach (measured live 2026-08-09: 5 of 11 fleet members, all idle/no-claim, had
  // a fresh coord_presence heartbeat but zero PSU_PTY_DIR entry).
  it('includes a live member with NO psu-pty host (headless, between cold-carry wakes)', async () => {
    await seedMember('headless-idle', 'payments'); // findLiveHost mocked to null for this id
    await seedMember('alice', 'payments'); // findLiveHost mocked to a live host
    const members = await hostAudienceResolvers.listFleetMembers('payments');
    expect(new Set(members)).toEqual(new Set(['headless-idle', 'alice']));
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

  // EI-5904 regression: fleet:delivery writes a coord_entity_subscriptions row with
  // target_kind='fleet' (FLEET_DELIVERY_KIND). The prod table's kind check originally
  // allowed only 'topic'|'object' (123-coordination-substrate.sql), so every
  // digest/muted override INSERT threw coord_entity_subscriptions_kind_check — but the
  // integration/embedded table-creation path (ensureCoordCapabilityTables) carried NO
  // check at all, so the drift passed every test while breaking prod. Migration 429
  // added 'fleet' to prod; the bootstrap DDL now mirrors that constraint. These two
  // cases guard the CLASS: a 'fleet' insert must succeed AND the constraint must exist.
  describe('coord_entity_subscriptions target_kind constraint (EI-5904)', () => {
    it("accepts target_kind='fleet' (the fleet:delivery override) without a check violation", async () => {
      await setFleetDelivery('frank', 'payments', 'muted'); // → INSERT target_kind='fleet'
      expect((await getFleetDeliveryOverrides('payments')).get('frank')).toBe('muted');
    });

    it('rejects an unknown target_kind — proves the bootstrap DDL mirrors the prod migration constraint', async () => {
      // Fails-before/passes-after guard: before the fix the bootstrap table had no
      // constraint, so this INSERT succeeded and the drift went undetected. It now
      // fails if the kind check is ever dropped from ensureCoordCapabilityTables.
      await expect(
        db.sql`INSERT INTO harness_shared.coord_entity_subscriptions
                 (workspace_id, subscriber_id, target_kind, target_ref, delivery_mode)
               VALUES (${WS}, 'zoe', 'bogus-kind', 'x', 'digest')`,
      ).rejects.toThrow(/coord_entity_subscriptions_kind_check|check constraint/i);
    });
  });

  // P-003 (fleet-lead-instrumentation-audit-2026-08-09): a fleet send could report
  // `recipients_resolved: 6` against an 11-row roster with NOTHING marking the result
  // partial. `liveFleetMemberIdsDiagnosed` reports the drops it already performed, so a
  // sender can tell a FULL delivery from a PARTIAL one.
  describe('liveFleetMemberIdsDiagnosed — a partial audience says so (P-003)', () => {
    it('reports each dropped member with its reason, and `ids` stays byte-identical to liveFleetMemberIds', async () => {
      await seedMember('alice', 'payments'); // live, non-bee → delivered
      await seedMember('dave', 'payments', { staleMinutes: 180 }); // dead heartbeat → dropped
      await seedMember('eve', 'risk'); // other fleet → not a member at all
      // NB the bee role token on the wire is 'cup', not 'bee' (see isBeeRole).
      await db.sql`UPDATE harness_shared.coord_presence SET agent_role = 'cup' WHERE owner_id = 'alice'`;
      await seedMember('frank', 'payments'); // live, non-bee → delivered

      const { ids, omitted } = await liveFleetMemberIdsDiagnosed('payments', WS);

      // The deliverable set is unchanged by this feature — reporting a drop must never
      // alter who receives the message.
      expect(new Set(ids)).toEqual(new Set(await liveFleetMemberIds('payments', WS)));
      expect(new Set(ids)).toEqual(new Set(['frank']));

      // ...and every member NOT delivered to is now named, with why.
      expect(new Set(omitted.map((o) => `${o.ownerId}:${o.reason}`))).toEqual(
        new Set(['dave:stale-heartbeat', 'alice:bee-role']),
      );
      // A member of ANOTHER fleet is not an omission — it was never in this audience.
      expect(omitted.map((o) => o.ownerId)).not.toContain('eve');
      // The stale drop carries its evidence, so the reader can judge how stale.
      expect(omitted.find((o) => o.ownerId === 'dave')?.heartbeatAt).toBeTruthy();
    });

    it('a fully-deliverable fleet reports an EMPTY omitted list — the signal that means "everyone got it"', async () => {
      await seedMember('alice', 'payments');
      await seedMember('bob', 'payments');

      const { ids, omitted } = await liveFleetMemberIdsDiagnosed('payments', WS);
      expect(new Set(ids)).toEqual(new Set(['alice', 'bob']));
      // This is the assertion that gives the empty array meaning: `omitted: []` has to be
      // reachable, or "no omissions" and "omissions not computed" stay indistinguishable —
      // the exact confident-zero failure this plan is about.
      expect(omitted).toEqual([]);
    });
  });
});
