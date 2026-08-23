import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const batchMock = vi.fn();
vi.mock('../agent-tools/coordination/escalations', () => ({
  listEscalations: (...a: unknown[]) => listMock(...a),
  resolveEscalationsBatch: (...a: unknown[]) => batchMock(...a),
}));

const resolveStatesMock = vi.fn();
const getPresenceMock = vi.fn();
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: (...a: unknown[]) => resolveStatesMock(...a),
}));
vi.mock('../agent-tools/coordination/presence', () => ({
  getPresence: (...a: unknown[]) => getPresenceMock(...a),
  listPresence: vi.fn(),
  probeProcessLiveness: vi.fn(),
}));

import {
  selectStaleEscalations,
  reconcileStaleEscalationsOnce,
  selectUnanswerableEscalations,
  unanswerableCandidateAuthors,
  reconcileUnanswerableEscalationsOnce,
  selectEscalationSlaReroutes,
  rerouteUnackedEscalationsOnce,
  type StaleEscalationInput,
  type EscalationRerouteDriver,
  type EscalationRerouteInput,
} from './reconcile-escalations';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // a fixed "now" far from epoch
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ttl = 3 * DAY;

function row(over: Partial<StaleEscalationInput>): StaleEscalationInput {
  return { msg_id: 'm', from: 'system:hive-placement-watchdog', options: [], ts: iso(10 * DAY), ...over };
}

describe('selectStaleEscalations (P-003/P-005)', () => {
  it('selects an operational system escalation older than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'old' })], { nowMs: NOW, ttlMs: ttl });
    expect(r.map((x) => x.msg_id)).toEqual(['old']);
    expect(r[0].ageDays).toBeCloseTo(10, 1);
  });

  it('skips an operational escalation younger than the TTL', () => {
    const r = selectStaleEscalations([row({ msg_id: 'fresh', ts: iso(1 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a genuine agent escalation (non-system sender), even if ancient', () => {
    const r = selectStaleEscalations([row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('NEVER selects a system escalation that carries options (a real choice)', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(99 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r).toEqual([]);
  });

  it('treats both bare `system` and `system:<emitter>` as operational', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'bare', from: 'system' }), row({ msg_id: 'wd', from: 'system:hive-placement-watchdog' })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['bare', 'wd']);
  });

  it('skips rows with an unparseable timestamp (no crash)', () => {
    const r = selectStaleEscalations([row({ msg_id: 'bad', ts: 'not-a-date' })], { nowMs: NOW, ttlMs: ttl });
    expect(r).toEqual([]);
  });

  it('returns oldest-first so a batch-limited sweep drains the longest-stale first', () => {
    const r = selectStaleEscalations(
      [row({ msg_id: 'a', ts: iso(5 * DAY) }), row({ msg_id: 'b', ts: iso(40 * DAY) }), row({ msg_id: 'c', ts: iso(12 * DAY) })],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['b', 'c', 'a']);
  });

  // ── WI-36154: the row IS the suppressor ────────────────────────────────────
  // liveness-alarm.ts:1552 skips firing a signal that already has an open
  // escalation, so GC'ing that row does not tidy a duplicate — it re-arms the
  // alarm on a still-true condition. Measured 14d: 5 of 5 such auto-resolves
  // re-fired within 120s.
  it('NEVER selects a row carrying a livenessSignature — resolving it re-arms the alarm (WI-36154)', () => {
    const r = selectStaleEscalations(
      [
        row({
          msg_id: 'oscillator',
          from: 'system:infra-liveness-alarm',
          ts: iso(3 * DAY),
          livenessSignature: 'stale-paused-routines',
        }),
        // CALIBRATION CONTROL: same sender, same age, NO signature. The sweep
        // must still clear this one — otherwise the assertion above would pass
        // just as well with the whole sweep disabled, and prove nothing.
        row({ msg_id: 'control', from: 'system:infra-liveness-alarm', ts: iso(3 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['control']);
  });

  it('exempts ONLY a non-empty string signature — a junk jsonb value must not widen the exemption', () => {
    // The field arrives from jsonb, so the guard is typed `unknown`. If any
    // truthy-ish value exempted a row, the narrow exemption would become a
    // silent opt-out for anything that happened to carry the key.
    const r = selectStaleEscalations(
      [
        row({ msg_id: 'empty', livenessSignature: '' }),
        row({ msg_id: 'nonstring', livenessSignature: 1 }),
        row({ msg_id: 'nullish', livenessSignature: null }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['empty', 'nonstring', 'nullish']);
  });

  // ── WI-36214: the general marker ───────────────────────────────────────────
  // The livenessSignature leg above covers ONE emitter. Re-running the
  // resolve→re-fire probe against the rows that exemption LEFT BEHIND found 6
  // more oscillators from system:escalation-aging-alarm, whose gate
  // (escalation-aging-alarm.ts:167) is identical but carries no signature.
  it('NEVER selects a row an emitter marked selfReconciling (WI-36214)', () => {
    const r = selectStaleEscalations(
      [
        row({
          msg_id: 'aging-alarm',
          from: 'system:escalation-aging-alarm',
          ts: iso(3 * DAY),
          selfReconciling: true,
        }),
        // CALIBRATION CONTROL: an operational row from the mass-emitter this
        // sweep was BUILT for (one row per cursed placement, no re-fire gate,
        // ~7000 opened / ~135 resolved). If this ever stops being selected the
        // exemption has leaked into the population the GC exists to drain.
        row({ msg_id: 'cursed-placement', from: 'system:pot-placement-watchdog', ts: iso(3 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id)).toEqual(['cursed-placement']);
  });

  it('exempts ONLY selfReconciling === true, never a merely truthy value', () => {
    const r = selectStaleEscalations(
      [
        row({ msg_id: 'truthy-string', selfReconciling: 'yes' }),
        row({ msg_id: 'truthy-number', selfReconciling: 1 }),
        row({ msg_id: 'false', selfReconciling: false }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(r.map((x) => x.msg_id).sort()).toEqual(['false', 'truthy-number', 'truthy-string']);
  });
});

describe('reconcileStaleEscalationsOnce (P-003)', () => {
  beforeEach(() => {
    listMock.mockReset();
    batchMock.mockReset();
    // Default: the batch resolves everything it is handed.
    batchMock.mockImplementation((items: { msg_id: string }[]) =>
      Promise.resolve({ resolved: items.length, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 }),
    );
  });

  it('resolves only the stale operational escalations and reports counts', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'old1', ts: iso(10 * DAY) }), // stale operational → resolve
      row({ msg_id: 'old2', ts: iso(20 * DAY) }), // stale operational → resolve
      row({ msg_id: 'fresh', ts: iso(1 * DAY) }), // too fresh → keep
      row({ msg_id: 'agent', from: 'bee-7', ts: iso(99 * DAY) }), // genuine → never
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ scanned: 4, stale: 2, resolved: 2, truncated: false });
    // EI-1490: the sweep resolves the whole batch in ONE call (was one call per
    // item, each re-loading the entire escalation log — O(n²) over ~13k rows).
    expect(batchMock).toHaveBeenCalledTimes(1);
    const items = batchMock.mock.calls[0][0] as { msg_id: string; resolver: string }[];
    expect(items.map((i) => i.msg_id).sort()).toEqual(['old1', 'old2']);
    // stamps the reconcile owner so the resolution is attributable in the ledger
    expect(items[0].resolver).toBe('system:attention-reconcile');
  });

  it('respects the batch limit and reports truncated=true', async () => {
    listMock.mockResolvedValue([
      row({ msg_id: 'a', ts: iso(10 * DAY) }),
      row({ msg_id: 'b', ts: iso(20 * DAY) }),
      row({ msg_id: 'c', ts: iso(30 * DAY) }),
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl, limit: 2 });
    expect(r).toMatchObject({ stale: 3, resolved: 2, truncated: true });
    // ONE batch call carrying exactly the limit-bounded slice.
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect((batchMock.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('does not hand a livenessSignature row to the batch resolver (WI-36154, end-to-end)', async () => {
    // Pins the PLUMBING, not just the selector: `listEscalations` returns the
    // stored envelope whole (the projection selects `body`; the event-fold
    // spreads `{ ...open, resolved }`), and liveness-alarm's `meta` is FLATTENED
    // onto that envelope (escalations.ts:190), so the signature really does
    // arrive top-level. The call site casts through `unknown`, which would
    // happily drop a field the interface never declared — this test fails if
    // that plumbing is ever narrowed.
    listMock.mockResolvedValue([
      row({
        msg_id: 'live-suppressor',
        from: 'system:infra-liveness-alarm',
        ts: iso(30 * DAY),
        livenessSignature: 'stale-paused-routines',
      }),
      row({ msg_id: 'ordinary', ts: iso(10 * DAY) }),
    ]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ scanned: 2, stale: 1, resolved: 1 });
    const items = batchMock.mock.calls[0][0] as { msg_id: string }[];
    expect(items.map((i) => i.msg_id)).toEqual(['ordinary']);
  });

  it('is idempotent: an already-resolved escalation is not counted as resolved', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'gone', ts: iso(10 * DAY) })]);
    batchMock.mockResolvedValue({ resolved: 0, notFound: 0, alreadyResolved: 1, requiresSpawnApprove: 0 });
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 0 });
  });

  it('makes NO batch call when there is nothing stale (empty sweep)', async () => {
    listMock.mockResolvedValue([row({ msg_id: 'fresh', ts: iso(1 * DAY) })]);
    const r = await reconcileStaleEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });
});

// ─── EI-19411323991062966: dead-author (unanswerable) reaper ──────────────────

/** A NON-operational row — an agent-authored ask, which the operational sweep
 *  never touches. Ancient by default so age is never what a case turns on. */
function humanRow(over: Partial<StaleEscalationInput>): StaleEscalationInput {
  return { msg_id: 'h', from: 'su-dead-1', options: [], ts: iso(30 * DAY), ...over };
}
const GONE = () => true;
const ALIVE = () => false;

describe('selectUnanswerableEscalations (EI-19411323991062966)', () => {
  it('selects a past-TTL non-operational row whose author is GONE', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'dead' })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: GONE,
    });
    expect(r.map((x) => x.msg_id)).toEqual(['dead']);
  });

  // The load-bearing guard: this reaper closes rows that LOOK like human
  // decisions, so a live author must be untouchable at ANY age.
  it('NEVER selects a row whose author is LIVE, however ancient', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'live', ts: iso(999 * DAY) })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: ALIVE,
    });
    expect(r).toEqual([]);
  });

  it('NEVER selects an OPERATIONAL row — the TTL sweep owns those', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'op', from: 'system:hive-placement-watchdog' })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  it('NEVER selects a row carrying options (a real choice), even from a dead author', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'choice', options: [{ id: 'a' }], ts: iso(999 * DAY) })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  it('does not select inside the TTL even when the author is gone', () => {
    const r = selectUnanswerableEscalations([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })], {
      nowMs: NOW,
      ttlMs: ttl,
      isAuthorGone: GONE,
    });
    expect(r).toEqual([]);
  });

  it('skips a blank sender (nobody to prove absent) and an unparseable ts', () => {
    const r = selectUnanswerableEscalations(
      [humanRow({ msg_id: 'blank', from: '  ' }), humanRow({ msg_id: 'bad', ts: 'not-a-date' })],
      { nowMs: NOW, ttlMs: ttl, isAuthorGone: GONE },
    );
    expect(r).toEqual([]);
  });

  it('probes only distinct non-operational past-TTL senders', () => {
    const authors = unanswerableCandidateAuthors(
      [
        humanRow({ msg_id: 'a', from: 'su-x' }),
        humanRow({ msg_id: 'b', from: 'su-x' }),
        humanRow({ msg_id: 'c', from: 'system:wd' }),
        humanRow({ msg_id: 'd', from: 'su-y', ts: iso(1 * DAY) }),
      ],
      { nowMs: NOW, ttlMs: ttl },
    );
    expect(authors).toEqual(['su-x']);
  });
});

describe('reconcileUnanswerableEscalationsOnce (EI-19411323991062966)', () => {
  beforeEach(() => {
    listMock.mockReset();
    batchMock.mockReset();
    resolveStatesMock.mockReset();
    getPresenceMock.mockReset();
  });

  // The real-world path: 226 of 229 authors have no presence row AND no verdict.
  it('resolves when there is NO verdict and NO presence row (the dominant case)', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockResolvedValue(null);
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
    expect(batchMock.mock.calls[0][0][0]).toMatchObject({ msg_id: 'dead', choice: 'unanswerable' });
  });

  // no-entry is AMBIGUOUS: it means degraded-fetch OR never-heard-of. A present
  // presence row proves the author is known, so absence-of-verdict is not death.
  it('does NOT resolve when a presence row EXISTS despite no verdict', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'known' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockResolvedValue({ ownerId: 'su-dead-1' });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('an explicit LIVE verdict outranks a missing presence row', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'live' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'live' }]]));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("treats 'suspect' as ambiguous — NOT gone", async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'maybe' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'suspect' }]]));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0 });
  });

  it("resolves on an explicit 'ended' verdict", async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'ended' })]);
    resolveStatesMock.mockResolvedValue(new Map([['su-dead-1', { sessionState: 'ended' }]]));
    getPresenceMock.mockResolvedValue({ ownerId: 'su-dead-1' });
    batchMock.mockResolvedValue({ resolved: 1, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 1, resolved: 1 });
  });

  // FAIL-SAFE. Without this, one transient outage mass-closes every real ask.
  it('resolves NOTHING when the liveness probe throws', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockRejectedValue(new Error('oracle down'));
    getPresenceMock.mockResolvedValue(null);

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'aborted' });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('resolves NOTHING when the presence read throws', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockResolvedValue(new Map());
    getPresenceMock.mockRejectedValue(new Error('presence down'));

    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'aborted' });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('never probes liveness at all when nothing is past the TTL', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })]);
    const r = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });
    expect(r).toMatchObject({ stale: 0, resolved: 0, outcome: 'no-candidates' });
    expect(resolveStatesMock).not.toHaveBeenCalled();
    expect(getPresenceMock).not.toHaveBeenCalled();
  });

  // WI-7397 regression guard. The defect was NOT that the fail-safe resolves
  // nothing — that is correct — but that it was INDISTINGUISHABLE from a
  // healthy idle tick, so a permanently-degraded reaper looked exactly like one
  // with no work to do. If someone ever collapses these back onto a single
  // shared `nothing` value, this fails.
  it('WI-7397: a fail-safe abort is distinguishable from a healthy no-op', async () => {
    listMock.mockResolvedValue([humanRow({ msg_id: 'young', ts: iso(1 * DAY) })]);
    const healthy = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });

    listMock.mockResolvedValue([humanRow({ msg_id: 'dead' })]);
    resolveStatesMock.mockRejectedValue(new Error('oracle down'));
    getPresenceMock.mockResolvedValue(null);
    const degraded = await reconcileUnanswerableEscalationsOnce({ nowMs: NOW, ttlMs: ttl });

    // The counts are identical — that is precisely why they used to be confused.
    expect(healthy.resolved).toBe(degraded.resolved);
    expect(healthy.stale).toBe(degraded.stale);
    // The outcome is what separates them.
    expect(healthy.outcome).toBe('no-candidates');
    expect(degraded.outcome).toBe('aborted');
    expect(healthy.outcome).not.toBe(degraded.outcome);
  });
});

// ─── EI-7024: past-SLA escalation reroute ─────────────────────────────────────

function rerouteRow(over: Partial<EscalationRerouteInput>): EscalationRerouteInput {
  return {
    msg_id: 'e-1',
    from: 'su-author',
    options: [],
    ts: iso(60 * 60 * 1000),
    summary: 'human decision is waiting',
    plan_slug: 'plan-a',
    harness_slug: 'pot-a',
    ...over,
  };
}

function driver(ownerId: string, over: Partial<EscalationRerouteDriver> = {}): EscalationRerouteDriver {
  return {
    ownerId,
    sessionState: 'live',
    agentRole: 'su',
    currentPlanSlug: null,
    potSlug: null,
    fleetSlug: null,
    ...over,
  };
}

describe('selectEscalationSlaReroutes (EI-7024)', () => {
  it('ranks a different live su by author fleet leader, same fleet, plan, then harness', () => {
    const roster = [
      driver('su-author', { fleetSlug: 'alpha', currentPlanSlug: 'plan-a', potSlug: 'pot-a' }),
      driver('su-harness', { potSlug: 'pot-a' }),
      driver('su-plan', { currentPlanSlug: 'plan-a' }),
      driver('su-member', { fleetSlug: 'alpha' }),
      driver('su-leader', { fleetSlug: 'alpha' }),
    ];
    const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      leaderByFleet: new Map([['alpha', 'su-leader']]),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ targetOwnerId: 'su-leader', reason: 'author-fleet-leader' });
  });

  it('falls through deterministically and never chooses the author or a non-su/non-live/contextless agent', () => {
    const roster = [
      driver('su-author', { currentPlanSlug: 'plan-a' }),
      driver('su-contextless'),
      driver('cup-plan', { agentRole: 'cup', currentPlanSlug: 'plan-a' }),
      driver('su-parked-plan', { sessionState: 'parked', currentPlanSlug: 'plan-a' }),
      driver('su-z-plan', { currentPlanSlug: 'plan-a' }),
      driver('su-a-plan', { currentPlanSlug: 'plan-a' }),
    ];
    const selected = selectEscalationSlaReroutes([rerouteRow({})], roster, {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
    });
    expect(selected[0]).toMatchObject({ targetOwnerId: 'su-a-plan', reason: 'same-plan' });
  });

  it('rejects young, operational, non-agent, acknowledged, and contextless rows', () => {
    const rows = [
      rerouteRow({ msg_id: 'young', ts: iso(5 * 60 * 1000) }),
      rerouteRow({ msg_id: 'system', from: 'system:watchdog' }),
      rerouteRow({ msg_id: 'human', from: 'human' }),
      rerouteRow({ msg_id: 'acked' }),
      rerouteRow({ msg_id: 'contextless', plan_slug: undefined, harness_slug: undefined }),
    ];
    const selected = selectEscalationSlaReroutes(rows, [driver('su-plan', { currentPlanSlug: 'plan-a' })], {
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      responseMarkers: new Set(['acked']),
    });
    expect(selected).toEqual([]);
  });
});

describe('rerouteUnackedEscalationsOnce (EI-7024)', () => {
  it('sends one deterministic action marker, wakes the target, and never resolves the escalation', async () => {
    const send = vi.fn(async (_identity, opts) => ({ msg_id: opts.msgId }));
    const wake = vi.fn(async () => ({ woken: 1 }));
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId: 'ws-a',
      listEscalationsFn: vi.fn(async () => [rerouteRow({})]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set<string>()),
      listPresenceFn: vi.fn(async () => [
        {
          ownerId: 'su-author',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
        {
          ownerId: 'su-driver',
          agentRole: 'su',
          currentPlanSlug: 'plan-a',
          potSlug: 'pot-a',
          heartbeatAt: iso(0),
          stale: false,
          host: '',
          pid: null,
          source: 'omp-hook-session',
        },
      ]) as never,
      resolveSessionStatesFn: vi.fn(
        async () =>
          new Map([
            ['su-author', { sessionState: 'parked' }],
            ['su-driver', { sessionState: 'live' }],
          ]),
      ) as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      sendMessageFn: send as never,
      wakeRecipientsFn: wake as never,
    });

    expect(result).toMatchObject({ scanned: 1, selected: 1, rerouted: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({
      to: ['su-driver'],
      msgId: 'escalation-sla-reroute:e-1',
      related_msg_id: 'e-1',
      extra: { expects: 'action', lifecycle: 'escalation-sla-reroute' },
    });
    expect(batchMock).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(
      ['su-driver'],
      expect.objectContaining({ source: 'system:escalation-sla-reroute', workspaceId: 'ws-a' }),
    );
  });

  it('does no roster/liveness/send work after an existing related-message marker', async () => {
    const listPresenceFn = vi.fn();
    const send = vi.fn();
    const result = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      listEscalationsFn: vi.fn(async () => [rerouteRow({})]) as typeof listMock,
      readResponseMarkersFn: vi.fn(async () => new Set(['e-1'])),
      listPresenceFn: listPresenceFn as never,
      sendMessageFn: send as never,
    });
    expect(result).toMatchObject({ selected: 0, rerouted: 0, failed: 0 });
    expect(listPresenceFn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
