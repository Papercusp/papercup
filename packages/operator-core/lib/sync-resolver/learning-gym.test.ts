import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * learning.gym resolver — the Learning tab's Gym view (operator-learning-tab P-006),
 * extended with the per-Hive lens (per-hive-learning-loops-2026-06-14 P-041): a
 * `hive` arg narrows the cross-harness rollup to ONE hive's gym harness. The gym
 * is scoped per (workspace_id, harness_slug) and the Hive home slug IS the gym
 * harness_slug, so the resolver threads `hive` straight through as `harnessSlug`
 * to the two control-plane readers. The readers themselves (the SQL `AND
 * harness_slug = …`) are covered at the control-plane/integration layer; here we
 * pin the resolver's arg threading + the workspace-wide default.
 *
 * WI-5809: there is NO cross-tenant fallback. A Hive-scoped read that comes back
 * empty returns EMPTY — it never silently substitutes the workspace-wide rollup.
 * The old WI-5420 behavior (fall back + flag `scopeFallback`) meant selecting the
 * Oddsmith pot rendered PAPERCUSP's gym experiments behind a muted note; showing
 * one tenant's data under another's lens is a correctness bug, so the fallback was
 * removed. See the scope-isolation describe block below.
 */

const listRecentProposalsForWorkspace = vi.fn();
const listAutoloopsForWorkspace = vi.fn();
const listScoutArchiveSeeds = vi.fn();
const listRecentCyclesForWorkspace = vi.fn();
const listRecentGymRunsForWorkspace = vi.fn();
vi.mock('../gym/control-plane', () => ({
  listRecentProposalsForWorkspace: (...a: unknown[]) => listRecentProposalsForWorkspace(...a),
  listAutoloopsForWorkspace: (...a: unknown[]) => listAutoloopsForWorkspace(...a),
  listScoutArchiveSeeds: (...a: unknown[]) => listScoutArchiveSeeds(...a),
  listRecentCyclesForWorkspace: (...a: unknown[]) => listRecentCyclesForWorkspace(...a),
  listRecentGymRunsForWorkspace: (...a: unknown[]) => listRecentGymRunsForWorkspace(...a),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// routeWithWorkspace just hands the resolver a tx — run the callback with a stub.
vi.mock('../route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => Promise<unknown>) => fn({ tag: 'tx' }),
}));

import { resolveNamedQueryV2 } from './index';
import { readGymSnapshot } from './learning-gym-read';

beforeEach(() => {
  listRecentProposalsForWorkspace.mockReset().mockResolvedValue([]);
  listAutoloopsForWorkspace.mockReset().mockResolvedValue([]);
  listScoutArchiveSeeds.mockReset().mockResolvedValue([]);
  listRecentCyclesForWorkspace.mockReset().mockResolvedValue([]);
  listRecentGymRunsForWorkspace.mockReset().mockResolvedValue([]);
});

describe('learning.gym — per-Hive lens (P-041)', () => {
  it('threads the hive through as harnessSlug to BOTH control-plane readers', async () => {
    await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' });
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50, harnessSlug: 'my-hive' },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', harnessSlug: 'my-hive' },
    );
  });

  it('omits harnessSlug entirely with no hive (cross-harness workspace rollup)', async () => {
    await resolveNamedQueryV2('learning.gym', {});
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50 },
    );
    expect(listAutoloopsForWorkspace).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
    expect(listScoutArchiveSeeds).toHaveBeenCalledWith({ tag: 'tx' }, { workspaceId: 'ws-test' });
  });

  it('returns the 1-element { proposals, autoloops, archiveSeeds, cycles } snapshot', async () => {
    listRecentProposalsForWorkspace.mockResolvedValue([{ id: 'p1' }]);
    listAutoloopsForWorkspace.mockResolvedValue([{ harnessSlug: 'my-hive' }]);
    listScoutArchiveSeeds.mockResolvedValue([{ candidateId: 'SP-002' }]);
    listRecentCyclesForWorkspace.mockResolvedValue([{ harnessSlug: 'my-hive', cycle: 1 }]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' })) as Array<{
      proposals: unknown[];
      autoloops: unknown[];
      archiveSeeds: unknown[];
      cycles: unknown[];
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].autoloops).toEqual([{ harnessSlug: 'my-hive' }]);
    expect(rows[0].archiveSeeds).toEqual([{ candidateId: 'SP-002' }]);
    expect(rows[0].cycles).toEqual([{ harnessSlug: 'my-hive', cycle: 1 }]);
  });

  it('threads the hive through to the recent-cycles reader too (WI-5685)', async () => {
    await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' });
    expect(listRecentCyclesForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 20, harnessSlug: 'my-hive' },
    );
  });

  it('recent-cycles read failure degrades to [] (WI-5685) — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listRecentCyclesForWorkspace.mockRejectedValue(new Error('no durable tables'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ cycles: unknown[] }>;
    expect(rows[0].cycles).toEqual([]);
    warn.mockRestore();
  });

  it('archive-seed read failure degrades to [] (WI-5412) — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listScoutArchiveSeeds.mockRejectedValue(new Error('no archive table'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ archiveSeeds: unknown[] }>;
    expect(rows[0].archiveSeeds).toEqual([]);
    warn.mockRestore();
  });
});

describe('learning.gym — scope isolation: NO cross-tenant fallback (WI-5809)', () => {
  it('an empty Hive-scoped read stays EMPTY — it never substitutes another pot\'s data', async () => {
    // The workspace HAS data, but none of it is scoped to this hive. Pre-WI-5809
    // the resolver returned that other data flagged `scopeFallback` — which is how
    // selecting Oddsmith rendered papercusp's gym experiments (owner report).
    listRecentProposalsForWorkspace
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p1', harnessSlug: 'gymloopharness' }]);

    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'oddsmith-hive' })) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].proposals).toEqual([]);
    expect(rows[0].scopeFallback).toBeUndefined();
    // THE INVARIANT: exactly ONE read, the scoped one. A second (unscoped) call is
    // the cross-tenant leak itself — it must not happen.
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 50, harnessSlug: 'oddsmith-hive' },
    );
  });

  it('a Hive-scoped read with its OWN data returns it, unflagged', async () => {
    listRecentProposalsForWorkspace.mockResolvedValueOnce([{ id: 'p1' }]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'papercusp' })) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].scopeFallback).toBeUndefined();
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
  });

  it('no hive arg ⇒ the deliberate workspace-wide rollup (unchanged)', async () => {
    listRecentProposalsForWorkspace.mockResolvedValueOnce([{ id: 'p1' }]);
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{
      proposals: unknown[];
      scopeFallback?: boolean;
    }>;
    expect(rows[0].proposals).toEqual([{ id: 'p1' }]);
    expect(rows[0].scopeFallback).toBeUndefined();
    expect(listRecentProposalsForWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('learning.gym — recent RUN activity (WI-5808)', () => {
  it('threads the hive through to the runs reader and returns it on the snapshot', async () => {
    listRecentGymRunsForWorkspace.mockResolvedValue([
      { harnessSlug: 'gymloopharness', variantId: 'baseline', cycle: 0, runCount: 3 },
    ]);
    const rows = (await resolveNamedQueryV2('learning.gym', { hive: 'my-hive' })) as Array<{
      runs: unknown[];
      generatedAt?: string;
    }>;
    expect(listRecentGymRunsForWorkspace).toHaveBeenCalledWith(
      { tag: 'tx' },
      { workspaceId: 'ws-test', limit: 20, harnessSlug: 'my-hive' },
    );
    expect(rows[0].runs).toEqual([
      { harnessSlug: 'gymloopharness', variantId: 'baseline', cycle: 0, runCount: 3 },
    ]);
    // WI-5810: every snapshot carries its generation time so the UI can stamp it.
    expect(typeof rows[0].generatedAt).toBe('string');
  });

  it('runs read failure degrades to [] — never fails the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listRecentGymRunsForWorkspace.mockRejectedValue(new Error('no durable tables'));
    const rows = (await resolveNamedQueryV2('learning.gym', {})) as Array<{ runs: unknown[] }>;
    expect(rows[0].runs).toEqual([]);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The read deadline (WI-39825).
//
// The three `.catch` blocks above are real leg isolation for a leg that THROWS
// and nothing at all for a leg that HANGS: `Promise.all` waits for the slowest,
// so one wedged store took the whole snapshot past the sync layer's resolver
// timeout and the view 500'd — shipping no rows AND no `degradedFields`, because
// the response itself never shipped. That is the failure the tests above cannot
// see, and it is why every case here hangs a leg rather than rejecting it.
//
// The subject is `readGymSnapshot` and not the resolver, deliberately: a
// resolver's only input is its wire `argsSchema`, so proving a deadline fires
// through one would mean shipping a `budgetMs` test knob to every client, or
// genuinely waiting GYM_READ_BUDGET_MS (6s) per case. `budgetMs` is a FUNCTION
// parameter on the extracted read, so the guard shrinks the budget to
// milliseconds and the shipped contract is untouched.
//
// The CONTROL is PERMANENT, per CLAUDE.md's falsifiability tiers: this subject
// is an imported module, so it belongs in tier 1 (a deliberately-wrong
// implementation kept in the test file) and NOT in the tier-3 in-tree mutation
// probe, which needs the git-sync lock and can be committed by a sweep while it
// holds the tree broken. Here the "wrong implementation" costs nothing to keep,
// because it is the REAL function with its bound widened past firing — exactly
// the pre-WI-39825 behaviour, reached through a production-real parameter, so it
// cannot rot out of sync with the code it controls for.
describe('learning.gym — read deadline (WI-39825)', () => {
  /** Never settles — a WEDGED store, not a failing one. */
  const hang = <T>(): Promise<T> => new Promise<T>(() => {});

  type Snapshot = {
    proposals: unknown[];
    autoloops: unknown[];
    archiveSeeds: unknown[];
    cycles: unknown[];
    runs: unknown[];
    degradedFields?: Array<{ field: string; kind: string; reason: string }>;
  };
  type Settled =
    | { kind: 'resolved'; snapshot: Snapshot }
    | { kind: 'rejected'; message: string }
    | { kind: 'pending' };

  /**
   * Observe WITHOUT waiting forever. "Never settles" is the failure mode under
   * test, so it has to be an assertable OUTCOME (`pending`) rather than a vitest
   * timeout — a timeout would report the control as a broken test instead of as
   * the guard discriminating correctly.
   */
  const settleWithin = (p: Promise<unknown>, ms: number): Promise<Settled> =>
    Promise.race([
      p.then(
        (snapshot): Settled => ({ kind: 'resolved', snapshot: snapshot as Snapshot }),
        (error): Settled => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
      ),
      new Promise<Settled>((resolve) => {
        const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);

  const read = (budgetMs: number) => readGymSnapshot({ workspaceId: 'ws-test', budgetMs });

  // PRIMARY legs. `proposals`/`autoloops` ARE the Gym view — a snapshot without
  // them is not degraded, it is wrong — so a lapse PROPAGATES, exactly as a
  // throw from those readers already does. The gain is a fast, LABELLED failure
  // at the budget instead of a hang the resolver timeout converts into an
  // unlabelled 500.
  for (const [leg, mockFn, label] of [
    ['proposals', () => listRecentProposalsForWorkspace, 'gym proposals'],
    ['autoloops', () => listAutoloopsForWorkspace, 'gym autoloops'],
  ] as const) {
    it(`a hung PRIMARY leg (${leg}) is REJECTED at the budget instead of hanging the read`, async () => {
      mockFn().mockReturnValue(hang());

      const outcome = await settleWithin(read(25), 500);

      expect(outcome.kind).toBe('rejected');
      // The label is the point: a bare timeout hides WHICH leg wedged, which is
      // the first thing anyone triaging this needs.
      expect(outcome.kind === 'rejected' && outcome.message).toContain(`${label} exceeded the read budget`);
    });
  }

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    listRecentProposalsForWorkspace.mockReturnValue(hang());

    // Deliberately-wrong version: a budget so large it cannot fire, which IS the
    // pre-WI-39825 behaviour. If this ever reports anything but `pending`, the
    // cases above have stopped measuring the deadline and pass for some other
    // reason.
    const outcome = await settleWithin(read(10_000_000), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still returns its snapshot under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" every case above by
    // breaking every read, healthy or not. Same 25ms budget, working store.
    listRecentProposalsForWorkspace.mockResolvedValue([{ id: 'SP-1' }]);
    listRecentGymRunsForWorkspace.mockResolvedValue([{ id: 'run-1' }]);

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect(snapshot?.proposals).toEqual([{ id: 'SP-1' }]);
    expect(snapshot?.runs).toEqual([{ id: 'run-1' }]);
    // A healthy snapshot stays byte-identical to what it was before the bound:
    // the flag's PRESENCE is the signal, so it must be absent, not empty.
    expect(snapshot?.degradedFields).toBeUndefined();
  });

  // SUPPLEMENTARY legs render empty perfectly well, so their lapse routes into
  // the EXISTING noteDegraded path — a timeout lands in the same place a read
  // failure already lands, carrying the leg label verbatim as its reason. This
  // is the partial the whole class-fix exists to preserve: rows still ship.
  for (const [field, mockFn, label] of [
    ['archiveSeeds', () => listScoutArchiveSeeds, 'gym archiveSeeds'],
    ['cycles', () => listRecentCyclesForWorkspace, 'gym cycles'],
    ['runs', () => listRecentGymRunsForWorkspace, 'gym runs'],
  ] as const) {
    it(`a hung SUPPLEMENTARY leg (${field}) lands as a NAMED degradedFields entry and the snapshot still ships`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      listRecentProposalsForWorkspace.mockResolvedValue([{ id: 'SP-1' }]);
      mockFn().mockReturnValue(hang());

      const outcome = await settleWithin(read(25), 500);
      warn.mockRestore();

      expect(outcome.kind).toBe('resolved');
      const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
      // The intact legs are TRUE, not sacrificed to the wedged one.
      expect(snapshot?.proposals).toEqual([{ id: 'SP-1' }]);
      expect(snapshot?.[field]).toEqual([]);
      // ...and the casualty is NAMED. Without this the empty section is
      // indistinguishable from "there is genuinely nothing here", which is the
      // silent-wrong-answer the degradedFields channel exists to prevent.
      const degraded = snapshot?.degradedFields ?? [];
      expect(degraded.map((d) => d.field)).toEqual([field]);
      expect(degraded[0]?.reason).toContain(`${label} exceeded the read budget`);
      // Classified as a read failure, NOT a new `timed-out` kind: UnavailableKind
      // is a shared union the learning-degraded-provenance client guards consume,
      // and widening it to say what the verbatim reason already says would strand
      // them for no information gain.
      expect(degraded[0]?.kind).toBe('read-failed');
    });
  }
});
