/**
 * presence-recorded-wakeable.integration.test.ts — REPRODUCTION for the
 * launch-wakeability gap (the Mac-VM "fix deployed, still wakeable:0" report).
 *
 * The bootstrap-su launch arm creates a BRAND-NEW combination the roster never
 * saw before: an `adv_sessions`-recorded session with an armed `coord:inbox-wake`
 * await but NO `coord_presence` row (it never self-registered via orient).
 * Historically arming ONLY ever happened alongside self-registration (the
 * SessionStart hook / orient both arm AND write coord_presence), so the
 * recorded-live + armed → `parked` render path was untested. This pins it down
 * against REAL Postgres: record (bootstrap-su) → arm (the fix) → assemble the
 * roster → assert `parked`/wakeable, with the unarmed `recorded` case as contrast.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { assemblePresenceSnapshot } from './presence-snapshot';
import { recordAdvSession } from '../../adv-sessions';
import { upsertInboxWakeAwait } from '../../events/await/store';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { inboxWakeKey } from './inbox-wake';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;
const WS = 'default';

async function cleanup(): Promise<void> {
  await admin`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id LIKE 'su-RECTEST-%'`;
  await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE 'su-RECTEST-%'`;
  await admin`DELETE FROM harness_shared.coord_presence WHERE owner_id LIKE 'su-RECTEST-%'`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
  await cleanup();
}, 120_000);
afterAll(async () => {
  await cleanup().catch(() => {});
  await fx.dispose();
});
beforeEach(cleanup);

function findRow(snap: { active: Record<string, unknown>[]; stale?: Record<string, unknown>[] }, owner: string) {
  return [...(snap.active ?? []), ...(snap.stale ?? [])].find((r) => r.ownerId === owner);
}

describe('launch-wakeability: a recorded-live session ARMED at launch (no coord_presence row)', () => {
  it('record → arm → renders PARKED/wakeable (workspace scope) — the fix end-to-end', async () => {
    const sid = 'su-RECTEST-armed';
    // 1. bootstrap-su's recordAdvSession (visible as a recorded-live session).
    await recordAdvSession({ workspaceId: WS, mode: 'console', agent: 'claude', coordOwnerId: sid });
    // 2. bootstrap-su's armInboxWake write (the fix) — NO coord_presence row written.
    await upsertInboxWakeAwait({ subscriberId: sid, eventKey: inboxWakeKey(sid), workspaceId: WS });

    const snap = await assemblePresenceSnapshot({ scope: 'workspace', wsId: WS, potId: null });
    const row = findRow(snap, sid);
    expect(row, 'the recorded+armed session must appear in the roster').toBeDefined();
    expect(row!.wakeable).toBe(true);
    expect(row!.sessionState).toBe('parked');
    expect(snap.summary.wakeable).toBeGreaterThanOrEqual(1);
    expect(snap.summary.byState.parked).toBeGreaterThanOrEqual(1);
  });

  it('FAITHFUL: record → the REAL armInboxWake (what bootstrap-su calls) → parked', async () => {
    const sid = 'su-RECTEST-realarm';
    await recordAdvSession({ workspaceId: WS, mode: 'console', agent: 'claude', coordOwnerId: sid });
    // Exactly the bootstrap-su call site — armInboxWake (captureWakeHandleForOwner →
    // upsertInboxWakeAwait), not the raw upsert. Proves the WRITE path persists an
    // await for a brand-new, never-self-registered session.
    await armInboxWake({ ownerId: sid, workspaceId: WS });

    const snap = await assemblePresenceSnapshot({ scope: 'workspace', wsId: WS, potId: null });
    const row = findRow(snap, sid);
    expect(row, 'a session armed via the real armInboxWake must be parked').toBeDefined();
    expect(row!.wakeable).toBe(true);
    expect(row!.sessionState).toBe('parked');
  });

  it('CONTRAST: recorded-live but NOT armed → recorded/not-wakeable (the pre-fix state)', async () => {
    const sid = 'su-RECTEST-unarmed';
    await recordAdvSession({ workspaceId: WS, mode: 'console', agent: 'claude', coordOwnerId: sid });

    const snap = await assemblePresenceSnapshot({ scope: 'workspace', wsId: WS, potId: null });
    const row = findRow(snap, sid);
    expect(row, 'an unarmed recorded session is still visible').toBeDefined();
    expect(row!.wakeable).toBe(false);
    expect(row!.sessionState).toBe('recorded');
  });
});
