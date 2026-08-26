/**
 * hive-members-drop-warning.test.ts — EI-18771324701216281 (second half).
 *
 * A cross-Hive roster drop used to be observable ONLY under `PAPERCUSP_A003_TRACE=1`,
 * i.e. off by default and off in every real install. On WI-559 that meant ~49,762 roster
 * rows were discarded in total silence while the joiner's `pot_members` read EMPTY — and
 * the emptiness was nearly taken as evidence of health. A drop that leaves the roster
 * permanently wrong must be audible without a debug env var.
 *
 * It also cannot be an unconditional warn: the drop is per-op and fires in the tens of
 * thousands, so an ungated line is its own outage. These tests pin the resulting contract:
 * FIRST occurrence is immediate (the one a human needs), the rest coalesce into at most one
 * line per window, and the suppressed COUNT rides along so the magnitude is never hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';

// Same convention as hive-members-cache-invalidation.test.ts: stub only the post-write
// cache invalidation, keeping the rest of the module real. Needed because the MATCHING-row
// case runs the full apply path, and the real invalidation waits on a timer that never
// fires under this file's fake timers.
vi.mock('../hive-member-identity-set', async (orig) => ({
  ...(await orig<typeof import('../hive-member-identity-set')>()),
  invalidateHiveMemberDeviceSet: vi.fn(),
}));

import {
  buildHiveMembersProjection,
  __resetA003DropWarnThrottleForTest,
  type HiveMemberRow,
} from './hive-members';

const fakeSql = ((_s: TemplateStringsArray, ..._v: unknown[]) =>
  Promise.resolve([])) as unknown as postgres.Sql;

const OPTS = { workspaceId: 'ws', harnessSlug: 'hive-home', sql: fakeSql };
const LOCAL_PROVENANCE = { authorPubkey: '', origin: 'local' as const };

/** A roster row whose hive-home does NOT match the bound slug — the dropped case. */
function row(over: Partial<HiveMemberRow> = {}): HiveMemberRow {
  return {
    pot_home_slug: 'other-hive',
    github_user_id: 7,
    github_username: 'octo',
    device_attestations: [],
    revoked_pubkeys: [],
    binding_status: 'bound',
    ...over,
  };
}

describe('EI-18771324701216281 — a cross-Hive roster drop warns by default, rate-limited', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let nowMs = 0;

  // Control ONLY Date.now() (the throttle's clock) — deliberately NOT vi.useFakeTimers().
  // Faking every timer stalls the real write path this file also exercises (the
  // matching-row case hangs), and that write path is not what we are time-travelling.
  beforeEach(() => {
    __resetA003DropWarnThrottleForTest();
    nowMs = Date.parse('2026-07-27T00:00:00Z');
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    nowSpy.mockRestore();
  });

  it('warns on the FIRST drop with NO env var set — the regression this fixes', async () => {
    delete process.env.PAPERCUSP_A003_TRACE;
    const p = buildHiveMembersProjection(OPTS);
    await p.writeToPg(row(), LOCAL_PROVENANCE);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    // It must name BOTH slugs — the whole diagnostic value is the mismatch pair.
    expect(msg).toContain("'hive-home'");
    expect(msg).toContain("'other-hive'");
    // And it must kill the inference that actually cost time on WI-559.
    expect(msg).toContain('NOT evidence of health');
  });

  it('RATE-LIMITED: a burst emits once, and the suppressed COUNT rides the next window', async () => {
    const p = buildHiveMembersProjection(OPTS);
    for (let i = 0; i < 500; i++) await p.writeToPg(row(), LOCAL_PROVENANCE);
    expect(warn).toHaveBeenCalledTimes(1); // 500 drops, 1 line — not an outage

    // Next window: one line, carrying the 499 it swallowed. The magnitude is not lost.
    nowMs += 90_000;
    await p.writeToPg(row(), LOCAL_PROVENANCE);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('499 further drop(s) suppressed');
  });

  it('a DISTINCT mismatch is never masked by an already-throttled one', async () => {
    const p = buildHiveMembersProjection(OPTS);
    await p.writeToPg(row(), LOCAL_PROVENANCE);
    await p.writeToPg(row(), LOCAL_PROVENANCE); // suppressed
    expect(warn).toHaveBeenCalledTimes(1);

    // A different hive-home is a different problem and gets its own immediate line.
    await p.writeToPg(row({ pot_home_slug: 'third-hive' }), LOCAL_PROVENANCE);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain("'third-hive'");
  });

  it('a MATCHING row never warns — the warning tracks drops, not traffic', async () => {
    const p = buildHiveMembersProjection(OPTS);
    await p.writeToPg(row({ pot_home_slug: 'hive-home' }), LOCAL_PROVENANCE);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the verbose per-op A-003 trace stays behind its env var, independent of the warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = buildHiveMembersProjection(OPTS);
      await p.writeToPg(row(), LOCAL_PROVENANCE);
      expect(err).not.toHaveBeenCalled(); // env var unset ⇒ no trace…
      expect(warn).toHaveBeenCalledTimes(1); // …but the warning still fired

      process.env.PAPERCUSP_A003_TRACE = '1';
      await p.writeToPg(row(), LOCAL_PROVENANCE);
      expect(err).toHaveBeenCalledTimes(1); // trace is per-op, deliberately un-throttled
      expect(warn).toHaveBeenCalledTimes(1); // warning still throttled in-window
    } finally {
      delete process.env.PAPERCUSP_A003_TRACE;
      err.mockRestore();
    }
  });
});
