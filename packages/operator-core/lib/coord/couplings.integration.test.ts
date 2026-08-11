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
