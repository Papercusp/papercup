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
  projectGreenCheckpointPause,
  GIT_SYNC_CONFLICT_MAX_AGE_MS,
  isGitSyncConflictCurrent,
  currentGateInconclusive,
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

describe('currentGateInconclusive', () => {
  const mismatch = {
    status: 'repair-staging-mismatch',
    candidate: 'a'.repeat(40),
    detail: 'repair patch is not on staging',
    observedAtMs: 123,
  };

  it('suppresses a stale repair-owned hold once the authoritative queue is absent', () => {
    expect(currentGateInconclusive(mismatch, null)).toBeNull();
    expect(currentGateInconclusive({ ...mismatch, status: 'repair-in-progress' }, undefined)).toBeNull();
  });

  it('preserves repair holds while any queue payload remains', () => {
    expect(currentGateInconclusive(mismatch, { phase: 'ready-to-verify' })).toEqual(mismatch);
  });

  it('preserves non-repair aborts independently of the repair queue', () => {
    expect(currentGateInconclusive({ ...mismatch, status: 'migrations-pending' }, null)).toEqual({
      ...mismatch,
      status: 'migrations-pending',
    });
  });
});

describe('isGitSyncConflictCurrent', () => {
  const NOW = 1_800_000_000_000;

  it('keeps a freshly refreshed conflict row open without merge-completion proof', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('suppresses a row when the same sync tick proves its merge stage completed', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: NOW - 1_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('does not let proof from before the escalation retire a newer conflict row', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 1_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: NOW - 2_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('does not trust proof newer than the sync timestamp', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW - 2_000,
        lastMergeCompletedAtMs: NOW - 1_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('fails closed for a stale or malformed escalation timestamp', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - GIT_SYNC_CONFLICT_MAX_AGE_MS - 1,
        lastSyncedAtMs: null,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: null,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(false);
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
      pause: null,
    });
  });

  it('projects the deliberate pause record carried by routine metadata', () => {
    const info = toRoutineInfo({
      name: 'release-trigger',
      active: false,
      trigger_config: { cron: '0 */15 * * * *' },
      metadata: {
        pause: {
          reason: 'hold until repaired checkout is green',
          pausedBy: 'su-release-owner',
          pausedAtMs: 1_786_780_000_000,
        },
      },
      last_fired_at: null,
      next_fire_at: null,
    });
    expect(info?.pause).toEqual({
      reason: 'hold until repaired checkout is green',
      pausedBy: 'su-release-owner',
      pausedAtMs: 1_786_780_000_000,
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
    expect(info).toMatchObject({
      name: 'release-trigger',
      active: false,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
    });
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

describe('projectGreenCheckpointPause', () => {
  const paused = {
    name: 'green-checkpoint',
    active: false,
    cron: '0 0 * * * *',
    lastFiredAtMs: 1_786_779_000_000,
    nextFireAtMs: null,
    pause: {
      reason: 'hold while the repaired staging checkout is verified',
      pausedBy: 'su-release-owner',
      pausedAtMs: 1_786_780_000_000,
    },
  };

  it('projects an inactive routine pause as a deliberate fire hold with its reason', () => {
    expect(projectGreenCheckpointPause(paused)).toEqual({
      pause: paused.pause,
      fireStale: true,
      fireStaleReason:
        'green-checkpoint is deliberately PAUSED (active:false): hold while the repaired staging checkout is verified — ' +
        'no scheduled fire can occur until the hold is resumed',
    });
  });

  it('does not carry stale pause metadata onto an active routine', () => {
    expect(projectGreenCheckpointPause({ ...paused, active: true })).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
  });

  it('does not invent a pause for a missing or unpaused routine', () => {
    expect(projectGreenCheckpointPause(null)).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
    expect(projectGreenCheckpointPause({ ...paused, pause: null })).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
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
  it('projects user-manager provenance from the checkpoint probe into camelCase snapshot fields', () => {
    expect(
      mapActiveRun({
        active: true,
        systemd: {
          scope: 'user',
          argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
          load_state: 'loaded',
          known: true,
          invocation_id: 'invocation-123',
        },
      }),
    ).toMatchObject({
      systemd: {
        scope: 'user',
        argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
        loadState: 'loaded',
        known: true,
        invocationId: 'invocation-123',
      },
    });
  });

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
      progressAtMs: Date.parse('2026-07-20T04:00:00.000Z'),
      elapsedSec: 840,
    });
  });

  it('maps an idle probe ({active:false}) with nulls — distinct from the not-probed null', () => {
    expect(mapActiveRun({ active: false })).toEqual({
      active: false,
      candidate: null,
      startedAtMs: null,
      progressAtMs: null,
      elapsedSec: null,
    });
  });

  it('EI-210996: carries systemd-owned abnormal terminal evidence through the derived snapshot', () => {
    expect(
      mapActiveRun({
        active: false,
        terminal_marker: false,
        terminal_evidence: {
          source: 'systemd-exec-stop-post',
          candidate: '1f64eb2d',
          service_result: 'oom-kill',
          exit_code: 'killed',
          exit_status: 'KILL',
          abnormal: true,
        },
      }),
    ).toMatchObject({
      active: false,
      terminalMarker: false,
      terminalEvidence: {
        candidate: '1f64eb2d',
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
    });
  });

  it('nulls an unparseable systemd timestamp instead of NaN', () => {
    expect(mapActiveRun({ active: true, started_at: 'not-a-date' }).startedAtMs).toBeNull();
    expect(mapActiveRun({ active: true, started_at: 'not-a-date' }).progressAtMs).toBeNull();
  });

  it('maps an advancing log/phase heartbeat and does not reuse the immutable start time', () => {
    const m = mapActiveRun({
      active: true,
      started_at: '2026-08-20T09:00:00.000Z',
      progress_at: '2026-08-20T09:24:00.000Z',
    });
    expect(m.startedAtMs).toBe(Date.parse('2026-08-20T09:00:00.000Z'));
    expect(m.progressAtMs).toBe(Date.parse('2026-08-20T09:24:00.000Z'));
  });

  it('carries the run phase alongside its advancing heartbeat', () => {
    expect(
      mapActiveRun({
        active: true,
        started_at: '2026-08-20T09:00:00.000Z',
        progress_at: '2026-08-20T09:24:00.000Z',
        current_phase: 'delivering',
      }),
    ).toMatchObject({
      progressAtMs: Date.parse('2026-08-20T09:24:00.000Z'),
      currentPhase: 'delivering',
    });
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

  it('uses the explicit deploy root for the default pipeline even when registry paths are ambiguous', () => {
    const base = {
      projectPaths: ['/srv/a/papercusp', '/srv/b/papercusp'],
      defaultPipeline: 'papercusp',
      defaultRoot: '/srv/papercusp',
    };
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'papercusp' })).toBe('/srv/papercusp');
  });

  it('uses the deploy root when the default pipeline is absent and rejects unknown or ambiguous mappings', () => {
    const base = {
      projectPaths: ['/srv/a/sidestage', '/srv/b/sidestage'],
      defaultPipeline: 'papercusp',
      defaultRoot: '/srv/papercusp',
    };
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
      [
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'real-red', tip: 'def456789012', detail: 'reproduce at tip' },
          },
        }),
      ],
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
      [
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'unknown', tip: null, detail: 'tip re-run SKIPPED: no failing entry resolved' },
          },
        }),
      ],
      'abc123456789',
    );
    expect(got?.classification).toBe('unknown');
    expect(got?.detail).toContain('SKIPPED');
    expect(got?.tip).toBeNull();
  });

  it("⭐ REFUSES to attribute a DIFFERENT candidate's re-triage to this verdict — a plausible wrong answer is worse than none", () => {
    const got = pickRetriageVerdict(
      [
        ev({
          detail: {
            candidate: 'ffffffffffff',
            retriage: { classification: 'stale-candidate', tip: 'aaa', detail: 'passes at tip' },
          },
        }),
      ],
      'abc123456789',
    );
    expect(got).toBeNull();
  });

  it('matches across sha LENGTHS in both directions, so a full-length sha cannot silently downgrade a real verdict to unavailable', () => {
    const full = 'abc123456789def456789012345678901234abcd';
    expect(
      pickRetriageVerdict(
        [ev({ detail: { candidate: full, retriage: { classification: 'real-red', tip: null, detail: 'x' } } })],
        'abc123456789',
      ),
    ).not.toBeNull();
    expect(
      pickRetriageVerdict(
        [
          ev({
            detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } },
          }),
        ],
        full,
      ),
    ).not.toBeNull();
  });

  it('takes the NEWEST matching green_checkpoint event and ignores other pipeline kinds', () => {
    const got = pickRetriageVerdict(
      [
        ev({
          kind: 'deploy',
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'stale-candidate', tip: 'zzz', detail: 'wrong kind' },
          },
        }),
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'real-red', tip: 'newest', detail: 'newest' },
          },
        }),
        ev({
          detail: { candidate: 'abc123456789', retriage: { classification: 'unknown', tip: 'older', detail: 'older' } },
        }),
      ],
      'abc123456789',
    );
    expect(got?.tip).toBe('newest');
  });

  it('returns null — meaning NOT AVAILABLE, never "no re-triage happened" — for a pre-WI-7290 event, a malformed blob, or no candidate', () => {
    // A verdict recorded before WI-7290 simply has no `retriage` key.
    expect(pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789' } })], 'abc123456789')).toBeNull();
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: 'nope' } })], 'abc123456789'),
    ).toBeNull();
    // An unrecognised classification is dropped rather than passed through as a string.
    expect(
      pickRetriageVerdict(
        [ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'bogus' } } })],
        'abc123456789',
      ),
    ).toBeNull();
    expect(pickRetriageVerdict([], 'abc123456789')).toBeNull();
    // No candidate under report ⇒ nothing could be matched against it.
    expect(
      pickRetriageVerdict(
        [
          ev({
            detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } },
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
