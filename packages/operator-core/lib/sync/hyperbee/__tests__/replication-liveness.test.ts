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
  setReplicationStallRecoveryReporterForTests,
  setReplicationRepairHandler,
  setDhtUniverseAssertion,
  _resetReplicationLivenessForTests,
  SAMPLING_STALE_AFTER_MS,
  SWARM_CHURN_TOLERANCE_MS,
  type ReplicationStallEpisode,
} from '../replication-liveness';
import {
  fileReplicationStallEi,
  resolveReplicationStallEi,
  replicationStallEiTitle,
  _resetReplicationStallEiForTests,
  type ReplicationStallEiDeps,
  type StallEiEpisode,
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
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
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

  describe('EI-7110: onRecovery fires ONLY on a genuine alarm→recovered transition', () => {
    function collectRecovery(): {
      recoveries: ReplicationStallEpisode[];
      onRecovery: (e: ReplicationStallEpisode) => void;
    } {
      const recoveries: ReplicationStallEpisode[] = [];
      return { recoveries, onRecovery: (e) => recoveries.push(e) };
    }

    it('fires once when a log that alarmed no_replicator regains a live peer, with the stall duration', () => {
      const { episodes, on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      let now = 1_000_000;
      const sample = (peers: number) =>
        sampleReplicationLiveness(
          WS,
          HS,
          { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
          { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery },
        );

      sample(1); // was replicating
      now += 1_000;
      sample(0); // detached
      now += GRACE; // past grace — alarms
      sample(0);
      expect(episodes).toHaveLength(1);
      expect(recoveries).toHaveLength(0); // still down, nothing recovered yet

      now += 20_000;
      sample(3); // regains a peer
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0]!.kind).toBe('no_replicator');
      expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE + 20_000);
      expect(recoveries[0]!.detail).toContain('regained a live replicator peer');

      // A later re-stall + re-recovery fires again (edge-triggered both ways).
      now += 1_000;
      sample(0);
      now += GRACE;
      sample(0);
      now += 1_000;
      sample(1);
      expect(recoveries).toHaveLength(2);
    });

    it('never fires for ordinary flapping that never crossed the alarm threshold', () => {
      const { on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      let now = 1_000_000;
      const sample = (peers: number) =>
        sampleReplicationLiveness(
          WS,
          HS,
          { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
          { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery },
        );

      sample(1);
      now += 1_000;
      sample(0); // detaches
      now += 2_000; // well within grace
      sample(1); // reconnects before ever alarming
      expect(recoveries).toHaveLength(0);
    });

    it('never fires for a log that never had a live replicator peer (nothing to recover from)', () => {
      const { on } = collect();
      const { recoveries, onRecovery } = collectRecovery();
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 3, mergedPosition: 0, peersCount: 1 },
        { graceMs: GRACE, nowMs: 1_000_000, onStallEpisode: on, onRecovery },
      );
      expect(recoveries).toHaveLength(0);
    });
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
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
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

  // EI-4643: the frozen axis must REPORT recovery (not just reset its latch) so
  // the durable EI a frozen episode filed auto-closes — previously only the
  // no_replicator axis was wired for onRecovery.
  it('reports recovery with kind=frozen once ingest resumes after a freeze alarm', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (len: number, pos: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: 1 },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: (e) => episodes.push(e),
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(10, 4); // behind — seeds the progress clock
    now += GRACE;
    sample(10, 4); // zero progress for a whole grace window → frozen alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    expect(recoveries).toHaveLength(0);

    now += 3_000;
    sample(10, 9); // ingest resumes → recovery reported (auto-closes the EI)
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('frozen');
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('ingest resumed');

    // No spurious recovery for a freeze that never crossed the alarm grace.
    recoveries.length = 0;
    now += 1_000;
    sample(12, 9); // becomes behind — fresh window, no alarm
    now += 1_000;
    sample(12, 12); // catches up before ever alarming
    expect(recoveries).toHaveLength(0);
  });

  // EI-7834: a FROZEN log whose replicator DETACHES (peers → 0) must report a
  // frozen recovery so its durable EI auto-closes. The frozen-recovery path only
  // fires on ingest-progress / caught-up, neither of which can happen with 0
  // peers, so before this the frozen latch stayed set and the frozen EI orphaned
  // open forever (observed pile-up: log 298a676c froze, then lost its replicator —
  // the no_replicator/zombie EIs cycled but the frozen EI never resolved).
  it('reports recovery with kind=frozen when the replicator detaches (peers→0) after a freeze alarm', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (len: number, pos: number, peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: len, mergedPosition: pos, peersCount: peers },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: (e) => episodes.push(e),
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(10, 4, 1); // behind, replicator attached — seeds the progress clock
    now += GRACE;
    sample(10, 4, 1); // zero ingest for a whole grace window → frozen alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('frozen');
    expect(recoveries).toHaveLength(0);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'frozen',
    );

    // The replicator detaches while still frozen. The frozen premise (attached)
    // is gone → exactly ONE frozen recovery fires (so the EI auto-closes), and the
    // frozen latch clears (the verdict no longer reads 'frozen').
    now += 2_000;
    sample(10, 4, 0);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('frozen');
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('replicator detached');
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).not.toBe(
      'frozen',
    );

    // No double-report: staying detached does not re-fire the frozen recovery,
    // and the now-detached log settles into the no_replicator axis past grace.
    now += GRACE;
    sample(10, 4, 0);
    expect(recoveries.filter((r) => r.kind === 'frozen')).toHaveLength(1);
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'no_replicator',
    );
  });

  it('a behind log that never crossed the freeze grace fires NO frozen recovery when its replicator detaches', () => {
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 10, mergedPosition: 4, peersCount: peers },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: () => {},
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(1); // behind, attached — but never held past grace
    now += 2_000; // well within grace
    sample(0); // replicator detaches before ever freeze-alarming
    expect(recoveries.filter((r) => r.kind === 'frozen')).toHaveLength(0);
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

describe('WI-3604: DHT-universe mismatch axis (split-DHT-universe outage class)', () => {
  it('a flagged harness reads dht_universe_mismatch on every log — not no_replicator/frozen', () => {
    const now = 1_000_000;
    // A log that WOULD otherwise read 'frozen' (replicator attached, ingest stalled past grace).
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 10, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now + GRACE + 1, onStallEpisode: () => {} },
    );
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'joined the PUBLIC DHT, expected isolated' });
    const [h] = getReplicationLiveness({ nowMs: now + GRACE + 1, graceMs: GRACE, harnessSlug: HS });
    expect(h!.dhtUniverseMismatch).toBe(true);
    expect(h!.dhtUniverseDetail).toMatch(/PUBLIC DHT/);
    expect(h!.logs[0]!.verdict).toBe('dht_universe_mismatch');
    expect(h!.counts.dhtUniverseMismatch).toBe(1);
    expect(h!.counts.frozen).toBe(0);
    expect(h!.counts.noReplicator).toBe(0);
  });

  it('surfaces the mismatch even with ZERO sampled logs (flag set before any admission)', () => {
    setDhtUniverseAssertion(WS, 'harness-empty', { ok: false, detail: 'mismatch, no logs yet' });
    const [h] = getReplicationLiveness({ harnessSlug: 'harness-empty' });
    expect(h!.dhtUniverseMismatch).toBe(true);
    expect(h!.logs).toHaveLength(0);
    expect(h!.counts.dhtUniverseMismatch).toBe(0);
  });

  it('ok:true clears a previously-recorded mismatch (re-join after the fix)', () => {
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'mismatch' });
    expect(getReplicationLiveness({ harnessSlug: HS })[0]!.dhtUniverseMismatch).toBe(true);
    setDhtUniverseAssertion(WS, HS, { ok: true, detail: 'matches' });
    expect(getReplicationLiveness({ harnessSlug: HS })).toHaveLength(0);
  });

  it('feeds assessHarnessSubstrateHealth as a distinct unhealthy reason', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now },
    );
    setDhtUniverseAssertion(WS, HS, { ok: false, detail: 'joined the PUBLIC DHT' });
    const [h] = getReplicationLiveness({ nowMs: now, graceMs: GRACE, harnessSlug: HS });
    const result = assessHarnessSubstrateHealth({
      flagEnabled: true,
      handlePresent: true,
      replicationLiveness: {
        noReplicator: h!.counts.noReplicator,
        frozen: h!.counts.frozen,
        samplingStale: h!.counts.samplingStale,
        dhtUniverseMismatch: h!.counts.dhtUniverseMismatch,
      },
    });
    expect(result.verdict).toBe('unhealthy');
    expect(result.reasons.join(' ')).toMatch(/DHT-universe mismatch/);
    expect(result.reasons.join(' ')).not.toMatch(/WI-183 class/);
  });
});

describe('EI-7788: dropping an ALARMED log auto-resolves its durable EI (orphan fix)', () => {
  function collectDropRecoveries(): ReplicationStallEpisode[] {
    const recoveries: ReplicationStallEpisode[] = [];
    // The drop path routes through the module-level recovery reporter (no opts arg),
    // so capture it via the module seam rather than a per-call onRecovery.
    setReplicationStallRecoveryReporterForTests((e) => recoveries.push(e));
    return recoveries;
  }

  it('dropReplicationLogState fires a recovery for an alarmed no_replicator log so the EI can auto-close', () => {
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(1); // was replicating
    now += GRACE + 1_000;
    sample(0); // stalled past grace → alarmed + EI filed
    expect(getReplicationLiveness({ nowMs: now, graceMs: GRACE })[0]!.logs[0]!.verdict).toBe(
      'no_replicator',
    );

    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY); // peer revoked / re-verify-dropped while stalled
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('no_replicator');
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.detail).toContain('dropped from tracking');
    // State is gone regardless.
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })[0]?.logs ?? []).toHaveLength(0);
  });

  it('dropping a HEALTHY (never-alarmed) log fires NO recovery (no spurious EI resolve)', () => {
    const now = 1_000_000;
    sampleReplicationLiveness(
      WS,
      HS,
      { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: 1 },
      { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
    );
    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY);
    expect(recoveries).toHaveLength(0);
  });

  it('dropReplicationLiveness (handle close) fires recoveries for every alarmed log in the harness', () => {
    let now = 1_000_000;
    const KEY_B = 'b'.repeat(64);
    const sample = (key: string, peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: key, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(KEY, 1); // KEY was replicating…
    sample(KEY_B, 1); // KEY_B stays live (no alarm)
    now += GRACE + 1_000;
    sample(KEY, 0); // KEY stalls past grace → alarmed
    sample(KEY_B, 1);

    const recoveries = collectDropRecoveries();
    dropReplicationLiveness(WS, HS); // harness handle close
    // Only the alarmed log (KEY) reports a recovery; the live one (KEY_B) does not.
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.logKeyHex).toBe(KEY);
    expect(recoveries[0]!.kind).toBe('no_replicator');
    expect(getReplicationLiveness({ harnessSlug: HS, nowMs: now })).toHaveLength(0);
  });

  it('drop is idempotent — a second drop of the same log fires no further recovery', () => {
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: () => {}, onRecovery: () => {} },
      );
    sample(1);
    now += GRACE + 1_000;
    sample(0);
    const recoveries = collectDropRecoveries();
    dropReplicationLogState(WS, HS, KEY);
    dropReplicationLogState(WS, HS, KEY); // boot.ts double-calls on revoke — must not re-fire
    expect(recoveries).toHaveLength(1);
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

  function fakeDeps(open: Array<{ id?: string; title: string }>): {
    deps: ReplicationStallEiDeps;
    created: Array<{ title: string }>;
    resolved: Array<{ id: string; note: string }>;
  } {
    const created: Array<{ title: string }> = [];
    const resolved: Array<{ id: string; note: string }> = [];
    return {
      created,
      resolved,
      deps: {
        listOpenByTopic: async () => open.map((o) => ({ id: o.id ?? 'EI-OPEN', title: o.title })),
        create: async (input) => {
          created.push({ title: input.title });
          return { id: 'EI-999' };
        },
        resolve: async (id, note) => {
          resolved.push({ id, note });
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

  it('WI-2136 drain_orphan_tail files under its own dead-key title + runbook body', async () => {
    const { deps, created } = fakeDeps([]);
    let body = '';
    deps.create = async (input) => {
      created.push({ title: input.title });
      body = input.body;
      return { id: 'EI-999' };
    };
    // logKeyHex is the DEAD prior-era key so distinct dead eras page separately.
    const orphan: StallEiEpisode = {
      ...episode,
      kind: 'drain_orphan_tail',
      logKeyHex: 'bb'.repeat(32),
      detail: 'orphan-tail probe',
    };
    const id = await fileReplicationStallEi(orphan, deps);
    expect(id).toBe('EI-999');
    expect(created[0]!.title).toBe(replicationStallEiTitle(orphan));
    expect(created[0]!.title).toContain('drain_orphan_tail');
    // The body carries the runbook (drained_at=NULL re-emit) + the root fix hint.
    expect(body).toContain('drained_at=NULL');
    expect(body).toContain('keypair');
  });

  describe('EI-7110: resolveReplicationStallEi (auto-close on recovery)', () => {
    it('resolves the matching open EI with a recovery note', async () => {
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([{ id: 'EI-7110', title }]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'regained a peer after 300s' },
        deps,
      );
      expect(ids).toEqual(['EI-7110']);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.id).toBe('EI-7110');
      expect(resolved[0]!.note).toContain('auto-resolved');
      expect(resolved[0]!.note).toContain('regained a peer after 300s');
    });

    it('no-ops when no open EI matches the title (already resolved, or never crossed the escalation grace)', async () => {
      const { deps, resolved } = fakeDeps([]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      expect(ids).toEqual([]);
      expect(resolved).toHaveLength(0);
    });

    it('a DIFFERENT kind for the same log does not resolve an unrelated open EI (title is kind-scoped)', async () => {
      const { deps, resolved } = fakeDeps([{ id: 'EI-1', title: replicationStallEiTitle({ ...episode, kind: 'frozen' }) }]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      expect(ids).toEqual([]);
      expect(resolved).toHaveLength(0);
    });

    it('EI-6772: resolves ALL duplicate open EIs for one (harness, log, kind), not just the first', async () => {
      // Duplicate opens arise legitimately across the federated multi-machine
      // ledger: two machines each file an origin:remote EI for one stall before
      // the other replicates in (exactly EI-6772 + its sibling EI-7764 — same
      // harness/log/kind). A .find recovery closed EI-7764 and stranded EI-6772
      // open forever; the .filter fix sweeps up every duplicate on recovery.
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([
        { id: 'EI-7764', title },
        { id: 'EI-6772', title },
      ]);
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'regained a peer after 180s' },
        deps,
      );
      expect(ids).toEqual(['EI-7764', 'EI-6772']);
      expect(resolved.map((r) => r.id)).toEqual(['EI-7764', 'EI-6772']);
      for (const r of resolved) expect(r.note).toContain('auto-resolved');
    });

    it('resolves the healthy siblings even when one resolve() call throws (per-EI best-effort)', async () => {
      const title = replicationStallEiTitle(episode);
      const { deps, resolved } = fakeDeps([
        { id: 'EI-A', title },
        { id: 'EI-B', title },
      ]);
      const inner = deps.resolve;
      deps.resolve = async (id, note) => {
        if (id === 'EI-A') throw new Error('transient PG failure');
        await inner(id, note);
      };
      const ids = await resolveReplicationStallEi(
        { harnessSlug: HS, logKeyHex: KEY, kind: 'no_replicator', detail: 'recovered' },
        deps,
      );
      // EI-A's resolve threw, but EI-B is still closed (siblings never stranded).
      expect(ids).toEqual(['EI-B']);
      expect(resolved.map((r) => r.id)).toEqual(['EI-B']);
    });
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
      { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
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

  // EI-4643: a zombie-connection EI must AUTO-CLOSE once the log attaches a live
  // replicator. Previously the connected_never_replicated axis reset its latch
  // silently (no onRecovery), so its durable EI sat open forever — this pins the
  // recovery-reporting wiring for the exact class EI-4643 belongs to.
  it('EI-4643: reports recovery with kind=connected_never_replicated once a live replicator attaches', () => {
    const { episodes, on } = collect();
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number | undefined, swarm: number, pos = 0) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: pos, peersCount: peers, swarmConnections: swarm },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(0, 2); // swarm-connected but never replicated — zombie window opens
    now += GRACE;
    sample(0, 2); // held past grace → alarm
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('connected_never_replicated');
    expect(recoveries).toHaveLength(0);

    now += 5_000;
    sample(1, 1, 5); // a live replicator finally attaches → recovery reported
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.kind).toBe('connected_never_replicated');
    expect(recoveries[0]!.stalledForMs).toBeGreaterThanOrEqual(GRACE);
    expect(recoveries[0]!.detail).toContain('replicator');
  });

  it('never reports recovery for a zombie window that never crossed the alarm grace', () => {
    const { on } = collect();
    const recoveries: ReplicationStallEpisode[] = [];
    let now = 1_000_000;
    const sample = (peers: number | undefined, swarm: number, pos = 0) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: pos, peersCount: peers, swarmConnections: swarm },
        {
          graceMs: GRACE,
          nowMs: now,
          onStallEpisode: on,
          onRecovery: (e) => recoveries.push(e),
        },
      );

    sample(0, 1); // window opens
    now += 2_000; // well within grace
    sample(1, 1, 5); // replicator attaches before ever alarming
    expect(recoveries).toHaveLength(0);
  });
});

describe('WI-3684 repair-on-detect: the per-harness repair-handler seam', () => {
  // Drive the zombie axis (swarm connected, replicator never attached): two
  // samples spanning the grace window fire exactly one episode.
  const driveZombieEpisode = (
    on: (e: ReplicationStallEpisode) => void,
    startMs = 1_000_000,
  ): void => {
    const sample = (now: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 0, peersCount: 0, swarmConnections: 3 },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
    sample(startMs);
    sample(startMs + GRACE);
  };

  it('a registered handler receives the connected_never_replicated episode ALONGSIDE the reporter', () => {
    const { episodes, on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    driveZombieEpisode(on);
    expect(episodes).toHaveLength(1);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.kind).toBe('connected_never_replicated');
    expect(repairs[0]!.logKeyHex).toBe(KEY);
    expect(repairs[0]!.workspaceId).toBe(WS);
    expect(repairs[0]!.harnessSlug).toBe(HS);
  });

  it('the seam is kind-agnostic — a no_replicator episode dispatches too (registrants filter)', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    let now = 1_000_000;
    const sample = (peers: number) =>
      sampleReplicationLiveness(
        WS,
        HS,
        { keyHex: KEY, knownLength: 5, mergedPosition: 5, peersCount: peers },
        { graceMs: GRACE, nowMs: now, onStallEpisode: on, onRecovery: () => {} },
      );
    sample(1); // was replicating
    now += 1_000;
    sample(0); // detached
    now += GRACE;
    sample(0); // past grace → no_replicator episode
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.kind).toBe('no_replicator');
  });

  it('a THROWING handler never breaks the sample — the episode still reaches the reporter', () => {
    const { episodes, on } = collect();
    setReplicationRepairHandler(WS, HS, () => {
      throw new Error('repair exploded');
    });
    expect(() => driveZombieEpisode(on)).not.toThrow();
    expect(episodes).toHaveLength(1);
  });

  it('only the matching harness dispatches; null unregisters', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, 'some-other-harness', (e) => repairs.push(e));
    driveZombieEpisode(on);
    expect(repairs).toHaveLength(0); // wrong harness — never dispatched

    _resetReplicationLivenessForTests();
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    setReplicationRepairHandler(WS, HS, null); // unregister
    driveZombieEpisode(on);
    expect(repairs).toHaveLength(0);
  });

  it('dropReplicationLiveness (handle close) clears the handler — a post-close episode never reaches it', () => {
    const { on } = collect();
    const repairs: ReplicationStallEpisode[] = [];
    setReplicationRepairHandler(WS, HS, (e) => repairs.push(e));
    dropReplicationLiveness(WS, HS); // handle closed — handler must die with it
    driveZombieEpisode(on); // fresh state re-alarms after grace
    expect(repairs).toHaveLength(0);
  });
});
