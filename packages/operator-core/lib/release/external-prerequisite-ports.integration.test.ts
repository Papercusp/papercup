/**
 * external-prerequisite-ports.integration.test.ts — P-005 of
 * typed-external-prerequisite-attestations-for-release-gates-2026-08-15.
 *
 * Proves what the seam-injected unit test CANNOT: that the real SQL behind
 * loadAttestation / saveAttestation / readScopePrerequisiteReadiness actually works
 * against the migrated `harness_shared.external_prerequisite_attestations` table
 * (migration 928). Nothing had ever read that table before this item, so the round
 * trip, the UPSERT key, the scope isolation and the instant rendering were all
 * unexercised.
 *
 * The instant rendering is the specific reason this file has to exist. The SELECTs
 * render `observed_at`/`expires_at` with an explicit `AT TIME ZONE 'UTC'` to_char
 * rather than `::text`, because `rowToAttestation` feeds them to `Date.parse` and a
 * `::text` timestamptz carries the session's offset. A mock returning hand-written
 * ISO strings would pass either way — only real Postgres can falsify it.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
  };
});

const {
  createProbeRunnerPorts,
  readScopePrerequisiteReadiness,
  allPrerequisitesSatisfied,
  refusePrerequisites,
} = await import('./external-prerequisite-ports');
const { buildAttestation } = await import('./external-prerequisites');
const { createOrgTestDb } = await import('../../test/_org-test-db');

import type { ExternalPrerequisiteSpec } from './external-prerequisites';

const WS = 'ws-extprereq-integration';
const HARNESS = 'papercusp';
const SCOPE = { harnessSlug: HARNESS, workspaceId: WS } as const;

let db: OrgTestDb;

function spec(overrides: Partial<ExternalPrerequisiteSpec> = {}): ExternalPrerequisiteSpec {
  return {
    key: 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    requiredNames: ['STRIPE_WEBHOOK_SECRET'],
    target: { host: 'api.stripe.com' },
    probeRef: 'probe:stripe-endpoint',
    expirySec: 3600,
    owningWorkItem: 'WI-1',
    completionEvent: 'external-prerequisite:ready:stripe-webhook',
    ...overrides,
  };
}

/** A receipt observed at `observedAt`, expiring `expirySec` later. */
function receipt(opts: { key?: string; present?: boolean; observedAt?: string; expirySec?: number } = {}) {
  return buildAttestation({
    key: opts.key ?? 'stripe-webhook',
    capabilityKind: 'stripe-endpoint',
    present: opts.present ?? true,
    binding: { endpointId: 'we_123' },
    observedAt: opts.observedAt ?? '2026-08-24T11:00:00.000Z',
    expirySec: opts.expirySec ?? 3600,
    provenance: 'probe',
    probeRef: 'probe:stripe-endpoint',
  });
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
});

afterAll(async () => {
  await db?.cleanup();
});

describe('attestation round trip against real Postgres', () => {
  it('writes a receipt and reads back an IDENTICAL attestation', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    const written = receipt({ key: 'roundtrip' });
    await ports.saveAttestation(written);

    const read = await ports.loadAttestation('roundtrip');
    // The instant fields are the falsifiable part: a `::text` render would come back
    // with a session offset (e.g. "2026-08-24 11:00:00+00") instead of this.
    expect(read).toEqual(written);
    expect(read?.observedAt).toBe('2026-08-24T11:00:00.000Z');
  });

  it('returns null for a key that was never written', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    await expect(ports.loadAttestation('never-written')).resolves.toBeNull();
  });

  it('UPSERTS on (workspace, harness, prerequisite_key) — a re-probe replaces, never duplicates', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    await ports.saveAttestation(receipt({ key: 'upsert', present: true }));
    await ports.saveAttestation(
      receipt({ key: 'upsert', present: false, observedAt: '2026-08-24T11:30:00.000Z' }),
    );

    const rows = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.external_prerequisite_attestations
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND prerequisite_key = 'upsert'
    `;
    expect(rows[0].n).toBe(1);

    const read = await ports.loadAttestation('upsert');
    expect(read?.present).toBe(false);
    expect(read?.observedAt).toBe('2026-08-24T11:30:00.000Z');
  });

  it('isolates by scope — another harness\'s receipt is not visible', async () => {
    const mine = createProbeRunnerPorts(SCOPE);
    const other = createProbeRunnerPorts({ harnessSlug: 'some-other-harness', workspaceId: WS });
    await other.saveAttestation(receipt({ key: 'scoped' }));

    await expect(mine.loadAttestation('scoped')).resolves.toBeNull();
    await expect(other.loadAttestation('scoped')).resolves.not.toBeNull();
  });

  it('stores binding metadata as a jsonb object and reads it back intact', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    await ports.saveAttestation(receipt({ key: 'binding' }));
    const read = await ports.loadAttestation('binding');
    expect(read?.binding).toEqual({ endpointId: 'we_123' });
  });
});

describe('the gate read against real Postgres', () => {
  it('resolves ready / expired / absent from stored rows at one instant', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    // live: observed 11:00, +1h  -> expires 12:00
    await ports.saveAttestation(receipt({ key: 'live', observedAt: '2026-08-24T11:00:00.000Z' }));
    // lapsed: observed 09:00, +1h -> expires 10:00
    await ports.saveAttestation(receipt({ key: 'lapsed', observedAt: '2026-08-24T09:00:00.000Z' }));
    // 'unprobed' is deliberately never written.

    const got = await readScopePrerequisiteReadiness(
      SCOPE,
      [spec({ key: 'live' }), spec({ key: 'lapsed' }), spec({ key: 'unprobed' })],
      { nowMs: Date.parse('2026-08-24T11:30:00.000Z') },
    );

    expect(got.map((g) => [g.key, g.readiness.state])).toEqual([
      ['live', 'ready'],
      ['lapsed', 'expired'],
      ['unprobed', 'absent'],
    ]);
    expect(allPrerequisitesSatisfied(got)).toBe(false);
  });

  it('goes stale-proof against the real store: the SAME row flips ready->expired with NO write', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    await ports.saveAttestation(receipt({ key: 'staleproof', observedAt: '2026-08-24T11:00:00.000Z' }));
    const specs = [spec({ key: 'staleproof' })];

    const before = await readScopePrerequisiteReadiness(SCOPE, specs, {
      nowMs: Date.parse('2026-08-24T11:59:59.000Z'),
    });
    const after = await readScopePrerequisiteReadiness(SCOPE, specs, {
      nowMs: Date.parse('2026-08-24T12:00:00.000Z'),
    });

    expect(before[0].satisfied).toBe(true);
    expect(after[0].satisfied).toBe(false);
    expect(after[0].readiness.state).toBe('expired');

    // Nothing wrote a row to make the lapse true — the whole point of D-003.
    const rows = await db.adminSql<{ updated_at: string }[]>`
      SELECT updated_at::text AS updated_at
        FROM harness_shared.external_prerequisite_attestations
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND prerequisite_key = 'staleproof'
    `;
    expect(rows).toHaveLength(1);
  });

  it('reads an empty scope without querying for keys', async () => {
    await expect(readScopePrerequisiteReadiness(SCOPE, [], { nowMs: Date.now() })).resolves.toEqual([]);
  });
});

/**
 * FALSIFIABILITY CONTROL — the deliberately-wrong implementation, kept permanently.
 *
 * The round-trip assertions above are only meaningful if the explicit UTC `to_char`
 * rendering is load-bearing. This runs the NAIVE `::text` variant of the very same
 * SELECT against the very same row, and pins what it actually produces. If Postgres
 * ever starts rendering `::text` as strict ISO-8601 UTC — or if someone "simplifies"
 * the production query to `::text` — the control below stops differing and this test
 * fails, which is the signal that the guard has gone vacuous.
 *
 * The repo's mutation-probe tiers prefer exactly this over an in-tree mutation: no
 * shared-tree write, no sweep race, and the control cannot rot out of the suite.
 */
describe('falsifiability control: the ::text rendering really is wrong', () => {
  it('differs from the ISO rendering the production query uses', async () => {
    const ports = createProbeRunnerPorts(SCOPE);
    await ports.saveAttestation(receipt({ key: 'control', observedAt: '2026-08-24T11:00:00.000Z' }));

    const naive = await db.adminSql<{ observed_at: string }[]>`
      SELECT observed_at::text AS observed_at
        FROM harness_shared.external_prerequisite_attestations
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND prerequisite_key = 'control'
    `;
    const strict = await ports.loadAttestation('control');

    // The production path yields exactly the contract's "ISO-8601 UTC instant".
    expect(strict?.observedAt).toBe('2026-08-24T11:00:00.000Z');
    // The naive path does NOT — this is what the explicit rendering exists to avoid.
    // (Postgres renders a timestamptz in the session timezone, e.g.
    // "2026-08-24 11:00:00+00", which is not the ISO form and carries an offset.)
    expect(naive[0].observed_at).not.toBe(strict?.observedAt);
  });
});

/**
 * THE P-005 END-TO-END TEST, in the item's own words: "declare a prerequisite, probe
 * it to ready, expire it, observe the [gate verdict] and the typed refusal."
 *
 * The item's third clause said "observe the scorecard criterion refresh". D-003 voided
 * that half — the refresh port named a per-criterion scorecard write that does not
 * exist, and the concern it addressed is met by derivation. What the item was actually
 * protecting is asserted here instead, and more strictly: the SAME stored receipt
 * yields ready and then expired with no write in between, so a gate cannot sit green
 * across a window in which the external wall changed.
 *
 * This drives the REAL runner (runPrerequisiteProbe) through the REAL ports against
 * REAL migrated Postgres — no seams — so the lifecycle is exercised end to end.
 */
describe('P-005 end-to-end lifecycle: declare -> ready -> expire -> typed refusal', () => {
  it('walks the full lifecycle through the real runner and real store', async () => {
    const { runPrerequisiteProbe, createProbeRegistry } = await import(
      './external-prerequisite-probe-runner'
    );

    const emitted: { key: string; summary: string }[] = [];
    const wakes: string[] = [];
    // Storage is REAL; only the announce side effects are captured, because asserting
    // on the event bus and an agent inbox is a different subsystem's job.
    const ports = {
      ...createProbeRunnerPorts(SCOPE),
      async emitEvent(e: { key: string; summary: string }) {
        emitted.push({ key: e.key, summary: e.summary });
      },
      async wakeLaneOwner(w: { owningWorkItem: string }) {
        wakes.push(w.owningWorkItem);
      },
    };

    // 1. DECLARE a prerequisite, with a probe that reports the wall standing.
    const declared = spec({
      key: 'e2e-stripe',
      owningWorkItem: 'WI-e2e',
      expirySec: 3600,
      completionEvent: 'external-prerequisite:ready:e2e-stripe',
    });
    const registry = createProbeRegistry({
      'probe:stripe-endpoint': async () => ({
        status: 'present' as const,
        binding: { endpointId: 'we_e2e' },
      }),
    });

    // 2. PROBE IT TO READY — observed 11:00, so the receipt expires 12:00.
    const readyRun = await runPrerequisiteProbe(declared, registry, ports, {
      nowMs: Date.parse('2026-08-24T11:00:00.000Z'),
    });
    expect(readyRun.readiness.state).toBe('ready');
    expect(readyRun.satisfied).toBe(true);
    expect(readyRun.attestationWritten).toBe(true);
    expect(readyRun.transition).toBe('became-ready');
    // The absent->ready edge fired the spec's declared completion event.
    expect(emitted.map((e) => e.key)).toContain('external-prerequisite:ready:e2e-stripe');
    expect(wakes).toContain('WI-e2e');

    // The gate sees it standing, and refuses nothing.
    const whileReady = await readScopePrerequisiteReadiness(SCOPE, [declared], {
      nowMs: Date.parse('2026-08-24T11:30:00.000Z'),
    });
    expect(allPrerequisitesSatisfied(whileReady)).toBe(true);
    expect(refusePrerequisites(whileReady)).toBeNull();

    // 3. EXPIRE IT — purely by moving the evaluation instant past expiry. NOTHING
    //    writes a row to make this true, which is the derivation D-003 relies on.
    const whileExpired = await readScopePrerequisiteReadiness(SCOPE, [declared], {
      nowMs: Date.parse('2026-08-24T12:00:00.000Z'),
    });

    // 4. OBSERVE THE TYPED REFUSAL — named, structured, carrying the accountable lane.
    const refusal = refusePrerequisites(whileExpired);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('external-prerequisite-not-standing');
    expect(refusal!.prerequisites).toEqual([
      {
        key: 'e2e-stripe',
        capabilityKind: 'stripe-endpoint',
        owningWorkItem: 'WI-e2e',
        state: 'expired',
        reason: 'receipt-expired',
        expiredAt: '2026-08-24T12:00:00.000Z',
      },
    ]);
    // An operator reads WHICH wall and WHOSE lane straight off the refusal.
    expect(refusal!.summary).toContain('e2e-stripe');
    expect(refusal!.summary).toContain('WI-e2e');
  });

  it('an INDETERMINATE probe refuses without ever writing a false absence (D-002)', async () => {
    const { runPrerequisiteProbe, createProbeRegistry } = await import(
      './external-prerequisite-probe-runner'
    );
    const ports = {
      ...createProbeRunnerPorts(SCOPE),
      async emitEvent() {},
      async wakeLaneOwner() {},
    };
    const declared = spec({ key: 'e2e-indeterminate', owningWorkItem: 'WI-ind' });
    const registry = createProbeRegistry({
      'probe:stripe-endpoint': async () => ({ status: 'indeterminate' as const, reason: 'timeout' }),
    });

    const run = await runPrerequisiteProbe(declared, registry, ports, {
      nowMs: Date.parse('2026-08-24T11:00:00.000Z'),
    });
    expect(run.satisfied).toBe(false);
    expect(run.attestationWritten).toBe(false);

    // The store was NOT taught "the wall is down" — there is simply no row.
    const rows = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.external_prerequisite_attestations
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND prerequisite_key = 'e2e-indeterminate'
    `;
    expect(rows[0].n).toBe(0);

    // And the gate still fails CLOSED, refusing with 'no-attestation' rather than the
    // positive claim 'probe-reported-absent'.
    const snap = await readScopePrerequisiteReadiness(SCOPE, [declared], {
      nowMs: Date.parse('2026-08-24T11:00:00.000Z'),
    });
    expect(refusePrerequisites(snap)!.prerequisites[0].reason).toBe('no-attestation');
  });
});

describe('the store refuses what the contract forbids', () => {
  it('rejects a receipt already spent on arrival (expiry_chk)', async () => {
    // expires_at > observed_at is a CHECK constraint, not just an application rule.
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.external_prerequisite_attestations
          (workspace_id, harness_slug, prerequisite_key, capability_kind, present,
           binding, observed_at, expires_at, provenance, probe_ref)
        VALUES (${WS}, ${HARNESS}, 'already-spent', 'stripe-endpoint', true, '{}'::jsonb,
                '2026-08-24T11:00:00Z'::timestamptz, '2026-08-24T11:00:00Z'::timestamptz,
                'probe', 'probe:stripe-endpoint')
      `,
    ).rejects.toThrow(/expiry_chk/);
  });

  it('rejects a non-object binding (the zero-secret defence in depth)', async () => {
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.external_prerequisite_attestations
          (workspace_id, harness_slug, prerequisite_key, capability_kind, present,
           binding, observed_at, expires_at, provenance, probe_ref)
        VALUES (${WS}, ${HARNESS}, 'bare-string', 'stripe-endpoint', true,
                '"sk_live_leaked"'::jsonb,
                '2026-08-24T11:00:00Z'::timestamptz, '2026-08-24T12:00:00Z'::timestamptz,
                'probe', 'probe:stripe-endpoint')
      `,
    ).rejects.toThrow(/binding_is_object_chk/);
  });
});
