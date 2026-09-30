import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  PHASE_I_INPUT_SCHEMA,
  attemptPhysicalPhaseI,
  startPhaseIOwner,
  validatePhysicalPhaseI,
  type PhysicalPhaseIInput,
} from './physical-drill-phase-i';

const RUN_ID = 'p505-physical-20260930T010000Z-4242';
const tower = generateEd25519KeypairDer();
const vm = generateEd25519KeypairDer();
const signer = (key: Buffer) => async (bytes: Buffer) => signWithPrivateKeyDer(key, bytes);
const dirs: string[] = [];
let valid: PhysicalPhaseIInput;

/**
 * The whole leg on one machine: two host directories, an in-process owner that
 * is closed (not SIGKILLed) for the outage, and the same production sinks the
 * physical run drives.
 */
async function runLeg(): Promise<PhysicalPhaseIInput> {
  const vmDir = await mkdtemp(join(tmpdir(), 'phase-i-vm-'));
  const towerDir = await mkdtemp(join(tmpdir(), 'phase-i-tower-'));
  dirs.push(vmDir, towerDir);
  const startedAt = new Date().toISOString();
  const first = await startPhaseIOwner({ dir: vmDir, runId: RUN_ID, pid: 900_001 });
  const socket = join(vmDir, 'owner', 'owner.sock');
  const base = { runId: RUN_ID, hiveId: first.record.hiveId };
  const vmHost = { ...base, host: 'vm' as const, dir: vmDir, deviceKey: vm.pubkeyBase64, ownerSocket: socket };
  const towerHost = { ...base, host: 'tower' as const, dir: towerDir, deviceKey: tower.pubkeyBase64 };
  const vmDeps = { signDevice: signer(vm.privateKeyDer) };
  const towerDeps = { signDevice: signer(tower.privateKeyDer) };

  const liveVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'live' }, vmDeps);
  const liveTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'live', vmLive: liveVm }, towerDeps);
  let closed = false;
  const lostVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'lost' }, {
    ...vmDeps,
    killOwner: async () => { await first.close(); closed = true; return true; },
  });
  const outageVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'outage' }, vmDeps);
  const outageTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'outage', vmLive: liveVm, vmOutage: outageVm }, towerDeps);
  const restored = await startPhaseIOwner({ dir: vmDir, runId: RUN_ID, pid: 900_002 });
  const restoredVm = await attemptPhysicalPhaseI({ ...vmHost, step: 'restored' }, vmDeps);
  const restoredTower = await attemptPhysicalPhaseI({ ...towerHost, step: 'restored', vmLive: liveVm }, towerDeps);
  await restored.close();
  return {
    schemaVersion: PHASE_I_INPUT_SCHEMA,
    runId: RUN_ID,
    window: { startedAt, finishedAt: new Date().toISOString() },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    owner: { first: first.record, restored: restored.record, goneAfterLost: closed },
    steps: {
      live: { vm: liveVm, tower: liveTower },
      lost: { vm: lostVm },
      outage: { vm: outageVm, tower: outageTower },
      restored: { vm: restoredVm, tower: restoredTower },
    },
  };
}

beforeAll(async () => { valid = await runLeg(); }, 300_000);
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

const clone = (): PhysicalPhaseIInput => structuredClone(valid);

describe('physical Phase I (P-521 F6 protected effects)', () => {
  it('only the single owning hive authorizes; every other authority is refused with no effect', () => {
    const verdict = validatePhysicalPhaseI(valid);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    // live owner x5 + restored owner x5 + push #1 before the owner died.
    expect(verdict.result?.counts.authorized).toBe(11);
    // live: 5 stale-scope + 20 tower; outage: 5 VM + 15 tower; restored: 15 tower; lost: push #2 + submodule.
    expect(verdict.result?.counts.refused).toBe(62);
  });

  it('the advisory views diverge at one roster epoch', () => {
    const { vm: v, tower: t } = valid.steps.live;
    expect(v.advisory.rosterEpoch).toBe(t.advisory.rosterEpoch);
    expect([v.advisory.isSelf, t.advisory.isSelf]).toEqual([true, true]);
    expect(v.advisory.leaderDevicePubkey).not.toBe(t.advisory.leaderDevicePubkey);
  });

  it('a genuine replayed owner proof is refused on the tower', () => {
    const replay = valid.steps.live.tower.attempts.filter((a) => a.variant === 'replayed-owner-proof');
    expect(replay).toHaveLength(5);
    for (const a of replay) {
      expect(a.ok).toBe(false);
      expect(a.after.protected).toEqual(a.before.protected);
    }
  });

  it('losing the owner between pushes freezes the next push; restoring it permits fresh progress', () => {
    const lost = valid.steps.lost.vm.lost!;
    expect(lost.push1.ok).toBe(true);
    expect(lost.forkPr.reason).toMatch(/open PR authorization failed/);
    expect(lost.push2.ok).toBe(false);
    expect(lost.push2.after.protected.githubMain).toBe(lost.push1.candidate);
    const restoredGithub = valid.steps.restored.vm.attempts.find((a) => a.effect === 'github-push' && a.variant === 'owner')!;
    expect(restoredGithub.ok).toBe(true);
    expect(restoredGithub.after.protected.githubMain).not.toBe(lost.push1.candidate);
  });

  // Falsifiability: each mutation removes exactly one property the leg proves.
  const mutations: Array<[string, (i: PhysicalPhaseIInput) => void, RegExp]> = [
    ['a refused attempt moved a protected ref', (i) => { i.steps.live.tower.attempts[2]!.after.protected.githubMain = 'f'.repeat(40); }, /protected target moved/],
    ['a refusal did not come from the fence', (i) => { i.steps.outage.tower.attempts[0]!.reason = 'not-advanced'; }, /owning-hive fence/],
    ['a denied sink reported success', (i) => { i.steps.lost.vm.lost!.push2.ok = true; }, /sink reported the effect happened/],
    ['restoration replaced the key', (i) => { i.owner.restored.hiveId = tower.pubkeyBase64; }, /SAME hive key/],
    ['the key was minted twice', (i) => { i.owner.restored.mintedKey = true; }, /minted exactly once/],
    ['advisory epochs differ', (i) => { i.steps.live.tower.advisory.rosterEpoch += 1; }, /shared roster epoch/],
    ['an attempt is missing', (i) => { i.steps.outage.vm.attempts.pop(); }, /attempt matrix/],
    ['device-head exchange was refused', (i) => { i.steps.outage.tower.deviceHeadAcceptance = { ok: false, reason: 'bad-signature' }; }, /device head/],
    ['the tower held the owner key', (i) => { i.steps.restored.tower.ownerKeyMaterialOnHost = true; }, /owner key is present on the tower/],
    ['an owner push used force', (i) => { i.steps.live.vm.attempts[2]!.pushArgs.push(['push', '--force', 'x']); }, /used force/],
    ['the owner was never confirmed gone', (i) => { i.owner.goneAfterLost = false; }, /owner process was gone/],
    ['a PR opened after the owner died', (i) => { i.steps.lost.vm.lost!.forkPr.after.protected.pullRequests.push({ number: 99, headRef: 'x' }); }, /PR opened after the owner died/],
    ['no fresh progress after restore', (i) => {
      const live = i.steps.live.vm.attempts.find((a) => a.variant === 'owner' && a.effect === 'release-promotion')!;
      i.steps.restored.vm.attempts.find((a) => a.effect === 'release-promotion')!.candidate = live.candidate;
    }, /release-promotion/],
    ['the attempt ran inside the owner', (i) => { i.steps.outage.tower.attemptPid = i.owner.first.pid; }, /inside the owner process/],
  ];
  it.each(mutations)('rejects evidence where %s', (_label, mutate, message) => {
    const input = clone();
    mutate(input);
    const verdict = validatePhysicalPhaseI(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(message);
  });
});
