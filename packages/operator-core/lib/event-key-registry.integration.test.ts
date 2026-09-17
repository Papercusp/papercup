/**
 * event-key-registry.integration.test.ts — the event-key registry's THREE SQL PATHS
 * (`harness_shared.event_key_registry` + the `event_key_registry_attested` view,
 * migration 1170; identities-v1-2026-08-30 P-029 half (a) / D-058, D-061) against real PG.
 *
 * WHY THIS FILE EXISTS. `event-key-registry-store.test.ts` is 9/9 green and covers ONLY
 * the pure helpers (normalizeEventKey + the closed status sets) — ZERO of its assertions
 * reach SQL (D-062, D-063). So D-058's load-bearing curated/derived split was held by a
 * TYPE and a CHECK CONSTRAINT with nothing executing behind either. A split that is only
 * DECLARED is the same hand-authored lie EVENT_CATALOG drifted into, one level up.
 *
 * Mirrors datatype-registry.integration.test.ts: the store is transport-agnostic (every
 * fn TAKES the `sql` handle), so we pass the org fixture's admin (RLS-bypass) client and
 * scope by the explicit workspaceId arg. createOrgTestDb applies the FULL migration set,
 * so a broken 1170 fails fixture setup itself — the "does this migration apply on the real
 * baseline?" check is preserved without replaying it here.
 *
 * Validates: curated registration leaves all three derived columns NULL (NOT-YET-DERIVED);
 * the derived-dated CHECK refuses an UNDATED derived write; recordEventKeyDerivation dates
 * every reading it writes; re-registration refreshes curation without touching a
 * measurement; NULL and FALSE emitter_exists stay distinguishable in the audit list; and
 * the attested view's contradicts_scan is three-valued-safe against a seeded fire ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  registerEventKey,
  getEventKey,
  listEventKeys,
  setEventKeyReviewStatus,
  recordEventKeyDerivation,
  getAttestedEventKey,
  listUnderivedEventKeys,
  listScanContradictions,
} from './event-key-registry-store';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('event_key_registry store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('registers the CURATED half and leaves ALL THREE derived columns NULL (D-058)', async () => {
    const ws = 'ws-ek-curated';
    const row = await registerEventKey(db.adminSql, {
      workspaceId: ws,
      eventKey: 'work-item:done:WI-2143761',
      title: 'Work item done',
      description: 'fires when a work-item reaches a terminal state',
      keyPattern: 'work-item:done:*',
      contributor: 'core',
      tags: ['work-item'],
      createdBy: 'su-5f956',
    });
    expect(row.eventKey).toBe('work-item:done:WI-2143761');
    expect(row.keyPattern).toBe('work-item:done:*');
    expect(row.contributor).toBe('core');
    expect(row.status).toBe('active');
    expect(row.published).toBe(false); // registration never publishes (D-057)
    expect(row.reviewStatus).toBe('none');
    expect(row.tags).toEqual(['work-item']);

    // THE ASSERTION THIS FILE EXISTS FOR: nothing has measured anything, so every derived
    // column is NULL — not false, not 0. A `false` here would read as "measured, and the
    // answer is no", which is exactly the drift D-058 route (a) exists to prevent.
    expect(row.emitter).toBeNull();
    expect(row.emitterExists).toBeNull();
    expect(row.emitSiteCount).toBeNull();
    expect(row.derivedAt).toBeNull();
    expect(row.derivedFrom).toBeNull();

    // normalizeEventKey trims on the read path too (an event key is matched EXACTLY, so
    // the read and write paths must agree on the canonical form or nothing rendezvouses).
    expect((await getEventKey(db.adminSql, ws, '  work-item:done:WI-2143761  '))?.title)
      .toBe('Work item done');
    expect((await listEventKeys(db.adminSql, ws)).map((r) => r.eventKey))
      .toEqual(['work-item:done:WI-2143761']);
  });

  it('the derived-dated CHECK refuses an UNDATED derived write — with a dated positive control', async () => {
    const ws = 'ws-ek-check';
    await registerEventKey(db.adminSql, {
      workspaceId: ws, eventKey: 'deploy:done', title: 'Deploy done', description: 'a deploy finished',
    });

    // Hand-setting a derived column with no derived_at is the drift D-058 forbids: a
    // reading nobody can date is indistinguishable from a hand-set one.
    await expect(db.adminSql`
      UPDATE harness_shared.event_key_registry
         SET emitter_exists = false
       WHERE workspace_id = ${ws} AND event_key = 'deploy:done'`,
    ).rejects.toThrow(/event_key_registry_derived_dated_ck/);

    await expect(db.adminSql`
      UPDATE harness_shared.event_key_registry
         SET emitter = 'packages/operator-core/lib/release/deploy.ts'
       WHERE workspace_id = ${ws} AND event_key = 'deploy:done'`,
    ).rejects.toThrow(/event_key_registry_derived_dated_ck/);

    // A NEGATIVE site count is refused by its own constraint, dated or not.
    await expect(db.adminSql`
      UPDATE harness_shared.event_key_registry
         SET emit_site_count = -1, derived_at = now(), derived_from = 'sha'
       WHERE workspace_id = ${ws} AND event_key = 'deploy:done'`,
    ).rejects.toThrow(/event_key_registry_emit_count_ck/);

    // POSITIVE CONTROL. The same write WITH a date succeeds — so the three refusals above
    // are the constraints working, not an UPDATE that could never have applied (a broken
    // statement rejects for the wrong reason and reads exactly like a guard doing its job).
    await db.adminSql`
      UPDATE harness_shared.event_key_registry
         SET emitter_exists = false, derived_at = now(), derived_from = 'sha-positive-control'
       WHERE workspace_id = ${ws} AND event_key = 'deploy:done'`;
    const after = await getEventKey(db.adminSql, ws, 'deploy:done');
    expect(after?.emitterExists).toBe(false);
    expect(after?.derivedAt).not.toBeNull();
    expect(after?.derivedFrom).toBe('sha-positive-control');
  });

  it('recordEventKeyDerivation DATES every reading it writes (derivedAt defaults to now)', async () => {
    const ws = 'ws-ek-derive';
    await registerEventKey(db.adminSql, {
      workspaceId: ws, eventKey: 'release:green', title: 'Release green', description: 'the gate went green',
    });

    const before = Date.now();
    // `derivedAt` OMITTED. The documented contract is "defaults to now()" — and it has to
    // hold, because the derived-dated CHECK above refuses a NULL derived_at alongside a
    // derived value. So the sole derived writer would throw in its own default case.
    // Asserted rather than assumed for exactly that reason.
    const derived = await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'release:green',
      emitter: 'packages/operator-core/lib/release/green-checkpoint.ts',
      emitterExists: true, emitSiteCount: 3, derivedFrom: '2c884a197d',
    });
    expect(derived?.emitter).toBe('packages/operator-core/lib/release/green-checkpoint.ts');
    expect(derived?.emitterExists).toBe(true);
    expect(derived?.emitSiteCount).toBe(3);
    expect(derived?.derivedFrom).toBe('2c884a197d');
    expect(derived?.derivedAt).not.toBeNull();
    expect(Date.parse(derived!.derivedAt!)).toBeGreaterThanOrEqual(before - 5_000);

    // An explicit stamp is preserved verbatim (replaying an already-recorded scan).
    const replayed = await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'release:green', emitter: null, emitterExists: false,
      emitSiteCount: 0, derivedFrom: 'sha-replay', derivedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(replayed?.derivedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(replayed?.emitterExists).toBe(false);
    expect(replayed?.emitSiteCount).toBe(0); // a 0 that IS a measurement, because it is dated

    // Undateable provenance is refused before it can reach the table.
    await expect(recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'release:green', emitter: null, emitterExists: false,
      emitSiteCount: 0, derivedFrom: '   ',
    })).rejects.toThrow(/derivedFrom/);

    // A missing key is a null return, never a silent no-op that looks like a write.
    expect(await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'no-such-key', emitter: null, emitterExists: true,
      emitSiteCount: 1, derivedFrom: 'sha',
    })).toBeNull();
  });

  it('re-registering REFRESHES curation and leaves the derived reading untouched', async () => {
    const ws = 'ws-ek-recurate';
    await registerEventKey(db.adminSql, {
      workspaceId: ws, eventKey: 'lock:grant', title: 'Lock grant', description: 'first',
    });
    await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'lock:grant', emitter: 'packages/operator-core/lib/locks/grant.ts',
      emitterExists: true, emitSiteCount: 2, derivedFrom: 'sha-1',
    });

    const recurated = await registerEventKey(db.adminSql, {
      workspaceId: ws, eventKey: 'lock:grant', title: 'Lock grant',
      description: 'a file lock was granted to a waiter', contributor: 'core',
    });
    expect(recurated.description).toBe('a file lock was granted to a waiter'); // curation refreshed
    // A curation edit is NOT a measurement and must never look like one.
    expect(recurated.emitter).toBe('packages/operator-core/lib/locks/grant.ts');
    expect(recurated.emitterExists).toBe(true);
    expect(recurated.emitSiteCount).toBe(2);
    expect(recurated.derivedFrom).toBe('sha-1');
    expect((await listEventKeys(db.adminSql, ws)).length).toBe(1); // updated, not duplicated
  });

  it('listUnderivedEventKeys returns NEVER-MEASURED and MEASURED-ABSENT together, and derivedAt tells them apart', async () => {
    const ws = 'ws-ek-underived';
    for (const [key, title] of [
      ['never-scanned', 'a'], ['scanned-absent', 'b'], ['scanned-present', 'c'],
    ] as const) {
      await registerEventKey(db.adminSql, { workspaceId: ws, eventKey: key, title, description: title });
    }
    await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'scanned-absent', emitter: null, emitterExists: false,
      emitSiteCount: 0, derivedFrom: 'sha',
    });
    await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'scanned-present', emitter: 'x.ts', emitterExists: true,
      emitSiteCount: 1, derivedFrom: 'sha',
    });

    const rows = await listUnderivedEventKeys(db.adminSql, ws);
    expect(rows.map((r) => r.eventKey).sort()).toEqual(['never-scanned', 'scanned-absent']);
    // The whole point of the three-valued column: these two sit in the SAME audit list and
    // are NOT the same claim. Only derivedAt separates them.
    expect(rows.find((r) => r.eventKey === 'never-scanned')?.derivedAt).toBeNull();
    expect(rows.find((r) => r.eventKey === 'scanned-absent')?.derivedAt).not.toBeNull();
  });

  it('the attested view joins the LIVE fire ledger, and contradicts_scan is NULL-safe (D-061)', async () => {
    const ws = 'ws-ek-attested';
    for (const key of [
      'fired-but-scan-says-absent', 'fired-never-scanned', 'fired-scan-says-present', 'registered-never-fired',
    ]) {
      await registerEventKey(db.adminSql, { workspaceId: ws, eventKey: key, title: key, description: key });
    }
    await db.adminSql`
      INSERT INTO harness_shared.event_key_fires
        (workspace_id, event_key, first_fired_at, last_fired_at, last_fired_by, fire_count)
      VALUES
        (${ws}, 'fired-but-scan-says-absent', now(), now(), 'agent-a', 7),
        (${ws}, 'fired-never-scanned',        now(), now(), 'agent-b', 4),
        (${ws}, 'fired-scan-says-present',    now(), now(), 'agent-c', 2)`;
    await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'fired-but-scan-says-absent', emitter: null,
      emitterExists: false, emitSiteCount: 0, derivedFrom: 'sha',
    });
    await recordEventKeyDerivation(db.adminSql, {
      workspaceId: ws, eventKey: 'fired-scan-says-present', emitter: 'y.ts',
      emitterExists: true, emitSiteCount: 1, derivedFrom: 'sha',
    });

    // The reconciliation the view exists for: the scan said no emitter, the ledger watched
    // it fire 7 times. That refutes the DERIVATION, never the key.
    const refuted = await getAttestedEventKey(db.adminSql, ws, 'fired-but-scan-says-absent');
    expect(refuted?.fireCount).toBe(7);
    expect(refuted?.lastFiredBy).toBe('agent-a');
    expect(refuted?.firstFiredAt).not.toBeNull();
    expect(refuted?.contradictsScan).toBe(true);

    // THE NULL-SAFETY ASSERTION. emitter_exists IS NULL means nobody ever scanned, which
    // cannot contradict anything. `NOT emitter_exists` or `= false` would both get this
    // wrong, and the wrongness would look like a finding worth a peer's investigation.
    const neverScanned = await getAttestedEventKey(db.adminSql, ws, 'fired-never-scanned');
    expect(neverScanned?.emitterExists).toBeNull();
    expect(neverScanned?.fireCount).toBe(4);
    expect(neverScanned?.contradictsScan).toBe(false);

    const agreeing = await getAttestedEventKey(db.adminSql, ws, 'fired-scan-says-present');
    expect(agreeing?.contradictsScan).toBe(false);

    // Registered but never observed firing: the LEFT JOIN has no ledger row, so fire_count
    // is NULL and maps to 0 — a real measurement, not absence of evidence.
    const silent = await getAttestedEventKey(db.adminSql, ws, 'registered-never-fired');
    expect(silent?.fireCount).toBe(0);
    expect(silent?.lastFiredAt).toBeNull();
    expect(silent?.contradictsScan).toBe(false);

    expect((await listScanContradictions(db.adminSql, ws)).map((r) => r.eventKey))
      .toEqual(['fired-but-scan-says-absent']);
  });

  it('publication happens only on APPROVAL, and the registry is WORKSPACE-ISOLATED (D-057)', async () => {
    await registerEventKey(db.adminSql, {
      workspaceId: 'ws-ek-A', eventKey: 'pot:installed', title: 'Pot installed', description: 'a pot was installed',
    });
    expect((await setEventKeyReviewStatus(db.adminSql, 'ws-ek-A', 'pot:installed', 'pending'))?.published).toBe(false);
    expect((await setEventKeyReviewStatus(db.adminSql, 'ws-ek-A', 'pot:installed', 'approved'))?.published).toBe(true);
    // Publication is never a one-way latch: a later rejection un-publishes.
    expect((await setEventKeyReviewStatus(db.adminSql, 'ws-ek-A', 'pot:installed', 'rejected'))?.published).toBe(false);

    expect(await getEventKey(db.adminSql, 'ws-ek-B', 'pot:installed')).toBeNull();
    expect(await getAttestedEventKey(db.adminSql, 'ws-ek-B', 'pot:installed')).toBeNull();
    expect(await listEventKeys(db.adminSql, 'ws-ek-B')).toEqual([]);
  });
});
