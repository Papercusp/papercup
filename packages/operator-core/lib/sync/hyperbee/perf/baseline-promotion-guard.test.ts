/**
 * `--update-baseline` must not silently destroy the committed regression
 * threshold (WI-39359).
 *
 * `baselines/tier1.json` is the bar every future p2p-perf run is judged
 * against, and the flag that rewrites it REWRITES IT FROM THE CURRENT RUN
 * ALONE — its name does not say so. Two ordinary mistakes therefore destroy it
 * with no error at all:
 *
 *   - a partial run (`--scenario x --profile smoke`) collapses a 17-entry
 *     reference to the one cell it measured;
 *   - a run on a contended box bakes shared-box contention in as the bar,
 *     which moves it in the direction that HIDES future regressions.
 *
 * FALSIFIABILITY (repo discipline, tier 1 — a module we import): the pre-fix
 * behaviour lives permanently in this file as `promoteBlindly`, and every
 * refusal case asserts against BOTH it and the real subject. If the guard is
 * ever weakened back to "always write", the control and the subject stop
 * disagreeing and these tests fail. The `allows a legitimate full rebaseline`
 * case is the calibration: without it, a `checkBaselinePromotion` that refused
 * EVERYTHING would also pass every refusal case above.
 */
import { describe, expect, it } from 'vitest';
import { checkBaselinePromotion, entryKey, type BaselineFile } from './compare';

/**
 * The PRE-FIX behaviour, kept deliberately wrong and permanent: the runner used
 * to write whatever the run produced, unconditionally. Never call this outside
 * this file — it exists so the assertions below can be shown to discriminate.
 */
function promoteBlindly(): ReturnType<typeof checkBaselinePromotion> {
  return [];
}

function baseline(cells: Array<[string, number]>, profile = 'full'): BaselineFile {
  return {
    schema: 1,
    capturedAt: '2026-07-26T00:00:00.000Z',
    profile,
    host: { hostname: 'test', platform: 'linux', cpus: 128 },
    entries: cells.map(([scenario, peers]) => ({
      scenario,
      params: { peers },
      metrics: {},
      loopLagP95Ms: 100,
      convergence: null,
    })),
  };
}

/** The shape of the committed tier1.json: many scenarios × many peer counts. */
const COMMITTED = baseline([
  ['replication.sustained', 2],
  ['replication.sustained', 5],
  ['replication.sustained', 10],
  ['merge.idle-tick', 2],
  ['merge.idle-tick', 5],
  ['churn.rejoin', 2],
]);

/** What a `--profile smoke --scenario replication.sustained` run produces. */
const PARTIAL = baseline([['replication.sustained', 2]], 'smoke');

const QUIET = { hostOversubscribed: false, allowShrink: false, allowContended: false };

describe('checkBaselinePromotion', () => {
  it('refuses a partial run that would collapse the committed baseline', () => {
    const refusals = checkBaselinePromotion({ existing: COMMITTED, next: PARTIAL, ...QUIET });

    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toBe('coverage-shrink');
    expect(refusals[0].overrideFlag).toBe('--allow-baseline-shrink');
    // The 5 cells that would have stopped being guarded, named — not just counted.
    expect(refusals[0].droppedKeys).toHaveLength(5);
    expect(refusals[0].droppedKeys).toContain(entryKey('merge.idle-tick', { peers: 5 }));
    expect(refusals[0].droppedKeys).not.toContain(entryKey('replication.sustained', { peers: 2 }));
    // The message must carry the override, or the refusal is a dead end.
    expect(refusals[0].message).toContain('--allow-baseline-shrink');

    // CONTROL: the pre-fix behaviour permits exactly this collapse.
    expect(promoteBlindly()).toHaveLength(0);
  });

  it('refuses a run the host flagged oversubscribed, even at full coverage', () => {
    const refusals = checkBaselinePromotion({
      existing: COMMITTED,
      next: COMMITTED,
      hostOversubscribed: true,
      allowShrink: false,
      allowContended: false,
    });

    expect(refusals.map((r) => r.reason)).toEqual(['contended-host']);
    expect(refusals[0].overrideFlag).toBe('--allow-contended-baseline');
    expect(promoteBlindly()).toHaveLength(0);
  });

  it('reports BOTH risks independently, and one override does not accept the other', () => {
    const both = {
      existing: COMMITTED,
      next: PARTIAL,
      hostOversubscribed: true,
      allowShrink: false,
      allowContended: false,
    };
    expect(checkBaselinePromotion(both).map((r) => r.reason).sort()).toEqual([
      'contended-host',
      'coverage-shrink',
    ]);

    // Accepting the shrink must NOT smuggle through the contended capture.
    expect(checkBaselinePromotion({ ...both, allowShrink: true }).map((r) => r.reason)).toEqual([
      'contended-host',
    ]);
    // ...and vice versa. This is the property a single blanket --force loses.
    expect(checkBaselinePromotion({ ...both, allowContended: true }).map((r) => r.reason)).toEqual([
      'coverage-shrink',
    ]);
  });

  it('allows a legitimate full rebaseline on a quiet host (calibration)', () => {
    // Without this case, a checkBaselinePromotion that refused unconditionally
    // would satisfy every assertion above.
    expect(checkBaselinePromotion({ existing: COMMITTED, next: COMMITTED, ...QUIET })).toEqual([]);
  });

  it('allows a run that ADDS coverage', () => {
    const wider = baseline([...COMMITTED.entries.map((e) => [e.scenario, e.params.peers as number] as [string, number]), ['churn.rejoin', 5]]);
    expect(checkBaselinePromotion({ existing: COMMITTED, next: wider, ...QUIET })).toEqual([]);
  });

  it('allows creating a baseline where none exists — only an overwrite can shrink one', () => {
    expect(checkBaselinePromotion({ existing: null, next: PARTIAL, ...QUIET })).toEqual([]);
  });

  it('honours each override for the risk it names', () => {
    expect(
      checkBaselinePromotion({ existing: COMMITTED, next: PARTIAL, ...QUIET, allowShrink: true }),
    ).toEqual([]);
    expect(
      checkBaselinePromotion({
        existing: COMMITTED,
        next: COMMITTED,
        hostOversubscribed: true,
        allowShrink: false,
        allowContended: true,
      }),
    ).toEqual([]);
  });

  it('keys coverage by scenario AND params, not scenario alone', () => {
    // A run covering the same scenarios at DIFFERENT peer counts is not
    // coverage — this is the case a scenario-name-only check would wave through.
    const sameScenariosOtherPeers = baseline([
      ['replication.sustained', 3],
      ['merge.idle-tick', 3],
      ['churn.rejoin', 3],
    ]);
    const refusals = checkBaselinePromotion({
      existing: COMMITTED,
      next: sameScenariosOtherPeers,
      ...QUIET,
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0].droppedKeys).toHaveLength(6);
  });
});
