/**
 * aggregator.test.ts — DG-5 (P-048), pure. Pins the lane-brief acceptance:
 * green ONLY at full trusted-pass coverage; one fail / missing shard / unknown
 * coverage ⇒ not green — and the incremental contract: a pass recorded at an
 * OLDER staging sha counts when the shard's inputsHash is unchanged.
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/gate/aggregator.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../identity/ed25519';
import { buildShardManifest, type WorkspaceMeta } from './shards';
import { signGateVerdict, type GateVerdict, type GateVerdictOutcome } from './verdicts';
import { satisfiesCrefsRule } from '../release-promotion';
import { aggregateGate, attestGreen, type GateAggregationInput } from './aggregator';

const REPO = 'repo-1';
const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

function keypair() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

const runnerA = keypair();
const runnerB = keypair();
const outsider = keypair(); // NOT gate-trusted
const greenBot = keypair();
const trusted = new Set([runnerA.pubkeyBase64, runnerB.pubkeyBase64, greenBot.pubkeyBase64]);

/** Two workspaces → three shards (ws-lib::unit, ws-app::unit, ws-app::integration). */
const WORKSPACES: WorkspaceMeta[] = [
  { name: 'ws-lib', dir: 'libs/lib', deps: [], hasUnit: true, hasIntegration: false },
  { name: 'ws-app', dir: 'apps/app', deps: ['ws-lib'], hasUnit: true, hasIntegration: true },
];
const MANIFEST = buildShardManifest(WORKSPACES);
const HASHES: Record<string, string> = Object.fromEntries(
  MANIFEST.shards.map((s) => [s.shardId, createHash('sha256').update(s.shardId).digest('hex')]),
);

async function verdict(
  kp: ReturnType<typeof keypair>,
  shardId: string,
  outcome: GateVerdictOutcome,
  opts: { inputsHash?: string; stagingSha?: string } = {},
): Promise<GateVerdict> {
  return signGateVerdict(
    {
      repoKey: REPO,
      stagingSha: opts.stagingSha ?? SHA_NEW,
      shardId,
      inputsHash: opts.inputsHash ?? HASHES[shardId],
      verdict: outcome,
      durationMs: 1000,
      devicePubkeyBase64: kp.pubkeyBase64,
      nowMs: 1_000,
    },
    kp.sign,
  );
}

function input(verdicts: GateVerdict[], over: Partial<GateAggregationInput> = {}): GateAggregationInput {
  return {
    repoKey: REPO,
    stagingSha: SHA_NEW,
    manifest: MANIFEST,
    inputsHashByShardId: HASHES,
    verdicts,
    isGateTrusted: (d) => trusted.has(d),
    ...over,
  };
}

async function fullPass(): Promise<GateVerdict[]> {
  return Promise.all(MANIFEST.shards.map((s) => verdict(runnerA, s.shardId, 'pass')));
}

describe('aggregateGate (DG-5)', () => {
  it('greens ONLY at full trusted-pass coverage', async () => {
    const agg = aggregateGate(input(await fullPass()));
    expect(agg.reasons).toEqual([]);
    expect(agg.green).toBe(true);
    expect(agg.shards.every((s) => s.status === 'pass')).toBe(true);
  });

  it('one missing shard ⇒ not green', async () => {
    const all = await fullPass();
    const agg = aggregateGate(input(all.slice(1)));
    expect(agg.green).toBe(false);
    expect(agg.missing).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('one trusted fail ⇒ not green; a pass from ANOTHER device at the same hash is a surfaced conflict', async () => {
    const all = await fullPass();
    const failed = await verdict(runnerB, MANIFEST.shards[0].shardId, 'fail');
    const agg = aggregateGate(input([...all, failed]));
    expect(agg.green).toBe(false);
    expect(agg.conflicts).toEqual([MANIFEST.shards[0].shardId]);
    // Fail WITHOUT any pass → plain fail.
    const only = aggregateGate(input([failed, ...all.slice(1)]));
    expect(only.green).toBe(false);
    expect(only.failed).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('an untrusted device pass never counts (membership ≠ gate trust)', async () => {
    const all = await fullPass();
    all[0] = await verdict(outsider, MANIFEST.shards[0].shardId, 'pass');
    const agg = aggregateGate(input(all));
    expect(agg.green).toBe(false);
    expect(agg.missing).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('REUSE: a pass at an OLDER staging sha counts when inputsHash is unchanged; a stale inputsHash never does', async () => {
    const all = await fullPass();
    // Recorded at SHA_OLD, same inputsHash → counts for SHA_NEW.
    all[0] = await verdict(runnerA, MANIFEST.shards[0].shardId, 'pass', { stagingSha: SHA_OLD });
    expect(aggregateGate(input(all)).green).toBe(true);
    // Same shard, DIFFERENT (stale) inputsHash → does not count.
    all[0] = await verdict(runnerA, MANIFEST.shards[0].shardId, 'pass', {
      stagingSha: SHA_OLD,
      inputsHash: 'f'.repeat(64),
    });
    const agg = aggregateGate(input(all));
    expect(agg.green).toBe(false);
    expect(agg.missing).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('a tampered verdict is ignored (signatures re-verified at aggregation)', async () => {
    const all = await fullPass();
    all[0] = { ...all[0], verdict: 'pass', duration_ms: 999_999 }; // breaks the sig
    const agg = aggregateGate(input(all));
    expect(agg.green).toBe(false);
    expect(agg.missing).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('a wrong-repo verdict never counts', async () => {
    const all = await fullPass();
    all[0] = { ...(await verdict(runnerA, MANIFEST.shards[0].shardId, 'pass')), repo_key: 'other-repo' };
    // repo_key is signed — rebuild honestly for the other repo instead.
    const other = await signGateVerdict(
      {
        repoKey: 'other-repo',
        stagingSha: SHA_NEW,
        shardId: MANIFEST.shards[0].shardId,
        inputsHash: HASHES[MANIFEST.shards[0].shardId],
        verdict: 'pass',
        durationMs: 1,
        devicePubkeyBase64: runnerA.pubkeyBase64,
        nowMs: 1,
      },
      runnerA.sign,
    );
    const agg = aggregateGate(input([other, ...(await fullPass()).slice(1)]));
    expect(agg.green).toBe(false);
    expect(agg.missing).toEqual([MANIFEST.shards[0].shardId]);
  });

  it('unknown coverage (unreadableWorkspaces) vetoes green', async () => {
    const manifest = buildShardManifest(WORKSPACES, {
      unreadableWorkspaces: [{ dir: 'libs/sub/pkg', reason: 'behind gitlink' }],
    });
    const agg = aggregateGate(input(await fullPass(), { manifest }));
    expect(agg.green).toBe(false);
    expect(agg.coverageUnknown).toHaveLength(1);
    expect(agg.reasons.join(' ')).toMatch(/coverage unknown/);
  });

  it('an empty manifest never greens (a vacuous gate proves nothing)', () => {
    const agg = aggregateGate(input([], { manifest: buildShardManifest([]) }));
    expect(agg.green).toBe(false);
    expect(agg.reasons.join(' ')).toMatch(/empty manifest/);
  });

  it('a shard with no inputsHash entry vetoes green (defective input)', async () => {
    const hashes = { ...HASHES };
    delete hashes[MANIFEST.shards[0].shardId];
    const agg = aggregateGate(input(await fullPass(), { inputsHashByShardId: hashes }));
    expect(agg.green).toBe(false);
    expect(agg.shards[0].status).toBe('no-inputs-hash');
  });
});

describe('attestGreen → promoteRelease proof chain', () => {
  it('signs the green-bot attestation ONLY when green, and the crefs rule counts it', async () => {
    const green = aggregateGate(input(await fullPass()));
    const att = await attestGreen(green, { devicePubkeyBase64: greenBot.pubkeyBase64, sign: greenBot.sign }, 2_000);
    expect(att).not.toBeNull();
    // WI-1554: attestGreen must thread the aggregation's OWN repoKey into the
    // signed attestation — it was previously dropped at this exact call site.
    expect(att!.repo_key).toBe(REPO);
    // The exact proof promoteRelease verifies (Lane B's satisfiesCrefsRule).
    const rule = { allow: [greenBot.pubkeyBase64], threshold: 1 };
    expect(satisfiesCrefsRule(SHA_NEW, REPO, [att!], rule).ok).toBe(true);
    // Wrong sha never satisfied by this attestation.
    expect(satisfiesCrefsRule(SHA_OLD, REPO, [att!], rule).ok).toBe(false);
    // WI-1554: wrong repo_key never satisfied either, even at the RIGHT sha —
    // the cross-repo replay this fix closes.
    expect(satisfiesCrefsRule(SHA_NEW, 'repo-2-a-different-repo', [att!], rule).ok).toBe(false);

    const red = aggregateGate(input([]));
    expect(await attestGreen(red, { devicePubkeyBase64: greenBot.pubkeyBase64, sign: greenBot.sign }, 2_000)).toBeNull();
  });
});
