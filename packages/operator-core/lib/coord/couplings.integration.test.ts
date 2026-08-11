/**
 * couplings.integration.test.ts — read-time retirement for declared coupling
 * edges (EI-20185949236150766).
 *
 * Coupling rows are durable audit state, but a coupled edge is useful only while
 * both owner ids still resolve to a live presence/session-log owner. These tests
 * exercise the real listCouplingsFor SQL so the liveness guard cannot silently
 * regress to the old expires_at-only predicate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import {
  declareCoupling,
  listCouplingsFor,
  suppressCoupling,
} from './couplings';

const WS = 'coupling-retirement-ei-20185949236150766';
const PREFIX = 'coupling-retire-';
const owner = (suffix: string) => `${PREFIX}${suffix}`;

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

async function seedPresence(ownerId: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${WS}, 'coupling-test', now())
  `;
}

async function seedRecordedSession(ownerId: string, opts: { ageSeconds?: number; ended?: boolean } = {}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, started_at, ended_at)
    VALUES (
      ${WS}, 'console', ${ownerId},
      now() - ${`${opts.ageSeconds ?? 60} seconds`}::interval,
      ${opts.ended ? new Date() : null}
    )
  `;
}

async function seedCoupling(a: string, b: string): Promise<void> {
  const edge = await declareCoupling({
    agentA: a,
    agentB: b,
    declaredBy: owner('declarer'),
    reason: 'coupling retirement integration test',
    workspaceId: WS,
  });
  expect(edge).not.toBeNull();
}

async function clean(): Promise<void> {
  await admin`DELETE FROM harness_shared.agent_couplings WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.coord_presence WHERE owner_id LIKE ${`${PREFIX}%`}`;
  await admin`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id LIKE ${`${PREFIX}%`}`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});

beforeEach(clean);

afterAll(async () => {
  await clean().catch(() => {});
  await fx.dispose();
});

describe('listCouplingsFor read-time liveness retirement', () => {
  it('keeps a coupled edge for two live presence members', async () => {
    const a = owner('live-a');
    const b = owner('live-b');
    await seedPresence(a);
    await seedPresence(b);
    await seedCoupling(a, b);

    const edges = await listCouplingsFor(a, WS);
    expect(edges.map((e) => [e.state, e.agentA, e.agentB])).toEqual([
      ['coupled', ...[a, b].sort()],
    ]);
  });

  it('retires a coupled edge when a member is reaped, but keeps a recorded-live fallback', async () => {
    const a = owner('present');
    const b = owner('reaped');
    await seedPresence(a);
    await seedCoupling(a, b);

    // No presence or live session-log row for b is the definitive reaped-owner
    // shape. The coupling row remains in storage, but no longer reaches readers.
    expect(await listCouplingsFor(a, WS)).toEqual([]);

    // A recorded session is authoritative even before b self-registers presence.
    await seedRecordedSession(b);
    expect((await listCouplingsFor(a, WS)).map((e) => e.state)).toEqual(['coupled']);

    // Ended session-log rows do not keep an otherwise absent owner alive.
    await admin`UPDATE harness_shared.adv_sessions SET ended_at = now() WHERE coord_owner_id = ${b}`;
    expect(await listCouplingsFor(a, WS)).toEqual([]);
  });

  it('always returns a non-expired suppression, even when both members are gone', async () => {
    const a = owner('suppressed-a');
    const b = owner('suppressed-b');
    const edge = await suppressCoupling({
      agentA: a,
      agentB: b,
      declaredBy: owner('declarer'),
      reason: 'preserve the D-061 mask after retirement',
      workspaceId: WS,
    });
    expect(edge?.state).toBe('suppressed');

    const edges = await listCouplingsFor(a, WS);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.state).toBe('suppressed');
  });
});

/**
 * D-006 (coupling-signal-liveness-and-lifecycle-2026-08-11, P-006): declaring a
 * coupling with no `ttlSec` leaves NO expiry. That default is a DECISION, not an
 * accident, so it is pinned here — the whole point of P-006 was that the current
 * "permanent by default" arose because nobody ever chose it.
 *
 * Why a default TTL is the wrong shape, in one line: it fails SILENTLY. A too-short
 * expiry makes two live agents stop seeing each other with nothing raised and no
 * verdict changed — the same confident-wrong-answer class as D-003 and D-004, which
 * is what this plan exists to remove, not to add. Measured ground: every declared
 * edge in this workspace is a supervisory relationship whose shared-live duration
 * ran 3.6h-63h, so any TTL short enough to retire a finished edge would have cut
 * live ones, and any TTL long enough to be safe retires nothing that the read-time
 * liveness guard above does not already retire.
 */
describe('D-006: no default TTL on a declared coupling', () => {
  it('leaves expiresAt null when ttlSec is omitted, and the edge stays readable', async () => {
    const a = owner('nottl-a');
    const b = owner('nottl-b');
    await seedPresence(a);
    await seedPresence(b);

    const edge = await declareCoupling({
      agentA: a,
      agentB: b,
      declaredBy: owner('declarer'),
      reason: 'D-006: a supervisory edge must not expire on a clock',
      workspaceId: WS,
    });

    // The assertion that fails the moment someone gives ttlSec a default.
    expect(edge?.expiresAt).toBeNull();
    await expect(
      admin`SELECT expires_at FROM harness_shared.agent_couplings WHERE workspace_id = ${WS}`,
    ).resolves.toEqual([{ expires_at: null }]);

    expect((await listCouplingsFor(a, WS)).map((e) => e.state)).toEqual(['coupled']);
  });

  it('CONTROL: an explicit ttlSec is honoured end-to-end, so the null-default assertion cannot pass by TTLs being dead', async () => {
    const a = owner('ttl-a');
    const b = owner('ttl-b');
    await seedPresence(a);
    await seedPresence(b);

    const edge = await declareCoupling({
      agentA: a,
      agentB: b,
      declaredBy: owner('declarer'),
      reason: 'D-006 calibration: the bounded "for the next hour" case',
      ttlSec: 3600,
      workspaceId: WS,
    });

    // The writer really does set an expiry when asked...
    expect(edge?.expiresAt).not.toBeNull();
    expect((await listCouplingsFor(a, WS)).map((e) => e.state)).toEqual(['coupled']);

    // ...and the reader really does retire it once that expiry passes. Without
    // this leg, the test above would still pass if TTLs were entirely broken,
    // which would make "expiresAt is null" evidence of nothing at all.
    await admin`
      UPDATE harness_shared.agent_couplings
         SET expires_at = clock_timestamp() - interval '1 minute'
       WHERE workspace_id = ${WS}
    `;
    expect(await listCouplingsFor(a, WS)).toEqual([]);
  });
});
