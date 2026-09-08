/**
 * Dedicated suite for release-pause-ttl.ts (P-004, gate-verdict-liveness plan).
 *
 * Pins the four invariants the module exists for:
 *   1. a release-group pause is ALWAYS finite (malformed TTL overrides cannot
 *      defeat the default; legacy pauses inherit the default from pausedAtMs);
 *   2. the ONE exclusion (the D-012/D-013 serializer quiescence hold) is never
 *      TTL'd, never swept, and its banner honestly promises no auto-resume;
 *   3. the sweep is fail-soft (a bad row / dead rail never breaks the tick) and
 *      race-safe (the re-arm UPDATE is guarded on the EXACT pause blob read);
 *   4. the banner is three-valued about auto-resume — scheduled / lapsed /
 *      none-scheduled — and keeps the "A PAUSED gate is not a FAILING gate"
 *      phrase readers match on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { CHECKPOINT_QUIESCENCE_PAUSE_MARKER } from '../../release/checkpoint-serializer-authority';
import {
  DEFAULT_RELEASE_PAUSE_TTL_HOURS,
  DEFAULT_RELEASE_PAUSE_TTL_MS,
  LOOP_STANDDOWN_MARKER,
  RELEASE_ROUTINE_GROUP,
  classifyFinitePauseExpiry,
  classifyReleasePauseExpiry,
  effectivePauseExpiryMs,
  gatePausedBanner,
  isCheckpointQuiescencePause,
  isLoopStanddownPause,
  isWorkspaceWideLoopStanddownPause,
  listLoopStanddownOwners,
  isReleaseGroup,
  loopStanddownBanner,
  readRoutinePause,
  resolveLoopStanddownExpiryMs,
  resolvePauseExpiryMs,
  sweepExpiredLoopStanddowns,
  sweepExpiredReleasePauses,
} from './release-pause-ttl';

vi.mock('../../attention-notify', () => ({
  notifyAttentionOnce: vi.fn(async () => {}),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(() => {}),
}));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
const HOUR = 3_600_000;

const pause = (over: Record<string, unknown> = {}) => ({
  reason: 'deploy-checkout surgery',
  pausedBy: 'su-test',
  pausedAtMs: NOW - HOUR,
  ...over,
});

describe('readRoutinePause', () => {
  it('returns the absent record for null / non-object / array values', () => {
    for (const v of [null, undefined, 42, 'pause', [1]]) {
      const rec = readRoutinePause(v);
      expect(rec.present).toBe(false);
      expect(rec.expiresAtMs).toBeNull();
      expect(rec.legacy).toBe(false);
    }
  });

  it('marks any object present — even an empty one — and flags it legacy without expiresAtMs', () => {
    const rec = readRoutinePause({});
    expect(rec).toMatchObject({ present: true, reason: null, pausedBy: null, pausedAtMs: null, legacy: true });
  });

  it('accepts the field aliases the paused-gate watchdog tolerates', () => {
    expect(readRoutinePause({ pauseReason: 'r', by: 'b', pausedAt: 123 })).toMatchObject({
      reason: 'r',
      pausedBy: 'b',
      pausedAtMs: 123,
    });
    expect(readRoutinePause({ owner: 'o', atMs: 5, pauseExpiresAtMs: 9 })).toMatchObject({
      pausedBy: 'o',
      pausedAtMs: 5,
      expiresAtMs: 9,
      legacy: false,
    });
    expect(readRoutinePause({ at: 7 }).pausedAtMs).toBe(7);
  });

  it('parses numeric strings and rejects non-positive / non-finite timestamps', () => {
    expect(readRoutinePause({ expiresAtMs: String(NOW) }).expiresAtMs).toBe(NOW);
    for (const bad of [0, -1, Number.NaN, 'soon', '']) {
      expect(readRoutinePause({ expiresAtMs: bad }).expiresAtMs).toBeNull();
    }
  });
});

describe('group + quiescence predicates', () => {
  it('isReleaseGroup matches only the release group', () => {
    expect(isReleaseGroup(RELEASE_ROUTINE_GROUP)).toBe(true);
    expect(isReleaseGroup('maintenance')).toBe(false);
    expect(isReleaseGroup(null)).toBe(false);
  });

  it('isCheckpointQuiescencePause is a prefix match on the structured marker', () => {
    expect(isCheckpointQuiescencePause(`${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} WI-123`)).toBe(true);
    expect(isCheckpointQuiescencePause('manual hold')).toBe(false);
    expect(isCheckpointQuiescencePause(null)).toBe(false);
    expect(isCheckpointQuiescencePause(undefined)).toBe(false);
  });
});

describe('resolvePauseExpiryMs (write side)', () => {
  it('stamps the default TTL for a release-group pause', () => {
    expect(resolvePauseExpiryMs({ groupSlug: RELEASE_ROUTINE_GROUP, pausedAtMs: NOW })).toBe(
      NOW + DEFAULT_RELEASE_PAUSE_TTL_HOURS * HOUR,
    );
  });

  it('honors an explicit finite positive ttlHours', () => {
    expect(resolvePauseExpiryMs({ groupSlug: RELEASE_ROUTINE_GROUP, pausedAtMs: NOW, ttlHours: 0.5 })).toBe(
      NOW + 0.5 * HOUR,
    );
  });

  it('a malformed override cannot defeat finiteness — falls back to the default', () => {
    for (const ttl of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(resolvePauseExpiryMs({ groupSlug: RELEASE_ROUTINE_GROUP, pausedAtMs: NOW, ttlHours: ttl })).toBe(
        NOW + DEFAULT_RELEASE_PAUSE_TTL_MS,
      );
    }
  });

  it('returns null (not TTL-governed) for non-release groups and the quiescence hold', () => {
    expect(resolvePauseExpiryMs({ groupSlug: 'maintenance', pausedAtMs: NOW })).toBeNull();
    expect(
      resolvePauseExpiryMs({
        groupSlug: RELEASE_ROUTINE_GROUP,
        pausedAtMs: NOW,
        reason: `${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} hold`,
      }),
    ).toBeNull();
  });
});

describe('effectivePauseExpiryMs (read side, legacy rule)', () => {
  it('an explicit stamp always wins', () => {
    const rec = readRoutinePause(pause({ expiresAtMs: NOW + 5 }));
    expect(effectivePauseExpiryMs(rec, { groupSlug: 'anything' })).toBe(NOW + 5);
  });

  it('a legacy release-group pause expires at pausedAtMs + the default TTL', () => {
    const rec = readRoutinePause(pause());
    expect(effectivePauseExpiryMs(rec, { groupSlug: RELEASE_ROUTINE_GROUP })).toBe(
      (NOW - HOUR) + DEFAULT_RELEASE_PAUSE_TTL_MS,
    );
  });

  it('returns null for: absent pause, non-release legacy, quiescence hold, undatable legacy', () => {
    expect(effectivePauseExpiryMs(readRoutinePause(null), { groupSlug: RELEASE_ROUTINE_GROUP })).toBeNull();
    expect(effectivePauseExpiryMs(readRoutinePause(pause()), { groupSlug: 'other' })).toBeNull();
    expect(
      effectivePauseExpiryMs(
        readRoutinePause(pause({ reason: `${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} x` })),
        { groupSlug: RELEASE_ROUTINE_GROUP },
      ),
    ).toBeNull();
    expect(
      effectivePauseExpiryMs(readRoutinePause(pause({ pausedAtMs: null })), { groupSlug: RELEASE_ROUTINE_GROUP }),
    ).toBeNull();
  });
});

describe('classifyReleasePauseExpiry', () => {
  const input = (over: Partial<{ active: boolean | null; groupSlug: string | null; pauseRec: unknown }> = {}) => ({
    active: 'active' in over ? (over.active as boolean | null) : false,
    groupSlug: over.groupSlug === undefined ? RELEASE_ROUTINE_GROUP : over.groupSlug,
    pause: readRoutinePause(over.pauseRec === undefined ? pause() : over.pauseRec),
  });

  it('an active routine (or no pause record) is not-paused — active:null is NOT treated as paused', () => {
    expect(classifyReleasePauseExpiry(input({ active: true }), NOW)).toMatchObject({ expired: false, reason: 'not-paused' });
    expect(classifyReleasePauseExpiry(input({ active: null }), NOW)).toMatchObject({ expired: false, reason: 'not-paused' });
    expect(classifyReleasePauseExpiry(input({ pauseRec: null }), NOW)).toMatchObject({ expired: false, reason: 'not-paused' });
  });

  it('routes non-release, quiescence and undatable to their named non-expiring verdicts', () => {
    expect(classifyReleasePauseExpiry(input({ groupSlug: 'other' }), NOW)).toMatchObject({ reason: 'not-release-group' });
    expect(
      classifyReleasePauseExpiry(input({ pauseRec: pause({ reason: `${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} h` }) }), NOW),
    ).toMatchObject({ reason: 'serializer-quiescence-hold' });
    expect(classifyReleasePauseExpiry(input({ pauseRec: pause({ pausedAtMs: null }) }), NOW)).toMatchObject({
      reason: 'undatable',
    });
  });

  it('exactly-at-expiry is not-yet (boundary is inclusive of the TTL)', () => {
    const expiresAt = NOW + HOUR;
    const v = classifyReleasePauseExpiry(input({ pauseRec: pause({ expiresAtMs: expiresAt }) }), expiresAt);
    expect(v).toMatchObject({ expired: false, reason: 'not-yet', expiresAtMs: expiresAt });
  });

  it('reports overdueMs and the legacy flag once lapsed', () => {
    const lapsedLegacy = classifyReleasePauseExpiry(
      input({ pauseRec: pause({ pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 30 * 60_000 }) }),
      NOW,
    );
    expect(lapsedLegacy).toMatchObject({ expired: true, legacy: true, overdueMs: 30 * 60_000 });

    const lapsedExplicit = classifyReleasePauseExpiry(input({ pauseRec: pause({ expiresAtMs: NOW - 60_000 }) }), NOW);
    expect(lapsedExplicit).toMatchObject({ expired: true, legacy: false, overdueMs: 60_000 });
  });
});

describe('gatePausedBanner', () => {
  const banner = (pauseRec: unknown, over: Record<string, unknown> = {}) =>
    gatePausedBanner({
      routineName: 'green-checkpoint',
      installSlug: 'papercusp',
      groupSlug: RELEASE_ROUTINE_GROUP,
      pause: readRoutinePause(pauseRec),
      nowMs: NOW,
      ...over,
    });

  it('renders nothing on a healthy (unpaused) gate', () => {
    expect(banner(null)).toBeNull();
  });

  it('a scheduled auto-resume names the instant; legacy pauses say the default TTL was applied', () => {
    const explicit = banner(pause({ expiresAtMs: NOW + HOUR }));
    expect(explicit).toContain('GREEN-CHECKPOINT PAUSED on papercusp');
    expect(explicit).toContain(`auto-resumes ${new Date(NOW + HOUR).toISOString()}`);
    expect(explicit).not.toContain('legacy pause');
    expect(explicit).toContain('(held ~60m)');
    expect(explicit).toContain('by su-test (deploy-checkout surgery)');

    const legacy = banner(pause({ pausedAtMs: NOW - HOUR }));
    expect(legacy).toContain('(legacy pause: default release TTL applied)');
  });

  it('a lapsed TTL says LAPSED and promises the engine re-arm', () => {
    const lapsed = banner(pause({ expiresAtMs: NOW - HOUR }));
    expect(lapsed).toContain(`TTL LAPSED at ${new Date(NOW - HOUR).toISOString()}`);
    expect(lapsed).toContain('auto-resumes it on the next tick');
    const lapsedLegacy = banner(pause({ pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - HOUR }));
    expect(lapsedLegacy).toContain('legacy-default TTL LAPSED');
  });

  it('no scheduled auto-resume is stated loudly, with the deliberate-resume command', () => {
    const undatable = banner(pause({ pausedAtMs: null }));
    expect(undatable).toContain('⚠ NO auto-resume is scheduled');
    expect(undatable).toContain('routines:set { name: "green-checkpoint", active: true }');
  });

  it('the quiescence hold explains its non-clock recovery path instead of the ⚠ clause', () => {
    const q = banner(pause({ reason: `${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} WI-1` }));
    expect(q).toContain('D-012/D-013 serializer quiescence hold');
    expect(q).not.toContain('⚠ NO auto-resume');
  });

  it('falls back honestly on unknown fields and keeps the phrase readers match on', () => {
    const b = banner({ reason: null, pausedBy: null });
    expect(b).toContain('since unknown');
    expect(b).toContain('by (unknown)');
    expect(b).toContain('(no reason recorded)');
    expect(b).toContain('A PAUSED gate is not a FAILING gate:');
  });
});

// ─── the sweep ────────────────────────────────────────────────────────────────

interface FakeRow {
  workspace_id: string;
  install_slug: string;
  name: string;
  active: boolean | null;
  group_slug: string | null;
  pause: unknown;
}

type SqlCall = { text: string; values: unknown[] };

function fakeSql(opts: {
  rows?: FakeRow[];
  scanError?: Error;
  update?: (call: SqlCall, nth: number) => { install_slug: string }[];
}) {
  const calls: SqlCall[] = [];
  let updates = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?');
    const call: SqlCall = { text, values };
    calls.push(call);
    if (/SELECT workspace_id/i.test(text)) {
      if (opts.scanError) return Promise.reject(opts.scanError);
      return Promise.resolve(opts.rows ?? []);
    }
    if (/UPDATE harness_shared\.routines/i.test(text)) {
      updates += 1;
      try {
        return Promise.resolve(opts.update ? opts.update(call, updates) : [{ install_slug: 'papercusp' }]);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  return { sql, calls };
}

const expiredRow = (over: Partial<FakeRow> = {}): FakeRow => ({
  workspace_id: 'ws-1',
  install_slug: 'papercusp',
  name: 'green-checkpoint',
  active: false,
  group_slug: RELEASE_ROUTINE_GROUP,
  pause: pause({ pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 10 * 60_000 }),
  ...over,
});

describe('sweepExpiredReleasePauses', () => {
  // The sweep narrates via console.warn BY DESIGN (fail-soft on a shared tick);
  // spy it out per vitest-fail-on-console and assert on it where it is the contract.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('a failed scan is non-fatal, warns, and resumes nothing', async () => {
    const { sql, calls } = fakeSql({ scanError: new Error('pg down') });
    await expect(sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scan failed (non-fatal)'));
  });

  it('auto-resumes a lapsed legacy pause and reports the verdict fields', async () => {
    const { sql } = fakeSql({ rows: [expiredRow()] });
    const resumed = await sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      name: 'green-checkpoint',
      legacy: true,
      overdueMs: 10 * 60_000,
      pausedBy: 'su-test',
    });
  });

  it('guards the re-arm UPDATE on the EXACT pause blob it classified, and stamps lastPause provenance', async () => {
    const row = expiredRow();
    const { sql, calls } = fakeSql({ rows: [row] });
    await sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false });
    const update = calls.find((c) => /UPDATE harness_shared\.routines/.test(c.text));
    expect(update).toBeDefined();
    // exact-blob optimistic-concurrency guard: the read pause blob rides in the WHERE
    expect(update!.values).toContain(JSON.stringify(row.pause));
    // provenance stamped into metadata.lastPause; the live pause key is removed in the same write
    const lastPauseJson = update!.values.find(
      (v): v is string => typeof v === 'string' && v.includes('autoResumedBy'),
    );
    expect(lastPauseJson).toBeDefined();
    expect(JSON.parse(lastPauseJson!)).toMatchObject({
      autoResumedBy: 'release-pause-ttl',
      autoResumeReason: 'legacy-pause-default-ttl-lapsed',
      resumedAtMs: NOW,
    });
    expect(update!.text).toContain("- 'pause'");
    expect(update!.text).toContain('next_fire_at = now()');
  });

  it('a raced UPDATE (pause blob changed underneath) resumes nothing and leaves the row to the next pass', async () => {
    const { sql } = fakeSql({ rows: [expiredRow()], update: () => [] });
    await expect(sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
  });

  it('skips non-expired verdicts: not-yet, quiescence hold, undatable', async () => {
    const rows = [
      expiredRow({ name: 'fresh', pause: pause({ expiresAtMs: NOW + HOUR }) }),
      expiredRow({ name: 'quiesced', pause: pause({ reason: `${CHECKPOINT_QUIESCENCE_PAUSE_MARKER} WI-9` }) }),
      expiredRow({ name: 'undatable', pause: pause({ pausedAtMs: null }) }),
    ];
    const { sql, calls } = fakeSql({ rows });
    await expect(sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
    expect(calls.filter((c) => /UPDATE/.test(c.text))).toHaveLength(0);
  });

  it('a throwing per-row UPDATE is fail-soft: later rows still resume', async () => {
    const rows = [expiredRow({ name: 'first' }), expiredRow({ name: 'second' })];
    const { sql } = fakeSql({
      rows,
      update: (_call, nth) => {
        if (nth === 1) throw new Error('deadlock');
        return [{ install_slug: 'papercusp' }];
      },
    });
    const resumed = await sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false });
    expect(resumed.map((r) => r.name)).toEqual(['second']);
  });

  it('notifies through notifyAttentionOnce with an expiry-keyed dedupeKey (and survives a dead rail)', async () => {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    const mock = vi.mocked(notifyAttentionOnce);
    const row = expiredRow();
    {
      const { sql } = fakeSql({ rows: [row] });
      const resumed = await sweepExpiredReleasePauses(sql, { nowMs: NOW });
      expect(resumed).toHaveLength(1);
    }
    expect(mock).toHaveBeenCalledTimes(1);
    const arg = mock.mock.calls[0][0] as { dedupeKey?: string; title?: string };
    const expectedExpiry = (NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 10 * 60_000) + DEFAULT_RELEASE_PAUSE_TTL_MS;
    expect(arg.dedupeKey).toBe(`release-pause-ttl:papercusp:green-checkpoint:${expectedExpiry}`);
    expect(arg.title).toContain('AUTO-RESUMED');

    // dead rail: the sweep still reports the resume it performed
    mock.mockRejectedValueOnce(new Error('rail down'));
    {
      const { sql } = fakeSql({ rows: [row] });
      await expect(sweepExpiredReleasePauses(sql, { nowMs: NOW })).resolves.toHaveLength(1);
    }
  });

  it('notify:false suppresses the notice entirely', async () => {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    const { sql } = fakeSql({ rows: [expiredRow()] });
    await sweepExpiredReleasePauses(sql, { nowMs: NOW, notify: false });
    expect(vi.mocked(notifyAttentionOnce)).not.toHaveBeenCalled();
  });
});

// ─── EI-22138154596110669: loop:standdown-all (a GROUP-AGNOSTIC sibling of the ────────
// release-group machinery above — every stand-down pause is ALWAYS finite, with no
// group/quiescence gating, and is distinguished from an ordinary per-loop pause
// (routines:set / loop:end) by a positive marker rather than mere presence). ─────────

describe('isLoopStanddownPause', () => {
  it('is true only for an object carrying the marker === true', () => {
    expect(isLoopStanddownPause({ [LOOP_STANDDOWN_MARKER]: true })).toBe(true);
  });

  it('is false for null / non-object / array / marker-absent / marker-falsy values', () => {
    for (const v of [null, undefined, 42, 'pause', [1], {}, { standdownAll: false }, { standdownAll: 'true' }]) {
      expect(isLoopStanddownPause(v)).toBe(false);
    }
  });

  it('never matches an ordinary per-loop pause (routines:set / loop:end shape)', () => {
    expect(isLoopStanddownPause(pause())).toBe(false);
  });
});

describe('isWorkspaceWideLoopStanddownPause', () => {
  it('recognizes the unscoped marker and excludes fleet-scoped markers', () => {
    expect(isWorkspaceWideLoopStanddownPause({ [LOOP_STANDDOWN_MARKER]: true })).toBe(true);
    expect(isWorkspaceWideLoopStanddownPause({ [LOOP_STANDDOWN_MARKER]: true, fleetSlug: 'fleet-a' })).toBe(false);
    expect(isWorkspaceWideLoopStanddownPause({ [LOOP_STANDDOWN_MARKER]: false })).toBe(false);
  });
});

describe('resolveLoopStanddownExpiryMs (write side — ALWAYS finite, no group gating)', () => {
  it('stamps the default TTL with no groupSlug/reason arguments at all', () => {
    expect(resolveLoopStanddownExpiryMs({ pausedAtMs: NOW })).toBe(NOW + DEFAULT_RELEASE_PAUSE_TTL_MS);
  });

  it('honors an explicit finite positive ttlHours', () => {
    expect(resolveLoopStanddownExpiryMs({ pausedAtMs: NOW, ttlHours: 0.5 })).toBe(NOW + 0.5 * HOUR);
  });

  it('a malformed override cannot defeat finiteness — falls back to the default', () => {
    for (const ttl of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(resolveLoopStanddownExpiryMs({ pausedAtMs: NOW, ttlHours: ttl })).toBe(NOW + DEFAULT_RELEASE_PAUSE_TTL_MS);
    }
  });
});

describe('classifyFinitePauseExpiry (read side — group-agnostic sibling of classifyReleasePauseExpiry)', () => {
  it('an absent pause is not-paused', () => {
    expect(classifyFinitePauseExpiry(readRoutinePause(null), NOW)).toMatchObject({ expired: false, reason: 'not-paused' });
  });

  it('a present-but-undatable pause (no expiresAtMs, no pausedAtMs) is undatable — no group fallback exists here', () => {
    const rec = readRoutinePause({ [LOOP_STANDDOWN_MARKER]: true });
    expect(classifyFinitePauseExpiry(rec, NOW)).toMatchObject({ expired: false, reason: 'undatable', expiresAtMs: null });
  });

  it('exactly-at-expiry is not-yet (boundary inclusive of the TTL, same as the release sibling)', () => {
    const expiresAt = NOW + HOUR;
    const rec = readRoutinePause(pause({ expiresAtMs: expiresAt }));
    expect(classifyFinitePauseExpiry(rec, expiresAt)).toMatchObject({ expired: false, reason: 'not-yet', expiresAtMs: expiresAt });
  });

  it('reports overdueMs + the legacy flag once lapsed (legacy = explicit expiresAtMs never stamped)', () => {
    const legacyRec = readRoutinePause(pause({ pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 30 * 60_000 }));
    expect(classifyFinitePauseExpiry(legacyRec, NOW)).toMatchObject({ expired: true, legacy: true, overdueMs: 30 * 60_000 });

    const explicitRec = readRoutinePause(pause({ expiresAtMs: NOW - 60_000 }));
    expect(classifyFinitePauseExpiry(explicitRec, NOW)).toMatchObject({ expired: true, legacy: false, overdueMs: 60_000 });
  });
});

describe('loopStanddownBanner', () => {
  const banner = (pauseRec: unknown, nowMs: number = NOW) => loopStanddownBanner({ pause: readRoutinePause(pauseRec), nowMs });

  it('renders null when the pause is absent', () => {
    expect(banner(null)).toBeNull();
  });

  it('names the pauser, the reason, how long it has been held, and a scheduled auto-resume instant', () => {
    const b = banner(pause({ expiresAtMs: NOW + HOUR }));
    expect(b).toContain('⛔ STAND-DOWN ACTIVE');
    expect(b).toContain('by su-test (deploy-checkout surgery)');
    expect(b).toContain('(held ~60m)');
    expect(b).toContain(`auto-resumes ${new Date(NOW + HOUR).toISOString()}`);
  });

  it('a lapsed TTL says LAPSED and promises the engine auto-resume', () => {
    const b = banner(pause({ expiresAtMs: NOW - HOUR }));
    expect(b).toContain(`TTL LAPSED at ${new Date(NOW - HOUR).toISOString()}`);
    expect(b).toContain('auto-resumes it on the next tick');
  });

  it('an undatable pause states loudly that no auto-resume is scheduled', () => {
    const b = banner({ [LOOP_STANDDOWN_MARKER]: true });
    expect(b).toContain('⚠ NO auto-resume is scheduled');
    expect(b).toContain('routines:set { active: true }');
  });

  it('falls back honestly on unknown reason/pausedBy', () => {
    const b = banner({ [LOOP_STANDDOWN_MARKER]: true, pausedAtMs: NOW });
    expect(b).toContain('by (unknown)');
    expect(b).toContain('(no reason recorded)');
  });
});

interface FakeLoopRow {
  workspace_id: string;
  install_slug: string;
  name: string;
  target_owner_id: string | null;
  active: boolean | null;
  pause: unknown;
}

function fakeLoopSql(opts: {
  rows?: FakeLoopRow[];
  scanError?: Error;
  update?: (call: SqlCall, nth: number) => { install_slug: string }[];
}) {
  const calls: SqlCall[] = [];
  let updates = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?');
    const call: SqlCall = { text, values };
    calls.push(call);
    if (/SELECT workspace_id/i.test(text)) {
      if (opts.scanError) return Promise.reject(opts.scanError);
      return Promise.resolve(opts.rows ?? []);
    }
    if (/UPDATE harness_shared\.routines/i.test(text)) {
      updates += 1;
      try {
        return Promise.resolve(opts.update ? opts.update(call, updates) : [{ install_slug: 'papercusp' }]);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  return { sql, calls };
}

const expiredLoopRow = (over: Partial<FakeLoopRow> = {}): FakeLoopRow => ({
  workspace_id: 'ws-1',
  install_slug: 'papercusp',
  name: 'loop-su-test-owner',
  target_owner_id: 'su-test-owner',
  active: false,
  pause: pause({
    [LOOP_STANDDOWN_MARKER]: true,
    pausedAtMs: NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 10 * 60_000,
  }),
  ...over,
});

describe('sweepExpiredLoopStanddowns', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('scopes the scan to loop routines carrying the standdownAll marker (never group_slug)', async () => {
    const { sql, calls } = fakeLoopSql({ rows: [] });
    await sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false });
    const scan = calls.find((c) => /SELECT workspace_id/i.test(c.text));
    expect(scan!.text).toContain('reschedule_interval_sec IS NOT NULL');
    expect(scan!.text).toContain("metadata->'pause'->>'standdownAll' = 'true'");
    expect(scan!.text).not.toContain('group_slug');
  });

  it('a failed scan is non-fatal, warns, and resumes nothing', async () => {
    const { sql, calls } = fakeLoopSql({ scanError: new Error('pg down') });
    await expect(sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scan failed (non-fatal)'));
  });

  it('auto-resumes a lapsed stand-down and reports the verdict fields, including targetOwnerId', async () => {
    const { sql } = fakeLoopSql({ rows: [expiredLoopRow()] });
    const resumed = await sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      name: 'loop-su-test-owner',
      targetOwnerId: 'su-test-owner',
      legacy: true,
      overdueMs: 10 * 60_000,
      pausedBy: 'su-test',
    });
  });

  it('guards the re-arm UPDATE on the EXACT pause blob it classified', async () => {
    const row = expiredLoopRow();
    const { sql, calls } = fakeLoopSql({ rows: [row] });
    await sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false });
    const update = calls.find((c) => /UPDATE harness_shared\.routines/i.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain(JSON.stringify(row.pause));
    const lastPauseJson = update!.values.find((v): v is string => typeof v === 'string' && v.includes('autoResumedBy'));
    expect(lastPauseJson).toBeDefined();
    expect(JSON.parse(lastPauseJson!)).toMatchObject({
      autoResumedBy: 'loop-standdown-ttl',
      autoResumeReason: 'legacy-pause-default-ttl-lapsed',
      resumedAtMs: NOW,
    });
  });

  it('a raced UPDATE (pause blob changed underneath) resumes nothing and leaves the row for the next pass', async () => {
    const { sql } = fakeLoopSql({ rows: [expiredLoopRow()], update: () => [] });
    await expect(sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
  });

  it('skips non-expired verdicts (not-yet / undatable) even if somehow scanned', async () => {
    const rows = [
      expiredLoopRow({ name: 'fresh', pause: pause({ [LOOP_STANDDOWN_MARKER]: true, expiresAtMs: NOW + HOUR }) }),
      expiredLoopRow({ name: 'undatable', pause: { [LOOP_STANDDOWN_MARKER]: true } }),
    ];
    const { sql, calls } = fakeLoopSql({ rows });
    await expect(sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false })).resolves.toEqual([]);
    expect(calls.filter((c) => /UPDATE/i.test(c.text))).toHaveLength(0);
  });

  it('a throwing per-row UPDATE is fail-soft: later rows still resume', async () => {
    const rows = [expiredLoopRow({ name: 'first' }), expiredLoopRow({ name: 'second' })];
    const { sql } = fakeLoopSql({
      rows,
      update: (_call, nth) => {
        if (nth === 1) throw new Error('deadlock');
        return [{ install_slug: 'papercusp' }];
      },
    });
    const resumed = await sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false });
    expect(resumed.map((r) => r.name)).toEqual(['second']);
  });

  it('notifies through notifyAttentionOnce with a loop-scoped dedupeKey naming the owner', async () => {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    const mock = vi.mocked(notifyAttentionOnce);
    const row = expiredLoopRow();
    const { sql } = fakeLoopSql({ rows: [row] });
    const resumed = await sweepExpiredLoopStanddowns(sql, { nowMs: NOW });
    expect(resumed).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    const arg = mock.mock.calls[0][0] as { dedupeKey?: string; title?: string; body?: string };
    const expectedExpiry = NOW - DEFAULT_RELEASE_PAUSE_TTL_MS - 10 * 60_000 + DEFAULT_RELEASE_PAUSE_TTL_MS;
    expect(arg.dedupeKey).toBe(`loop-standdown-ttl:papercusp:loop-su-test-owner:${expectedExpiry}`);
    expect(arg.title).toContain('AUTO-RESUMED');
    expect(arg.body).toContain('su-test-owner');
  });

  it('notify:false suppresses the notice entirely', async () => {
    const { notifyAttentionOnce } = await import('../../attention-notify');
    const { sql } = fakeLoopSql({ rows: [expiredLoopRow()] });
    await sweepExpiredLoopStanddowns(sql, { nowMs: NOW, notify: false });
    expect(vi.mocked(notifyAttentionOnce)).not.toHaveBeenCalled();
  });
});
