import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  PHASE_H_ATTEMPT_SCHEMA,
  PHASE_H_INPUT_SCHEMA,
  PHASE_H_MIN_OMISSION_MS,
  PHASE_H_OBSERVATION_SCHEMA,
  PHASE_H_PLAN_ITEM,
  assertPhysicalPhaseHStep,
  physicalPhaseHInputDigest,
  readPhaseHNamespaceSigrefs,
  validatePhysicalPhaseH,
  type PhaseHCapabilitySummary,
  type PhaseHNamespaceSigrefs,
  type PhysicalPhaseHInput,
  type PhysicalPhaseHObservation,
  type PhysicalPhaseHStep,
} from './physical-drill-phase-h';
import { GIT_SERVING_LEASE_MS, type GitServingCapability } from './serving-capability';
import { SIGREFS_REF, SIGREFS_SCHEMA_VERSION_CONTEXT, sigrefsSigningBytes, type SigrefsPayload } from './sigrefs';
import { deviceNamespaceKey } from './storage';

const RUN = 'p521-physical-phase-h-0001';
const START_MS = Date.parse('2026-09-29T20:00:00.000Z');
const HIVE_ID = 'hive-pubkey-base64';
const REPO_KEY = 'hello-world-3-pot';
const GEN_1 = `sg2-1-${'a'.repeat(40)}`;
const GEN_2 = `sg2-2-${'b'.repeat(40)}`;
const OWNER_BEFORE = { pid: 69706, healthSha: 'aef4431553c9', launcher: 'rig-sidecar-current/boot-headless-current.sh' };
const OWNER_AFTER = { ...OWNER_BEFORE, pid: 71234 };
const PUBLISHER_PID = 80001;

const vm = generateEd25519KeypairDer();
const tower = generateEd25519KeypairDer();
const oid = (seed: number) => seed.toString(16).padStart(40, '0');

let baseline: PhysicalPhaseHInput;

function capability(runtimeId: string, storeGeneration: string, issuedAtMs: number): GitServingCapability {
  return {
    v: 1,
    workspaceId: 'papercusp-workspace',
    installSlug: REPO_KEY,
    potHomeSlug: REPO_KEY,
    scope: { hive_id: HIVE_ID, repo_key: REPO_KEY },
    runtimeId,
    identity: { devicePubkeyBase64: vm.pubkeyBase64, githubUserId: 42, keychainId: 'papercusp-device' },
    context: { hive_id: HIVE_ID, repo_key: REPO_KEY, store_generation: storeGeneration },
    issuedAtMs,
    expiresAtMs: issuedAtMs + GIT_SERVING_LEASE_MS,
  };
}

function summary(c: GitServingCapability): PhaseHCapabilitySummary {
  return {
    runtimeId: c.runtimeId,
    storeGeneration: c.context.store_generation,
    devicePubkeyBase64: c.identity.devicePubkeyBase64,
    issuedAtMs: c.issuedAtMs,
    expiresAtMs: c.expiresAtMs,
  };
}

function sigrefs(sigrefsOid: string, version: number, storeGeneration: string, commits: Array<{ ref: string; sha: string }>): PhaseHNamespaceSigrefs {
  return { deviceKey: vm.pubkeyBase64, sigrefsOid, version, storeGeneration, signatureValid: true, refs: commits };
}

function buildBaseline(): PhysicalPhaseHInput {
  let clock = START_MS;
  const tick = () => new Date((clock += 1_000)).toISOString();
  const ns = deviceNamespaceKey(vm.pubkeyBase64);
  const c1 = capability('runtime-1', GEN_1, START_MS);
  const c2 = capability('runtime-2', GEN_1, START_MS + 120_000);
  // Store replacement need not reboot the owner, so the runtime may survive it.
  const c3 = capability('runtime-2', GEN_2, START_MS + 240_000);
  const commit = (step: PhysicalPhaseHStep, seed: number) => ({
    ref: `refs/namespaces/${ns}/refs/heads/p521-phase-h-${step}-${RUN}`,
    oid: oid(seed),
    signed: { ref: `refs/heads/p521-phase-h-${step}-${RUN}`, sha: oid(seed) },
  });
  const commits = { pre: commit('pre', 1), omitted: commit('omitted', 2), restarted: commit('restarted', 3), replaced: commit('replaced', 4) };
  const s0 = sigrefs(oid(100), 10, GEN_1, []);
  const s1 = sigrefs(oid(101), 11, GEN_1, [commits.pre.signed]);
  const s2 = sigrefs(oid(102), 12, GEN_1, [commits.pre.signed, commits.omitted.signed, commits.restarted.signed]);
  const s3 = sigrefs(oid(103), 13, GEN_2, [commits.replaced.signed]);

  const observation = (hostId: 'vm' | 'tower', step: PhysicalPhaseHStep, parts: {
    capability?: GitServingCapability | null;
    publisherId?: string;
    ageMs?: number;
    incarnation?: string;
    namespace: PhaseHNamespaceSigrefs;
  }): PhysicalPhaseHObservation => {
    const observedAt = tick();
    const ready = parts.capability ?? null;
    return {
      schemaVersion: PHASE_H_OBSERVATION_SCHEMA,
      hostId,
      step,
      observedAt,
      observerPid: hostId === 'vm' ? 80100 : 80200,
      advertisement: {
        present: hostId === 'vm',
        publisherId: parts.publisherId ?? null,
        sentAtMs: hostId === 'vm' ? Date.parse(observedAt) - (parts.ageMs ?? 1_000) : null,
        ageMs: hostId === 'vm' ? (parts.ageMs ?? 1_000) : null,
      },
      serving: ready
        ? { status: 'ready', retryable: false, reason: null, capability: ready }
        : { status: 'unknown', retryable: true, reason: 'owner advertisement is stale', capability: null },
      storeIncarnation: parts.incarnation ?? null,
      namespaces: [parts.namespace],
    };
  };
  const refused = (c: GitServingCapability) => ({
    outcome: 'refused' as const,
    capability: summary(c),
    code: 'GIT_SERVING_UNAVAILABLE',
    retryable: true,
    message: 'pot-git serving unavailable: unknown (owner advertisement is stale); retry next tick',
  });
  const step = (name: PhysicalPhaseHStep, parts: {
    owner: GitServingCapability | null;
    publisherId: string;
    ageMs?: number;
    incarnation: string;
    guard: PhysicalPhaseHInput['steps']['pre']['attempt']['capturedGuard'];
    before: PhaseHNamespaceSigrefs;
    after: PhaseHNamespaceSigrefs;
    published: boolean;
  }) => {
    const vmObservation = observation('vm', name, {
      capability: parts.owner, publisherId: parts.publisherId, ageMs: parts.ageMs, incarnation: parts.incarnation, namespace: parts.before,
    });
    const startedAt = tick();
    const finishedAt = tick();
    return {
      vm: vmObservation,
      attempt: {
        schemaVersion: PHASE_H_ATTEMPT_SCHEMA,
        hostId: 'vm' as const,
        step: name,
        runId: RUN,
        startedAt,
        finishedAt,
        publisherPid: PUBLISHER_PID,
        resolution: parts.owner
          ? { status: 'ready', retryable: false, reason: null, capability: summary(parts.owner) }
          : { status: 'unknown', retryable: true, reason: 'owner advertisement is stale', capability: null },
        capturedGuard: parts.guard,
        bootAttempts: 0,
        commit: { ref: commits[name].ref, oid: commits[name].oid },
        published: parts.published ? { version: parts.after.version!, sigrefsOid: parts.after.sigrefsOid! } : null,
        sigrefsBefore: parts.before,
        sigrefsAfter: parts.after,
      },
      tower: observation('tower', name, { namespace: parts.after }),
    };
  };

  const steps = {
    pre: step('pre', {
      owner: c1, publisherId: 'publisher-1', incarnation: oid(200),
      guard: { outcome: 'signed', capability: summary(c1), signatureValid: true },
      before: s0, after: s1, published: true,
    }),
    omitted: step('omitted', {
      owner: null, publisherId: 'publisher-1', ageMs: PHASE_H_MIN_OMISSION_MS + 1_000, incarnation: oid(200),
      guard: refused(c1), before: s1, after: s1, published: false,
    }),
    restarted: step('restarted', {
      owner: c2, publisherId: 'publisher-2', incarnation: oid(200),
      guard: refused(c1), before: s1, after: s2, published: true,
    }),
    replaced: step('replaced', {
      owner: c3, publisherId: 'publisher-2', incarnation: oid(201),
      guard: refused(c2), before: s2, after: s3, published: true,
    }),
  };
  return {
    schemaVersion: PHASE_H_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: new Date(START_MS).toISOString(), finishedAt: new Date(clock + 1_000).toISOString() },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    vmOwner: { before: OWNER_BEFORE, after: OWNER_AFTER, frozenMs: PHASE_H_MIN_OMISSION_MS + 5_000 },
    steps,
  };
}

beforeAll(() => {
  baseline = buildBaseline();
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
    input.vmOwner.after = { ...input.vmOwner.after, healthSha: '93f1c72063ab' };
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
