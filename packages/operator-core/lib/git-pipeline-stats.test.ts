/**
 * git-pipeline-stats.test.ts — pure unit coverage for the aggregator's helpers
 * (resolver-model resolution + routine-row mapping). The full snapshot read is
 * exercised against real Postgres via the pipeline-events integration test +
 * verified live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolverModel,
  toRoutineInfo,
  pinProvenGateCorrection,
  mapActiveRun,
  selectActiveCheckpointRoot,
  pickRetriageVerdict,
  projectGreenCheckpointFireFreshness,
  type RawGateCounters,
} from './git-pipeline-stats';
import type { PipelineEventRow } from './harness/git-sync/pipeline-events';

describe('resolverModel', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the merge-resolver spec from AGENT_MODELS', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus', 'merge-resolver': 'opus:xhigh' }));
    expect(resolverModel()).toBe('opus:xhigh');
  });

  it('falls back to the committed default when unset or malformed', () => {
    vi.stubEnv('AGENT_MODELS', '');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', '{not json');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus' })); // no merge-resolver key
    expect(resolverModel()).toBe('opus:xhigh');
  });
});

describe('toRoutineInfo', () => {
  it('returns null for a missing routine', () => {
    expect(toRoutineInfo(undefined)).toBeNull();
  });

  it('maps a routine row into the typed info (cron from trigger_config, dates → ms)', () => {
    const fired = new Date('2026-06-06T11:00:00Z');
    const next = new Date('2026-06-06T11:10:00Z');
    const info = toRoutineInfo({
      name: 'git-sync',
      active: true,
      trigger_config: { cron: '0 */10 * * * *', push: true },
      metadata: {},
      last_fired_at: fired,
      next_fire_at: next,
    });
    expect(info).toEqual({
      name: 'git-sync',
      active: true,
      cron: '0 */10 * * * *',
      lastFiredAtMs: fired.getTime(),
      nextFireAtMs: next.getTime(),
    });
  });

  it('tolerates a null trigger_config / null schedule timestamps', () => {
    const info = toRoutineInfo({
      name: 'release-trigger',
      active: false,
      trigger_config: null,
      metadata: null,
      last_fired_at: null,
      next_fire_at: null,
    });
    expect(info).toMatchObject({ name: 'release-trigger', active: false, cron: null, lastFiredAtMs: null, nextFireAtMs: null });
  });
});

describe('projectGreenCheckpointFireFreshness', () => {
  it('does not project verdict staleness as a non-firing routine', () => {
    expect(
      projectGreenCheckpointFireFreshness({
        fireStale: false,
        reason: 'no GREEN verdict in ~13h',
      }),
    ).toEqual({ fireStale: false, fireStaleReason: null });
  });

  it('keeps the fire-specific reason when the routine itself is stale', () => {
    expect(
      projectGreenCheckpointFireFreshness({
        fireStale: true,
        reason: 'the routine has not FIRED in ~4h',
      }),
    ).toEqual({ fireStale: true, fireStaleReason: 'the routine has not FIRED in ~4h' });
  });
});

/**
 * EI-13714 — the gate reports "STALLED — N consecutive reds" long after it has GREENED, because
 * the raw `gate_health` counters (`consecutiveReds` / `stalled` / `failingTests`) are the cache
 * `verdictStale` already proves superseded, yet every reader (`release:deploy{op:status}`, the
 * `/admin` Git tab, `dev:pipeline_position`) reported them unchanged in the SAME response that
 * carried `verdictStale:true` with a pin-advance reason. `pinProvenGateCorrection` is the single
 * point that resets those counters — pure, so it's covered here without a live Postgres (the full
 * `gitPipelineSnapshot` read that calls it is only exercised via integration test / live).
 */
describe('pinProvenGateCorrection (EI-13714)', () => {
  const RAW: RawGateCounters = {
    consecutiveReds: 11,
    stalled: true,
    failingTests: ['apps/operator/lib/some.test.ts'],
    firstRedAtMs: 1_700_000_000_000,
  };

  it('⭐ resets the streak to 0 when the pin advance PROVES a green happened since', () => {
    const out = pinProvenGateCorrection('pin-advance', RAW);
    expect(out).toEqual({ consecutiveReds: 0, stalled: false, failingTests: [], firstRedAtMs: null });
  });

  it('leaves the raw counters untouched for writer-starved (unverified, not proven green)', () => {
    expect(pinProvenGateCorrection('writer-starved', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched for retriage-proven (proves specific tests, not full-suite green)', () => {
    expect(pinProvenGateCorrection('retriage-proven', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched when the verdict is not stale at all', () => {
    expect(pinProvenGateCorrection(null, RAW)).toEqual(RAW);
  });
});

describe('mapActiveRun (overview-tab-expansion P-001)', () => {
  it('maps a live judging run: systemd timestamp → epoch ms, candidate + elapsed through', () => {
    const m = mapActiveRun({
      active: true,
      log_path: '/tmp/papercup-green-checkpoint-manual-demo.log',
      candidate: '06a0eb9577deadbeef',
      started_at: '2026-07-20T04:00:00.000Z',
      elapsed_sec: 840,
    });
    expect(m).toEqual({
      active: true,
      logPath: '/tmp/papercup-green-checkpoint-manual-demo.log',
      candidate: '06a0eb9577deadbeef',
      startedAtMs: Date.parse('2026-07-20T04:00:00.000Z'),
      elapsedSec: 840,
    });
  });

  it('maps an idle probe ({active:false}) with nulls — distinct from the not-probed null', () => {
    expect(mapActiveRun({ active: false })).toEqual({
      active: false,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
    });
  });

  it('nulls an unparseable systemd timestamp instead of NaN', () => {
    expect(mapActiveRun({ active: true, started_at: 'not-a-date' }).startedAtMs).toBeNull();
  });

  /**
   * EI-19327704778173646 / WI-7024. A single green-checkpoint run can re-candidate
   * mid-flight (in-process auto-refire onto tip), so `candidate` can legitimately differ
   * between two reads of the SAME run while pid/started_at never move. Without the
   * provenance below that reads as a corrupt/unstable field — which is exactly how several
   * agents misdiagnosed it on 2026-08-02.
   */
  it('carries refire provenance through when the run re-candidated mid-flight', () => {
    const m = mapActiveRun({
      active: true,
      candidate: '4961cfb8',
      initial_candidate: '14fb28da',
      refire_observed: true,
      started_at: '2026-08-02T08:37:45.565Z',
      elapsed_sec: 3400,
    });
    // The CURRENT candidate, not the abandoned one.
    expect(m.candidate).toBe('4961cfb8');
    expect(m.initialCandidate).toBe('14fb28da');
    expect(m.refireObserved).toBe(true);
    // startedAtMs deliberately stays the OUTER frame's — a candidate newer than it is the
    // healthy refire signature, not evidence the field is bogus.
    expect(m.startedAtMs).toBe(Date.parse('2026-08-02T08:37:45.565Z'));
  });

  it('omits refire provenance entirely when no refire was observed (shape unchanged)', () => {
    const m = mapActiveRun({ active: true, candidate: 'abc12345', elapsed_sec: 10 });
    expect(Object.prototype.hasOwnProperty.call(m, 'refireObserved')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(m, 'initialCandidate')).toBe(false);
  });
});

describe('selectActiveCheckpointRoot', () => {
  it('selects the requested harness root instead of the operator integration root', () => {
    expect(
      selectActiveCheckpointRoot({
        pipeline: 'sidestage',
        projectPaths: ['/srv/papercusp', '/srv/sidestage'],
        defaultPipeline: 'papercusp',
        defaultRoot: '/srv/papercusp',
      }),
    ).toBe('/srv/sidestage');
  });

  it('uses the deploy root only for the default pipeline and rejects unknown or ambiguous mappings', () => {
    const base = { projectPaths: ['/srv/a/sidestage', '/srv/b/sidestage'], defaultPipeline: 'papercusp', defaultRoot: '/srv/papercusp' };
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'papercusp', projectPaths: [] })).toBe('/srv/papercusp');
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'unknown' })).toBeNull();
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'sidestage' })).toBeNull();
  });
});

/**
 * EI-19399662484764592 (read side of WI-7290). `gate_health` records the re-triage only when it
 * classified `stale-candidate`, so the `real-red`-at-tip finding — the gate's strongest statement
 * that a red is genuinely current — was readable nowhere. These assert the append-only event's
 * verdict reaches readers, and that it is never mis-attributed to the wrong candidate.
 */
describe('pickRetriageVerdict (EI-19399662484764592, pure)', () => {
  const ev = (over: Partial<PipelineEventRow> & { detail?: unknown }): PipelineEventRow =>
    ({
      id: '1',
      kind: 'green_checkpoint',
      status: 'not-green',
      detail: {},
      createdAtMs: 1,
      ...over,
    }) as PipelineEventRow;

  it('⭐ surfaces a real-red-at-tip verdict — the classification gate_health deliberately drops', () => {
    const got = pickRetriageVerdict(
      [ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: 'def456789012', detail: 'reproduce at tip' } } })],
      'abc123456789',
    );
    expect(got).toEqual({
      classification: 'real-red',
      tip: 'def456789012',
      detail: 'reproduce at tip',
      candidate: 'abc123456789',
    });
  });

  it('surfaces an `unknown` verdict with its skip reason intact', () => {
    const got = pickRetriageVerdict(
      [ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'unknown', tip: null, detail: 'tip re-run SKIPPED: no failing entry resolved' } } })],
      'abc123456789',
    );
    expect(got?.classification).toBe('unknown');
    expect(got?.detail).toContain('SKIPPED');
    expect(got?.tip).toBeNull();
  });

  it('⭐ REFUSES to attribute a DIFFERENT candidate\'s re-triage to this verdict — a plausible wrong answer is worse than none', () => {
    const got = pickRetriageVerdict(
      [ev({ detail: { candidate: 'ffffffffffff', retriage: { classification: 'stale-candidate', tip: 'aaa', detail: 'passes at tip' } } })],
      'abc123456789',
    );
    expect(got).toBeNull();
  });

  it('matches across sha LENGTHS in both directions, so a full-length sha cannot silently downgrade a real verdict to unavailable', () => {
    const full = 'abc123456789def456789012345678901234abcd';
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: full, retriage: { classification: 'real-red', tip: null, detail: 'x' } } })], 'abc123456789'),
    ).not.toBeNull();
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } } })], full),
    ).not.toBeNull();
  });

  it('takes the NEWEST matching green_checkpoint event and ignores other pipeline kinds', () => {
    const got = pickRetriageVerdict(
      [
        ev({ kind: 'deploy', detail: { candidate: 'abc123456789', retriage: { classification: 'stale-candidate', tip: 'zzz', detail: 'wrong kind' } } }),
        ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: 'newest', detail: 'newest' } } }),
        ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'unknown', tip: 'older', detail: 'older' } } }),
      ],
      'abc123456789',
    );
    expect(got?.tip).toBe('newest');
  });

  it('returns null — meaning NOT AVAILABLE, never "no re-triage happened" — for a pre-WI-7290 event, a malformed blob, or no candidate', () => {
    // A verdict recorded before WI-7290 simply has no `retriage` key.
    expect(pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789' } })], 'abc123456789')).toBeNull();
    expect(pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: 'nope' } })], 'abc123456789')).toBeNull();
    // An unrecognised classification is dropped rather than passed through as a string.
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'bogus' } } })], 'abc123456789'),
    ).toBeNull();
    expect(pickRetriageVerdict([], 'abc123456789')).toBeNull();
    // No candidate under report ⇒ nothing could be matched against it.
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } } })], null),
    ).toBeNull();
  });
});
