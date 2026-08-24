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

const { createProbeRunnerPorts, readScopePrerequisiteReadiness, allPrerequisitesSatisfied } =
  await import('./external-prerequisite-ports');
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
