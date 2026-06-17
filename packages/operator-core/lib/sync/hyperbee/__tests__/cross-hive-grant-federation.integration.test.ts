/**
 * cross-hive-grant-federation.integration.test.ts — test-coverage gaps G25 + G26.
 *
 * Cross-hive grants (cross-hive-boundary-2026-06-08) and every other per-Hive
 * setting are persisted as a `hive_settings` value keyed by the Hive's home slug,
 * which federates over the Hive's peer-log (mig 186 capture trigger →
 * 'hive-settings-by-key' projection). The single-PG round-trip is covered by
 * `cross-hive-grants.integration.test.ts`; what was UNTESTED is that a grant /
 * setting written on ONE Swarm actually federates to ANOTHER Swarm of the same
 * Hive over the real wire.
 *
 * Two REAL Swarms of one Hive on a loopback testnet DHT, each projecting
 * hive_settings into its OWN throwaway PG via the REAL mig-186 capture trigger +
 * the REAL hive-settings projection.
 *
 * ── G25: an xhive grant written on A federates to B and ADMITS a previously-denied
 *    cross-hive ask on B ──
 *    Before the grant federates, `admitCrossHiveEnvelope` on B (loading B's grants
 *    via `loadCrossHiveGrants`) DENIES an `ask` from peer-hive-X (default-deny). A
 *    writes the inbound grant via `setCrossHiveGrant`; it federates A→B; the SAME
 *    admission call on B now ADMITS it. (hive_settings DOES carry the substrate
 *    capture trigger — verified: the grant federates.)
 *
 * ── G26: concurrent hive_settings LWW converges on the higher ts ──
 *    A writes setting=100@ts1000, B writes setting=200@ts1001 (concurrent writers
 *    of the SAME key). After federation BOTH peers' PG converge on 200 (the higher
 *    fed_ts wins via the projection's PG-level LWW guard).
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  bootTwoHivePeers,
  pollUntil,
  settingValue,
  rigAfterEach,
  WORKSPACE_ID,
  HIVE_SLUG,
} from './_hive-substrate-rig';
import { setCrossHiveGrant, loadCrossHiveGrants, CROSS_HIVE_GRANTS_KEY } from '../../../cross-hive-grants';
import { admitCrossHiveEnvelope, type CrossHiveEnvelope } from '../../../cross-hive-boundary';

afterEach(rigAfterEach);

const PEER_HIVE_X = 'peer-hive-X-directory-pubkey';
const SELF_HIVE_PUBKEY = 'this-hive-directory-pubkey';

/** A signed inbound ask envelope from peer-hive-X addressed to THIS Hive. */
const askEnvelope = (): CrossHiveEnvelope => ({
  fromHivePubkey: PEER_HIVE_X,
  toHivePubkey: SELF_HIVE_PUBKEY,
  kind: 'ask',
  subject: 'a cross-hive question',
  body: 'please advise',
  sig: 'a-valid-looking-sig',
});

/** Decide admission on a peer using ITS federated grants (the real receive path). */
async function admitOn(sql: Parameters<typeof loadCrossHiveGrants>[2]) {
  const grants = await loadCrossHiveGrants(WORKSPACE_ID, HIVE_SLUG, sql);
  return admitCrossHiveEnvelope(askEnvelope(), { grants, selfHivePubkey: SELF_HIVE_PUBKEY });
}

describe('cross-hive grant + hive_settings federation (G25 / G26)', () => {
  it(
    "G25: an xhive grant written on A federates to B and admits a previously-denied cross-hive ask on B",
    async () => {
      const { dbA, dbB, mergeBoth, drainBoth } = await bootTwoHivePeers();

      // ── Precondition: default-deny. With no grant, B REJECTS the ask. ──
      const before = await admitOn(dbB.sql);
      expect(before.admitted, 'default-deny: B should reject the ask before any grant').toBe(false);

      // ── A writes the INBOUND grant (peer-hive-X may `ask` INTO this Hive) via the
      // real store → hive_settings → mig-186 capture trigger. ──
      await setCrossHiveGrant(WORKSPACE_ID, HIVE_SLUG, PEER_HIVE_X, ['ask'], 'in', dbA.sql);
      // Sanity: A can read its own grant + would admit.
      const aGrants = await loadCrossHiveGrants(WORKSPACE_ID, HIVE_SLUG, dbA.sql);
      expect(aGrants.some((g) => g.peerHivePubkey === PEER_HIVE_X && g.allowedKinds.includes('ask'))).toBe(true);

      // ── Federate A→B: drain A's outbox onto its log, merge until B's hive_settings
      // holds the grant key. ──
      await drainBoth();
      const landed = await pollUntil(
        async () => {
          await mergeBoth();
          await drainBoth();
          const v = await settingValue(dbB.sql, CROSS_HIVE_GRANTS_KEY);
          return v && typeof v === 'object' ? v : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(landed, "the cross-hive grant never federated to B's hive_settings").toBeTruthy();

      // ── THE PROOF: B now READS the grant + ADMITS the once-denied ask. ──
      const bGrants = await loadCrossHiveGrants(WORKSPACE_ID, HIVE_SLUG, dbB.sql);
      expect(
        bGrants.some((g) => g.peerHivePubkey === PEER_HIVE_X && g.allowedKinds.includes('ask')),
        'B did not read the federated inbound grant',
      ).toBe(true);
      const after = await admitOn(dbB.sql);
      expect(after.admitted, "B should ADMIT the ask once the grant federated (G25)").toBe(true);
    },
    60_000,
  );

  it(
    'G26: concurrent hive_settings writers converge on the higher-ts value (PG-level LWW)',
    async () => {
      const { dbA, dbB, mergeBoth, drainBoth } = await bootTwoHivePeers();
      const KEY = 'concurrency-ceiling';

      // A writes 100; B writes 200 to the SAME key — concurrent, single-writer-each.
      // The capture trigger stamps fed_ts from wall-clock; we want B's write to carry
      // a strictly-higher fed_ts so the convergence target is deterministic (200).
      await writeSetting(dbA.sql, KEY, 100);
      // tiny gap so B's capture wall-clock fed_ts is strictly newer than A's
      await new Promise((r) => setTimeout(r, 5));
      await writeSetting(dbB.sql, KEY, 200);

      // Federate both directions until BOTH peers converge on the SAME value.
      const converged = await pollUntil(
        async () => {
          await drainBoth();
          await mergeBoth();
          await drainBoth();
          const a = await settingValue(dbA.sql, KEY);
          const b = await settingValue(dbB.sql, KEY);
          return a != null && a === b ? { a, b } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(converged, 'the two peers never converged on a single hive_settings value').toBeTruthy();
      // The higher-ts write (200) is the LWW winner on BOTH peers.
      expect(converged!.a, "A did not converge on the higher-ts value").toBe(200);
      expect(converged!.b, "B did not converge on the higher-ts value").toBe(200);
    },
    60_000,
  );
});

/** Write a hive_settings value directly (JSON-text), firing the mig-186 capture
 *  trigger — the same write shape `setHiveSetting` produces, without the Hive-exists
 *  guard (both peers already seeded the Hive identity row). */
async function writeSetting(sql: Parameters<typeof loadCrossHiveGrants>[2], key: string, value: number): Promise<void> {
  const now = Date.now();
  await sql!`
    INSERT INTO harness_shared.hive_settings
      (workspace_id, harness_slug, setting_key, value, created_at, updated_at)
    VALUES (${WORKSPACE_ID}, ${HIVE_SLUG}, ${key}, ${JSON.stringify(value)}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, setting_key) DO UPDATE SET
      value = EXCLUDED.value, updated_at = ${now}
  `;
}
