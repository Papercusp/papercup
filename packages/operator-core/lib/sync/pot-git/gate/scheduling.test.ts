/**
 * scheduling.test.ts — DG-3 (P-046) pure tests: the dedup floor, capability
 * matching, work-item spec mapping (claim-machinery reuse), pull ranking.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MACHINE_TAGS,
  eligibleShards,
  machineCanRunShard,
  planShardRuns,
  rankShardsForMachine,
  shardRequiredTags,
  shardRunDedupeKey,
  shardRunWorkItemSpecs,
  type KnownVerdictFact,
  type ShardRunTarget,
} from './scheduling';

const H = (c: string) => c.repeat(64);
const t = (shardId: string, inputsHash: string, layer: 'unit' | 'integration' = 'unit'): ShardRunTarget => ({
  shardId,
  inputsHash,
  layer,
});
const v = (
  shard_id: string,
  inputs_hash: string,
  verdict: 'pass' | 'fail',
  gateTrusted: boolean,
): KnownVerdictFact => ({ shard_id, inputs_hash, verdict, gateTrusted });

describe('planShardRuns — the dedup floor', () => {
  const targets = [t('a::unit', H('1')), t('b::unit', H('2')), t('c::integration', H('3'), 'integration')];

  it('a gate-trusted pass at the EXACT inputs covers; anything else must run', () => {
    const plan = planShardRuns({
      targets,
      verdicts: [
        v('a::unit', H('1'), 'pass', true), // covers a
        v('b::unit', H('9'), 'pass', true), // stale inputs — does NOT cover b
        v('c::integration', H('3'), 'pass', false), // untrusted — does NOT cover c
      ],
    });
    expect(plan.reusable.map((x) => x.shardId)).toEqual(['a::unit']);
    expect(plan.needed.map((x) => x.shardId)).toEqual(['b::unit', 'c::integration']);
    expect(plan.spotChecks).toEqual([]);
  });

  it('a trusted FAIL never covers — it flags the needed run as known-red', () => {
    const plan = planShardRuns({
      targets: [t('a::unit', H('1'))],
      verdicts: [v('a::unit', H('1'), 'fail', true)],
    });
    expect(plan.needed).toHaveLength(1);
    expect(plan.needed[0].hasTrustedFail).toBe(true);
    expect(plan.reusable).toEqual([]);
  });

  it('a trusted pass beats a trusted fail at the same inputs (any honest pass covers)', () => {
    const plan = planShardRuns({
      targets: [t('a::unit', H('1'))],
      verdicts: [v('a::unit', H('1'), 'fail', true), v('a::unit', H('1'), 'pass', true)],
    });
    expect(plan.reusable).toHaveLength(1);
    expect(plan.needed).toEqual([]);
  });

  it('spot checks re-run only COVERED shards (needed shards run anyway)', () => {
    const plan = planShardRuns({
      targets,
      verdicts: [v('a::unit', H('1'), 'pass', true)],
      spotCheckShardIds: ['a::unit', 'b::unit'], // b is needed → not a spot check
    });
    expect(plan.spotChecks.map((x) => x.shardId)).toEqual(['a::unit']);
    expect(plan.needed.map((x) => x.shardId)).toEqual(['b::unit', 'c::integration']);
  });

  it('duplicate targets collapse; output is deterministic (sorted)', () => {
    const plan = planShardRuns({
      targets: [t('b::unit', H('2')), t('a::unit', H('1')), t('a::unit', H('1'))],
      verdicts: [],
    });
    expect(plan.needed.map((x) => x.shardId)).toEqual(['a::unit', 'b::unit']);
  });
});

describe('capability matching', () => {
  it('unit needs node; integration needs node+docker+pg', () => {
    expect(shardRequiredTags({ layer: 'unit' })).toEqual(['node']);
    expect(shardRequiredTags({ layer: 'integration' })).toEqual(['node', 'docker', 'pg']);
    expect(machineCanRunShard(['node'], { layer: 'unit' })).toBe(true);
    expect(machineCanRunShard(['node'], { layer: 'integration' })).toBe(false);
    expect(machineCanRunShard(DEFAULT_MACHINE_TAGS, { layer: 'integration' })).toBe(true);
  });

  it('eligibleShards filters by the machine tag set', () => {
    const targets = [t('a::unit', H('1')), t('c::integration', H('3'), 'integration')];
    expect(eligibleShards(['node'], targets).map((x) => x.shardId)).toEqual(['a::unit']);
    expect(eligibleShards(DEFAULT_MACHINE_TAGS, targets)).toHaveLength(2);
  });
});

describe('shardRunWorkItemSpecs — riding the existing claim machinery', () => {
  it('needed runs map 1:1; spot checks carry redundancy 2; dedupeKey pins (repo, shard, inputs)', () => {
    const plan = planShardRuns({
      targets: [t('a::unit', H('1')), t('b::unit', H('2'))],
      verdicts: [v('a::unit', H('1'), 'pass', true)],
      spotCheckShardIds: ['a::unit'],
    });
    const specs = shardRunWorkItemSpecs(plan, { repoKey: 'repo-42', stagingSha: 'f'.repeat(40) });
    expect(specs).toHaveLength(2); // 1 needed (b) + 1 spot check (a)
    const spot = specs.find((s) => s.run.spotCheck)!;
    const normal = specs.find((s) => !s.run.spotCheck)!;
    expect(spot.redundancy).toBe(2);
    expect(spot.title).toContain('[spot-check]');
    expect(normal.redundancy).toBeUndefined();
    expect(normal.dedupeKey).toBe(shardRunDedupeKey('repo-42', 'b::unit', H('2')));
    // same plan → identical specs (deterministic for the create-time dedup)
    const again = shardRunWorkItemSpecs(plan, { repoKey: 'repo-42', stagingSha: 'f'.repeat(40) });
    expect(JSON.stringify(again)).toBe(JSON.stringify(specs));
  });
});

describe('rankShardsForMachine — rendezvous pull order', () => {
  const targets = Array.from({ length: 8 }, (_, i) => t(`s${i}::unit`, H(String(i))));

  it('deterministic per device; different devices generally disagree on the head', () => {
    const a1 = rankShardsForMachine('device-A', targets);
    const a2 = rankShardsForMachine('device-A', [...targets].reverse());
    expect(a1.map((x) => x.shardId)).toEqual(a2.map((x) => x.shardId));
    const heads = new Set(
      ['device-B', 'device-C', 'device-D', 'device-E'].map(
        (d) => rankShardsForMachine(d, targets)[0].shardId,
      ),
    );
    heads.add(a1[0].shardId);
    expect(heads.size).toBeGreaterThan(1); // pullers spread, not stampede
    // it is a permutation — nothing lost
    expect([...a1].sort((x, y) => x.shardId.localeCompare(y.shardId))).toEqual(
      [...targets].sort((x, y) => x.shardId.localeCompare(y.shardId)),
    );
  });
});
