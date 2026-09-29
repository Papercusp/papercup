import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  PHASE_H_PLAN_ITEM,
  assertPhysicalPhaseHStep,
  physicalPhaseHInputDigest,
  readPhaseHNamespaceSigrefs,
  validatePhysicalPhaseH,
  type PhysicalPhaseHInput,
} from './physical-drill-phase-h';
import {
  PHASE_H_FIXTURE_GEN_1 as GEN_1,
  PHASE_H_FIXTURE_GEN_2 as GEN_2,
  PHASE_H_FIXTURE_HIVE_ID as HIVE_ID,
  PHASE_H_FIXTURE_OWNER_AFTER as OWNER_AFTER,
  PHASE_H_FIXTURE_REPO_KEY as REPO_KEY,
  buildPhysicalPhaseHInput,
  phaseHFixtureOid as oid,
  phaseHFixtureSigrefs,
} from './physical-drill-phase-h.fixture';
import { GIT_SERVING_LEASE_MS } from './serving-capability';
import { SIGREFS_REF, SIGREFS_SCHEMA_VERSION_CONTEXT, sigrefsSigningBytes, type SigrefsPayload } from './sigrefs';
import { deviceNamespaceKey } from './storage';

const RUN = 'p521-physical-phase-h-0001';
const START_MS = Date.parse('2026-09-29T20:00:00.000Z');

const vm = generateEd25519KeypairDer();
const tower = generateEd25519KeypairDer();
const sigrefs = (sigrefsOid: string, version: number, storeGeneration: string, refs: Array<{ ref: string; sha: string }>) =>
  phaseHFixtureSigrefs(vm.pubkeyBase64, sigrefsOid, version, storeGeneration, refs);

let baseline: PhysicalPhaseHInput;

beforeAll(() => {
  baseline = buildPhysicalPhaseHInput({ runId: RUN, towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64, startMs: START_MS });
});

function validInput(): PhysicalPhaseHInput {
  return structuredClone(baseline);
}

function expectRejected(input: PhysicalPhaseHInput, fragment: string) {
  const verdict = validatePhysicalPhaseH(input);
  expect(verdict.ok).toBe(false);
  expect(verdict.result).toBeNull();
  expect(verdict.errors.some((e) => e.includes(fragment))).toBe(true);
}

describe('physical Phase H serving-identity validator', () => {
  it('accepts a complete four-step run and records each step identity', () => {
    const verdict = validatePhysicalPhaseH(validInput());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: { phase: 'H', planItem: PHASE_H_PLAN_ITEM, status: 'complete', complete: true, missingAssertions: [] },
    });
    expect(Object.values(verdict.result!.assertions).every((v) => v === true)).toBe(true);
    expect(verdict.result!.identities).toEqual({
      pre: { runtimeId: 'runtime-1', storeGeneration: GEN_1, sigrefsOid: oid(101) },
      omitted: { runtimeId: null, storeGeneration: null, sigrefsOid: oid(101) },
      restarted: { runtimeId: 'runtime-2', storeGeneration: GEN_1, sigrefsOid: oid(102) },
      replaced: { runtimeId: 'runtime-2', storeGeneration: GEN_2, sigrefsOid: oid(103) },
    });
  });

  it('rejects a stale captured capability that still signs after the owner was frozen', () => {
    const input = validInput();
    input.steps.omitted.attempt.capturedGuard = {
      outcome: 'signed', capability: input.steps.omitted.attempt.capturedGuard.capability, signatureValid: true,
    };
    expectRejected(input, 'omitted: the stale captured capability still signed');
  });

  it('rejects a refusal that is not the retryable serving-unavailable error', () => {
    const input = validInput();
    const guard = input.steps.restarted.attempt.capturedGuard;
    if (guard.outcome !== 'refused') throw new Error('fixture: restarted guard must refuse');
    guard.code = 'EACCES';
    expectRejected(input, 'restarted: refusal was not the retryable serving-unavailable error');
  });

  it('rejects a publisher that ran inside the serving owner process', () => {
    const input = validInput();
    input.steps.restarted.attempt.publisherPid = OWNER_AFTER.pid;
    expectRejected(input, 'restarted: publisher ran inside the serving owner process');
  });

  it("rejects a publish this process did not sign (the owner's scheduled tick published instead)", () => {
    const input = validInput();
    input.steps.pre.attempt.published = { version: 11, sigrefsOid: oid(999) };
    expectRejected(input, 'pre: sigrefs ref is not the announcement this process published');
  });

  it('rejects a publisher that fell through to its boot seam while the owner was live', () => {
    const input = validInput();
    input.steps.pre.attempt.bootAttempts = 1;
    expectRejected(input, 'pre: publisher fell through to its boot seam');
  });

  it('rejects a tower that does not serve the VM snapshot the attempt produced', () => {
    const input = validInput();
    input.steps.replaced.tower.namespaces[0] = { ...input.steps.replaced.tower.namespaces[0], sigrefsOid: oid(102) };
    expectRejected(input, 'replaced: tower does not serve the VM');
  });

  it('rejects a tower view whose signature does not verify', () => {
    const input = validInput();
    input.steps.pre.tower.namespaces[0] = { ...input.steps.pre.tower.namespaces[0], signatureValid: false };
    expectRejected(input, 'pre: tower does not serve the VM');
  });

  it('rejects sigrefs that moved while serving was unavailable', () => {
    const input = validInput();
    // A move that propagated: the tower serves it too, so only the omission check can catch it.
    const moved = sigrefs(oid(150), 12, GEN_1, []);
    input.steps.omitted.attempt.sigrefsAfter = moved;
    input.steps.omitted.tower.namespaces[0] = { ...moved };
    expectRejected(input, 'omitted: sigrefs moved while serving was unavailable');
  });

  it('rejects an omission shorter than the capability lease', () => {
    const input = validInput();
    input.vmOwner.frozenMs = GIT_SERVING_LEASE_MS;
    expectRejected(input, 'omitted: owner frozen');
  });

  it('rejects an owner advertisement that was still fresh during the omission', () => {
    const input = validInput();
    input.steps.omitted.vm.advertisement.ageMs = GIT_SERVING_LEASE_MS - 1_000;
    expectRejected(input, 'omitted: owner advertisement was still fresh');
  });

  it('rejects a restart that changed the served artifact', () => {
    const input = validInput();
    input.vmOwner.after = { ...input.vmOwner.after, build: '93f1c72063ab' };
    expectRejected(input, 'restarted: owner was not restarted on the same artifact and launcher');
  });

  it('accepts a release-build owner identified by version on both sides of the restart', () => {
    const input = validInput();
    input.vmOwner.before = { ...input.vmOwner.before, build: 'version:0.0.25' };
    input.vmOwner.after = { ...input.vmOwner.after, build: 'version:0.0.25' };
    expect(validatePhysicalPhaseH(input)).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects a restart whose owner carried no build identity', () => {
    const input = validInput();
    input.vmOwner.before = { ...input.vmOwner.before, build: '' };
    input.vmOwner.after = { ...input.vmOwner.after, build: '' };
    expectRejected(input, 'restarted: owner was not restarted on the same artifact and launcher');
  });

  it('rejects a restart whose advertisement publisher did not change', () => {
    const input = validInput();
    input.steps.restarted.vm.advertisement.publisherId = 'publisher-1';
    expectRejected(input, 'restarted: advertisement publisher did not change');
  });

  it('rejects a store replacement whose generation did not advance', () => {
    const input = validInput();
    const owner = input.steps.replaced.vm.serving.capability!;
    owner.context.store_generation = GEN_1;
    expectRejected(input, 'replaced: store generation did not advance');
  });

  it('rejects a store replacement that kept the physical incarnation', () => {
    const input = validInput();
    input.steps.replaced.vm.storeIncarnation = input.steps.pre.vm.storeIncarnation;
    expectRejected(input, 'replaced: physical store incarnation did not change');
  });

  it('rejects a replacement refusal that tested a capability from the wrong generation', () => {
    const input = validInput();
    const guard = input.steps.replaced.attempt.capturedGuard;
    if (guard.outcome !== 'refused') throw new Error('fixture: replaced guard must refuse');
    guard.capability = { ...guard.capability, storeGeneration: GEN_2 };
    expectRejected(input, 'replaced: refusal tested a capability from the wrong generation');
  });

  it('rejects evidence recorded out of causal order', () => {
    const input = validInput();
    input.steps.restarted.vm.observedAt = input.steps.pre.vm.observedAt;
    expectRejected(input, 'restarted: evidence is out of causal order');
  });

  it('rejects an attempt bound to a different run', () => {
    const input = validInput();
    input.steps.omitted.attempt.runId = 'p521-physical-phase-h-0002';
    expectRejected(input, 'omitted: attempt is not bound to this run');
  });

  it('rejects a signed snapshot that omits the run commit', () => {
    const input = validInput();
    input.steps.replaced.attempt.sigrefsAfter.refs = [];
    expectRejected(input, 'replaced: signed snapshot omits the run commit');
  });

  it('rejects identical tower and VM device keys before reading any step', () => {
    const input = validInput();
    input.identities.towerDeviceKey = input.identities.vmDeviceKey;
    expect(validatePhysicalPhaseH(input)).toEqual({ ok: false, errors: ['tower and VM device keys must be distinct'], result: null });
  });

  it('keeps the input digest stable for identical evidence and sensitive to any change', () => {
    const input = validInput();
    expect(physicalPhaseHInputDigest(input)).toBe(physicalPhaseHInputDigest(validInput()));
    input.vmOwner.frozenMs += 1;
    expect(physicalPhaseHInputDigest(input)).not.toBe(physicalPhaseHInputDigest(validInput()));
  });

  it('rejects an unknown step label', () => {
    expect(() => assertPhysicalPhaseHStep('frozen')).toThrow(/pre\|omitted\|restarted\|replaced/);
  });
});

describe('physical Phase H namespace sigrefs reader', () => {
  let repo: string;
  const ns = deviceNamespaceKey(vm.pubkeyBase64);
  const git = (args: string[], input?: string) => {
    const result = spawnSync('git', ['--git-dir', repo, ...args], { encoding: 'utf8', input });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  beforeAll(() => {
    repo = join(mkdtempSync(join(tmpdir(), 'phase-h-sigrefs-')), 'repo.git');
    spawnSync('git', ['init', '--bare', '--quiet', repo], { encoding: 'utf8' });
    const payload: SigrefsPayload = {
      v: SIGREFS_SCHEMA_VERSION_CONTEXT,
      device_pubkey: vm.pubkeyBase64,
      version: 7,
      ts: START_MS,
      refs: [{ ref: `refs/heads/p521-phase-h-pre-${RUN}`, sha: oid(1) }],
      hive_id: HIVE_ID,
      repo_key: REPO_KEY,
      store_generation: GEN_1,
    };
    const sig = signWithPrivateKeyDer(vm.privateKeyDer, sigrefsSigningBytes(payload)).toString('base64');
    const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify({ ...payload, sig }));
    git(['update-ref', `refs/namespaces/${ns}/${SIGREFS_REF}`, blob]);
    // The same blob under the tower's namespace: a snapshot served for the wrong device.
    git(['update-ref', `refs/namespaces/${deviceNamespaceKey(tower.pubkeyBase64)}/${SIGREFS_REF}`, blob]);
  });

  afterAll(() => {
    rmSync(join(repo, '..'), { recursive: true, force: true });
  });

  it('reads and verifies the device snapshot', () => {
    const read = readPhaseHNamespaceSigrefs(repo, vm.pubkeyBase64);
    expect(read).toMatchObject({
      deviceKey: vm.pubkeyBase64,
      version: 7,
      storeGeneration: GEN_1,
      signatureValid: true,
      refs: [{ ref: `refs/heads/p521-phase-h-pre-${RUN}`, sha: oid(1) }],
    });
    expect(read.sigrefsOid).toBe(git(['rev-parse', `refs/namespaces/${ns}/${SIGREFS_REF}`]));
  });

  it("marks another device's snapshot under a namespace as unverified", () => {
    expect(readPhaseHNamespaceSigrefs(repo, tower.pubkeyBase64).signatureValid).toBe(false);
  });

  it('reports an absent namespace without throwing', () => {
    const absent = generateEd25519KeypairDer();
    expect(readPhaseHNamespaceSigrefs(repo, absent.pubkeyBase64)).toEqual({
      deviceKey: absent.pubkeyBase64, sigrefsOid: null, version: null, storeGeneration: null, signatureValid: false, refs: [],
    });
  });
});
