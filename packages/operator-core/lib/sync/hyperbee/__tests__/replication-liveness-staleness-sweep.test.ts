/**
 * replication-liveness-staleness-sweep.test.ts — the broader, flag-gated staleness
 * sweep for still-registered-but-abandoned harnesses (WI-5563).
 *
 * Covers: kind-parsing off the exact buildReplicationStallBody shape, the pure
 * decideStaleness decision matrix (eligible-kind / EI-age / inactivity / fail-closed
 * on unknown activity), and the IO sweep's per-workspace flag gating, existence
 * hand-off to orphan-sweep, caching, and per-item error isolation.
 */
import { describe, expect, it, vi } from 'vitest';

const { getFlagMock } = vi.hoisted(() => ({ getFlagMock: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagMock }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: { REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE: 'papercusp-replication-liveness-staleness-auto-close' },
}));

import {
  parseStallEiKind,
  decideStaleness,
  runReplicationLivenessStalenessSweepOnce,
  emptySkipCensus,
  pickLastActiveMs,
  STALENESS_SWEEP_OWNER,
  DEFAULT_MIN_EI_AGE_MS,
  DEFAULT_MIN_INACTIVITY_MS,
  type StalenessSweepDeps,
} from '../replication-liveness-staleness-sweep';

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse('2026-07-20T00:00:00Z');

function bodyFor(workspaceId: string, harnessSlug: string, kind: string): string {
  return (
    `Replication-liveness detector (P-004 / WI-1840, WI-183 class): log=abc123def456… has had 0 ` +
    `live replicator peers for 200s (was previously replicating)\n\n` +
    `workspace=${workspaceId} harness=${harnessSlug}\n` +
    `log_core_key=abc123def456\n` +
    `kind=${kind} stalledForMs=200000\n\n` +
    `Meaning: …`
  );
}

describe('parseStallEiKind', () => {
  it('extracts the kind field from a real EI body', () => {
    expect(parseStallEiKind(bodyFor('ws', 'h', 'no_replicator'))).toBe('no_replicator');
  });

  it('returns null for a body with no kind= stamp', () => {
    expect(parseStallEiKind('no kind field in here')).toBeNull();
  });
});

describe('decideStaleness', () => {
  const base = { id: 'EI-1', kind: 'no_replicator' as string | null, createdAtMs: NOW - 20 * DAY_MS, lastActiveMs: NOW - 40 * DAY_MS };

  it('resolves an old EI on a long-inactive harness for an eligible kind', () => {
    const d = decideStaleness(base, NOW);
    expect(d.resolve).toBe(true);
    expect(d.reason).toContain('inactive for');
  });

  it('refuses an ineligible kind (drain_stalled — an active-defect signal, not disuse)', () => {
    const d = decideStaleness({ ...base, kind: 'drain_stalled' }, NOW);
    expect(d).toEqual({ resolve: false, reason: 'ineligible-kind' });
  });

  it('refuses a null kind (unparsed body)', () => {
    const d = decideStaleness({ ...base, kind: null }, NOW);
    expect(d.resolve).toBe(false);
    expect(d.reason).toBe('ineligible-kind');
  });

  it('refuses an EI younger than minEiAgeMs', () => {
    const d = decideStaleness({ ...base, createdAtMs: NOW - 1 * DAY_MS }, NOW);
    expect(d).toEqual({ resolve: false, reason: 'ei-too-new' });
  });

  it('refuses when lastActiveMs is null (unknown activity — fail CLOSED)', () => {
    const d = decideStaleness({ ...base, lastActiveMs: null }, NOW);
    expect(d).toEqual({ resolve: false, reason: 'unknown-activity-fail-closed' });
  });

  it('refuses a harness that was active more recently than minInactivityMs', () => {
    const d = decideStaleness({ ...base, lastActiveMs: NOW - 2 * DAY_MS }, NOW);
    expect(d).toEqual({ resolve: false, reason: 'harness-recently-active' });
  });

  it('respects custom thresholds', () => {
    const d = decideStaleness(
      { ...base, createdAtMs: NOW - 3 * DAY_MS, lastActiveMs: NOW - 5 * DAY_MS },
      NOW,
      { minEiAgeMs: 2 * DAY_MS, minInactivityMs: 4 * DAY_MS },
    );
    expect(d.resolve).toBe(true);
  });

  it('uses the documented defaults (14d EI age, 30d inactivity)', () => {
    expect(DEFAULT_MIN_EI_AGE_MS).toBe(14 * DAY_MS);
    expect(DEFAULT_MIN_INACTIVITY_MS).toBe(30 * DAY_MS);
  });
});

describe('runReplicationLivenessStalenessSweepOnce', () => {
  function fakeDeps(opts: {
    open: Array<{ id: string; body: string; createdAtMs: number }>;
    existing: Set<string>;
    lastActive: Map<string, number | null>;
    resolveErrorFor?: string;
  }): { deps: StalenessSweepDeps; resolved: Array<{ id: string; note: string }> } {
    const resolved: Array<{ id: string; note: string }> = [];
    return {
      resolved,
      deps: {
        listOpenReplicationStallEis: async () => opts.open,
        harnessExists: async (workspaceId, harnessSlug) => opts.existing.has(`${workspaceId}::${harnessSlug}`),
        harnessLastActiveMs: async (workspaceId, harnessSlug) =>
          opts.lastActive.get(`${workspaceId}::${harnessSlug}`) ?? null,
        resolve: async (id, note) => {
          if (opts.resolveErrorFor === id) throw new Error('resolve failed');
          resolved.push({ id, note });
        },
      },
    };
  }

  it('resolves an eligible, old, long-inactive-harness EI when deps are injected (bypasses the flag gate)', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-1', body: bodyFor('ws1', 'demo-harness', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS }],
      existing: new Set(['ws1::demo-harness']),
      lastActive: new Map([['ws1::demo-harness', NOW - 40 * DAY_MS]]),
    });
    const result = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);
    expect(result.resolvedIds).toEqual(['EI-1']);
    expect(resolved[0].note).toContain('auto-resolved (staleness sweep)');
  });

  it('leaves a still-existing, recently-active harness alone', async () => {
    // ⚠ "Recently active" MUST be anchored to the REAL clock: the IO sweep stamps its
    // own nowMs = Date.now(), so a frozen-NOW-relative stamp AGES — NOW - 1d crossed
    // the 30d inactivity floor on 2026-08-18T00:00Z and this test became a time bomb
    // (WI-39450 red #18). Ages that must stay SMALL use Date.now(); ages that must
    // stay LARGE (already past a floor) may use the frozen NOW — they only grow.
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-2', body: bodyFor('ws1', 'live-harness', 'frozen'), createdAtMs: NOW - 20 * DAY_MS }],
      existing: new Set(['ws1::live-harness']),
      lastActive: new Map([['ws1::live-harness', Date.now() - 1 * DAY_MS]]),
    });
    const result = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);
    expect(result.resolvedIds).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('skips a nonexistent-harness target (that is orphan-sweep\'s job, not this sweep\'s)', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-3', body: bodyFor('ws1', 'renamed-away', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS }],
      existing: new Set(),
      lastActive: new Map(),
    });
    const result = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);
    expect(result.resolvedIds).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('skips a malformed body without erroring the pass', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-4', body: 'no target stamp here', createdAtMs: NOW - 20 * DAY_MS }],
      existing: new Set(),
      lastActive: new Map(),
    });
    const result = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);
    expect(result.checked).toBe(1);
    expect(result.resolvedIds).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('isolates a per-item resolve failure — one failing resolve never strands the rest', async () => {
    const { deps, resolved } = fakeDeps({
      open: [
        { id: 'EI-5a', body: bodyFor('ws1', 'demo-a', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-5b', body: bodyFor('ws1', 'demo-b', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS },
      ],
      existing: new Set(['ws1::demo-a', 'ws1::demo-b']),
      lastActive: new Map([
        ['ws1::demo-a', NOW - 40 * DAY_MS],
        ['ws1::demo-b', NOW - 40 * DAY_MS],
      ]),
      resolveErrorFor: 'EI-5a',
    });
    const result = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);
    expect(result.errors).toBe(1);
    expect(result.resolvedIds).toEqual(['EI-5b']);
  });

  it('stamps STALENESS_SWEEP_OWNER as its own distinct attribution', () => {
    expect(STALENESS_SWEEP_OWNER).toBe('system:replication-liveness-staleness-sweep');
  });

  it('returns an inert, zero-op result under VITEST with no deps (never touches real PG / getFlag)', async () => {
    const result = await runReplicationLivenessStalenessSweepOnce();
    expect(result).toEqual({ checked: 0, resolvedIds: [], errors: 0, skipped: emptySkipCensus() });
    expect(getFlagMock).not.toHaveBeenCalled();
  });

  it('censuses every skip reason, and the census + resolutions account for all checked items', async () => {
    // The sweep takes the frozen NOW via `opts.nowMs`, so every age below is judged
    // against it. Before that seam existed this test had to express "too new" relative to
    // REAL now, and the fixtures that had to stay "recent" silently aged into staleness.
    const { deps } = fakeDeps({
      open: [
        { id: 'EI-C1', body: 'no target stamp here', createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-C2', body: bodyFor('ws1', 'renamed-away', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-C3', body: bodyFor('ws1', 'drainy', 'drain_stalled'), createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-C4', body: bodyFor('ws1', 'demo-a', 'no_replicator'), createdAtMs: NOW - 2 * DAY_MS },
        { id: 'EI-C5', body: bodyFor('ws1', 'no-history', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-C6', body: bodyFor('ws1', 'live-harness', 'frozen'), createdAtMs: NOW - 20 * DAY_MS },
        { id: 'EI-C7', body: bodyFor('ws1', 'abandoned', 'no_replicator'), createdAtMs: NOW - 20 * DAY_MS },
      ],
      existing: new Set(['ws1::drainy', 'ws1::demo-a', 'ws1::no-history', 'ws1::live-harness', 'ws1::abandoned']),
      lastActive: new Map<string, number | null>([
        ['ws1::drainy', NOW - 40 * DAY_MS],
        ['ws1::demo-a', NOW - 40 * DAY_MS],
        ['ws1::no-history', null],
        // REAL_NOW-anchored for the same reason as EI-C4 above: "recently active"
        // ages past the 30d floor if pinned to the frozen NOW (WI-39450 red #18).
        ['ws1::live-harness', REAL_NOW - 1 * DAY_MS],
        ['ws1::abandoned', NOW - 40 * DAY_MS],
      ]),
    });
    const r = await runReplicationLivenessStalenessSweepOnce({ nowMs: NOW }, deps);

    expect(r.resolvedIds).toEqual(['EI-C7']);
    expect(r.skipped).toEqual({
      ...emptySkipCensus(),
      'malformed-body': 1,
      'harness-gone-orphan-sweeps-it': 1,
      'ineligible-kind': 1,
      'ei-too-new': 1,
      'unknown-activity-fail-closed': 1,
      'harness-recently-active': 1,
    });

    // The accounting invariant: nothing the sweep looked at goes uncounted. An
    // uncounted skip is exactly how a sweep that CANNOT fire passes for one that
    // merely had nothing to do.
    const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0);
    expect(skippedTotal + r.resolvedIds.length + r.errors).toBe(r.checked);
  });
});

describe('pickLastActiveMs — the WI-5563 activity-source seam', () => {
  const LEASE = NOW - 2 * DAY_MS;
  const DURABLE = NOW - 40 * DAY_MS;

  it('returns null only when BOTH sources are unknown (fail-closed preserved)', () => {
    expect(pickLastActiveMs(null, null)).toBeNull();
    expect(pickLastActiveMs(undefined, undefined)).toBeNull();
  });

  it('takes the newest when both are known', () => {
    expect(pickLastActiveMs(LEASE, DURABLE)).toBe(LEASE);
    expect(pickLastActiveMs(DURABLE, LEASE)).toBe(LEASE);
  });

  it('ignores a zero/negative/non-finite reading rather than treating it as 1970', () => {
    expect(pickLastActiveMs(0, DURABLE)).toBe(DURABLE);
    expect(pickLastActiveMs(Number.NaN, DURABLE)).toBe(DURABLE);
    expect(pickLastActiveMs(-1, null)).toBeNull();
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. In production every abandoned harness had
   * NO orchestrator-lease row — `harness_status` held one row workspace-wide, with a
   * NULL last_active_ts — so the lease-only source returned null for exactly the
   * harnesses the sweep is meant to act on, and fail-closed refused every one. The
   * sweep resolved ZERO EIs in the 13 days its flag was on.
   *
   * The `leaseOnly` control below is the OLD implementation, kept deliberately so
   * this pair fails if the durable source is ever removed or reverted: the control
   * must still refuse, and the fix must still act, on identical inputs.
   */
  it('resolves an abandoned harness that has no lease row but does have durable activity', () => {
    const leaseOnly = (lease: number | null, _durable: number | null) => lease;
    const candidate = { id: 'EI-R', kind: 'no_replicator', createdAtMs: NOW - 20 * DAY_MS };

    const oldVerdict = decideStaleness({ ...candidate, lastActiveMs: leaseOnly(null, DURABLE) }, NOW);
    expect(oldVerdict.resolve).toBe(false);
    expect(oldVerdict.reason).toBe('unknown-activity-fail-closed');

    const newVerdict = decideStaleness({ ...candidate, lastActiveMs: pickLastActiveMs(null, DURABLE) }, NOW);
    expect(newVerdict.resolve).toBe(true);
  });

  it('still refuses when the durable source is silent too — a harness with no history anywhere', () => {
    const verdict = decideStaleness(
      { id: 'EI-R2', kind: 'no_replicator', createdAtMs: NOW - 20 * DAY_MS, lastActiveMs: pickLastActiveMs(null, null) },
      NOW,
    );
    expect(verdict.resolve).toBe(false);
    expect(verdict.reason).toBe('unknown-activity-fail-closed');
  });

  it('does not let a durable reading resurrect a RECENTLY-active harness into a resolve', () => {
    const verdict = decideStaleness(
      {
        id: 'EI-R3',
        kind: 'no_replicator',
        createdAtMs: NOW - 20 * DAY_MS,
        lastActiveMs: pickLastActiveMs(null, NOW - 3 * DAY_MS),
      },
      NOW,
    );
    expect(verdict.resolve).toBe(false);
    expect(verdict.reason).toBe('harness-recently-active');
  });
});
