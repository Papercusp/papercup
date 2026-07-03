/**
 * replication-liveness.test.ts — P-004 (WI-1840, WI-183 class).
 *
 * The detector that makes connected-but-dead replication VISIBLE: per-log
 * registry verdicts (no_replicator / frozen / sampling_stale), edge-triggered
 * stall episodes, the health-verdict input, and the durable-EI dedup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  sampleReplicationLiveness,
  getReplicationLiveness,
  dropReplicationLogState,
  dropReplicationLiveness,
  _resetReplicationLivenessForTests,
  SAMPLING_STALE_AFTER_MS,
  SWARM_CHURN_TOLERANCE_MS,
  type ReplicationStallEpisode,
} from '../replication-liveness';
import {
  fileReplicationStallEi,
  replicationStallEiTitle,
  _resetReplicationStallEiForTests,
  type ReplicationStallEiDeps,
} from '../replication-stall-ei';
import { assessHarnessSubstrateHealth } from '../health';

const WS = 'ws-1';
const HS = 'harness-a';
const KEY = 'a'.repeat(64);
const GRACE = 10_000;

afterEach(() => {
  _resetReplicationLivenessForTests();
  _resetReplicationStallEiForTests();
});

function collect(): { episodes: ReplicationStallEpisode[]; on: (e: ReplicationStallEpisode) => void } {
  const episodes: ReplicationStallEpisode[] = [];
  return { episodes, on: (e) => episodes.push(e) };
}

describe('no_replicator axis (the original WI-183 symptom)', () => {
  it('fires ONCE per stall episode after grace, only for a log that WAS replicating; clears + re-fires on recovery→re-stall', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (peers: number, len = 5, pos = 5) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );

    sample(1); // was replicating
    now += 1_000;
    sample(0); // detached
    expect(episodes).toHaveLength(0); // within grace
    now += GRACE; // past grace
    sample(0);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('no_replicator');
    now += 5_000;
    sample(0); // still stalled — edge-triggered, no re-fire
    expect(episodes).toHaveLength(1);

    // Recovery clears the latch…
    now += 1_000;
    sample(2);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
    // …and a LATER stall fires a fresh episode.
    now += 1_000;
    sample(0);
    now += GRACE;
    sample(0);
    expect(episodes).toHaveLength(2);
  });

  it('NEVER alarms for a log that has never shown a replicator peer (ordinary offline churn)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 3, mergedPosition: 0, peersCount: 0 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now - 1, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'never_connected',
    );
  });
});

describe('frozen axis (attached-but-dead: replicator present, ingest not flowing)', () => {
  it('fires once when the writer is ahead and merge position makes no progress past grace, with peers attached', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    const sample = (len: number, pos: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: 1 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );

    sample(10, 4); // behind — first sight seeds the progress clock (no instant alarm)
    expect(episodes).toHaveLength(0);
    now += GRACE;
    sample(10, 4); // still behind, zero progress for a whole grace window
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    now += 1_000;
    sample(12, 4); // still frozen (writer pulls further ahead) — no re-fire
    expect(episodes).toHaveLength(1);

    // Ingest progress clears the latch.
    now += 1_000;
    sample(12, 9);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
  });

  it('a caught-up idle log never freezes (idle writer ≠ dead replication)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 4; i += 1) {
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 7, mergedPosition: 7, peersCount: 1 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on },
      );
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    // …and a backlog appearing AFTER long idleness gets a fresh grace window.
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 9, mergedPosition: 7, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    expect(episodes).toHaveLength(0);
  });

  it('does not freeze-alarm while no replicator is attached (that is the other axis)', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 2, peersCount: 0 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    now += GRACE * 2;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 2, peersCount: 0 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );
    expect(episodes.filter((e) => e.kind === 'frozen')).toHaveLength(0);
  });
});

describe('read-time verdicts + registry lifecycle', () => {
  it('reports sampling_stale when the merge loop stops feeding the registry', () => {
    let now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    now += SAMPLING_STALE_AFTER_MS;
    const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE });
    expect(h!.logs[0]!.verdict).toBe('sampling_stale');
    expect(h!.counts.samplingStale).toBe(1);
  });

  it('filters by workspace/harness, exposes counts, and drops state on revoke/close', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    sampleReplicationLiveness(
      WS,
      'harness-b',
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    expect(getReplicationLiveness({ nowMs: now })).toHaveLength(2);
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })).toHaveLength(1);
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]!.counts.live).toBe(1);

    dropReplicationLogState(WS, HS, KEY); // revoked / re-verify-dropped
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]!.logs).toHaveLength(0);
    dropReplicationLiveness(WS, 'harness-b'); // handle close
    expect(getReplicationLiveness({ harnessSlug: 'harness-b', nowMs: now })).toHaveLength(0);
  });
});

describe('health-verdict input (P-004: stalls flip the harness off healthy)', () => {
  const base = { flagEnabled: true, handlePresent: true } as const;

  it('any no_replicator or frozen log ⇒ unhealthy with a WI-183-class reason', () => {
    const r = assessHarnessSubstrateHealth({
      ...base,
      replicationLiveness: { noReplicator: 1, frozen: 2 },
    });
    expect(r.verdict).toBe('unhealthy');
    expect(r.reasons.join(' ')).toContain('WI-183');
  });

  it('sampler-stale alone degrades (detector blind ≠ proven divergence); zero counts stay healthy', () => {
    expect(
      assessHarnessSubstrateHealth({
        ...base,
        replicationLiveness: { noReplicator: 0, frozen: 0, samplingStale: 1 },
      }).verdict,
    ).toBe('degraded');
    expect(
      assessHarnessSubstrateHealth({
        ...base,
        replicationLiveness: { noReplicator: 0, frozen: 0, samplingStale: 0 },
      }).verdict,
    ).toBe('healthy');
  });
});

describe('durable EI escalation (replication-stall-ei)', () => {
  const episode: ReplicationStallEpisode = {
    workspaceId: WS,
    harnessSlug: HS,
    logKeyHex: KEY,
    kind: 'no_replicator',
    stalledForMs: 200_000,
    detail: 'log=aaaaaaaaaaaa… has had 0 live replicator peers for 200s',
  };

  function fakeDeps(open: Array<{ title: string }>): {
    deps: ReplicationStallEiDeps;
    created: Array<{ title: string }>;
  } {
    const created: Array<{ title: string }> = [];
    return {
      created,
      deps: {
        listOpenByTopic: async () => open,
        create: async (input) => {
          created.push({ title: input.title });
          return { id: 'EI-999' };
        },
      },
    };
  }

  it('files a bug EI with the stable dedup title', async () => {
    const { deps, created } = fakeDeps([]);
    const id = await fileReplicationStallEi(episode, deps);
    expect(id).toBe('EI-999');
    expect(created[0]!.title).toBe(replicationStallEiTitle(episode));
  });

  it('dedupes against an already-open EI with the same title', async () => {
    const { deps, created } = fakeDeps([{ title: replicationStallEiTitle(episode) }]);
    const id = await fileReplicationStallEi(episode, deps);
    expect(id).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a different kind for the same log is a DIFFERENT escalation (not deduped)', async () => {
    const { deps, created } = fakeDeps([{ title: replicationStallEiTitle(episode) }]);
    const id = await fileReplicationStallEi({ ...episode, kind: 'frozen' }, deps);
    expect(id).toBe('EI-999');
    expect(created).toHaveLength(1);
  });
});

describe('connected_never_replicated axis (WI-183 zombie connections, rig run m1783114921)', () => {
  const sampleWith = (
    on: (e: ReplicationStallEpisode) => void,
    now: number,
    opts: { peers?: number; swarm?: number; pos?: number },
  ) =>
    sampleReplicationLiveness(
      WS,
      HS,
      {
        keyHex: KEY,
        knownLength: 5,
        mergedPosition: opts.pos ?? 0,
        peersCount: opts.peers,
        swarmConnections: opts.swarm,
      },
      { graceMs: GRACE, nowMs: now, onStallEpisode: on },
    );

  it('fires ONCE after grace when the swarm is connected but the log never attached a replicator; verdict reads no_replicator', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 2 }); // zombie window opens
    expect(episodes).toHaveLength(0);
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 2 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
    expect(episodes[0]!.detail).toContain('zombie');
    // Edge-triggered: still zombied → no re-fire.
    now += 5_000;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    // Read-time verdict lands in the red bucket consumers already handle.
    const view = getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!;
    expect(view.logs[0]!.verdict).toBe('no_replicator');
  });

  it('NEVER alarms with zero swarm connections (offline churn) or when the axis is unfed', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      sampleWith(on, now, { peers: 0, swarm: 0 }); // offline peer — churn
      now += GRACE;
    }
    for (let i = 0; i < 5; i += 1) {
      sampleWith(on, now, { peers: 0 }); // no swarm handle — axis disabled
      now += GRACE;
    }
    expect(episodes).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'never_connected',
    );
  });

  it('churn gaps within tolerance KEEP the window (zombie connections churn ~10s); the alarm still fires', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // window opens
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 0 }); // reconnect gap — within tolerance, kept
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // churned back
    now += 2_000; // total window = GRACE
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
  });

  it('a SUSTAINED offline stretch (past churn tolerance) RESETS the clock — genuinely-offline never alarms', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // window opens
    now += 4_000;
    sampleWith(on, now, { peers: 0, swarm: 0 }); // goes offline…
    now += SWARM_CHURN_TOLERANCE_MS + 1_000; // …and STAYS offline past tolerance
    sampleWith(on, now, { peers: 0, swarm: 0 }); // sustained → reset (no fire: swarm 0 never fires)
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // fresh window from here
    now += GRACE - 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // inside the fresh window
    expect(episodes).toHaveLength(0);
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1 }); // fresh window elapses → fires
    expect(episodes).toHaveLength(1);
  });

  it('replicator attachment recovers the log (live verdict) and a later zombie window re-fires', () => {
    const { episodes, on } = collect();
    let now = 1_000_000;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1 });
    expect(episodes).toHaveLength(1);
    // Replication finally attaches AND ingests (the 22:00:00 heal on the rig:
    // once the channel paired, the whole backlog crossed in <1s).
    now += 1_000;
    sampleWith(on, now, { peers: 1, swarm: 1, pos: 5 });
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe('live');
    // Once a log HAS replicated, the zombie axis stays off (no_replicator owns
    // the was-replicating stall) — no double-alarm.
    now += 1_000;
    sampleWith(on, now, { peers: 0, swarm: 1, pos: 5 });
    now += GRACE;
    sampleWith(on, now, { peers: 0, swarm: 1, pos: 5 });
    expect(episodes).toHaveLength(2);
    expect(episodes[1]!.kind).toBe('no_replicator');
  });
});
