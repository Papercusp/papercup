/**
 * Fixed production-code adapter for P-505 physical Phase G / P-308.
 *
 * The enclosing two-machine scenario supplies the two physical device keys and
 * both machines later sign the complete evidence manifest. This adapter never
 * has either physical private key, so it deliberately keeps those OUTER
 * attestation bindings separate from the EPHEMERAL protocol keypairs used to
 * exercise handoff, fencing, cursor retry, restart, and Git push recovery.
 * Conflating those identities would manufacture a physical-host signature.
 */
import Corestore from 'corestore';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { decideWorktreeBridgePersistence } from '../../harness/git-sync/worktree-bridge-state';
import { readPotGitMode } from '../../harness/git-sync/hive-git-mode';
import { runGitSync } from '../../harness/git-sync/run-git-sync';
import { openOwnLog } from '../hyperbee/peer-log';
import { deriveIntegratorGrant, deriveMaxGrantedEpoch } from './authority-epoch';
import { publishHandoffToken } from './handoff-token';
import { STAGING_REF } from './integrator';
import {
  acceptStagingAdvanceFF,
  signStagingAdvance,
  type SignedStagingAdvance,
} from './staging-advance';
import {
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  writeNamespaceRef,
  type RunGit,
} from './storage';
import { runWorktreeBridgeTick, type WorktreeBridgeTickOutcome } from './worktree-bridge-tick';

export const PHASE_G_INPUT_SCHEMA = 'hive-git-physical-phase-g-input/v1' as const;
export const PHASE_G_RESULT_SCHEMA = 'hive-git-physical-phase-g-result/v1' as const;
export const PHASE_G_PLAN_ITEM = 'P-308' as const;

const RUN_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIOR_EPOCH = 7;
const SUCCESSOR_EPOCH = 8;
const CURSOR_BEFORE = 41;
const CURSOR_ROW = 42;

type PushAttempt = {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
};

export type PhysicalPhaseGResult = {
  schemaVersion: typeof PHASE_G_RESULT_SCHEMA;
  runId: string;
  planItem: typeof PHASE_G_PLAN_ITEM;
  observedAt: string;
  physicalExecutionBinding: {
    provenance: 'outer-manifest-host-receipts';
    towerDeviceKey: string;
    vmDeviceKey: string;
  };
  protocolIdentities: {
    provenance: 'ephemeral-adapter-keypairs';
    oldAuthority: string;
    survivor: string;
    stableRestartIdentity: string;
  };
  authorityFence: {
    productionSurfaces: ['publishHandoffToken', 'deriveIntegratorGrant', 'signStagingAdvance', 'acceptStagingAdvanceFF'];
    handoff: { epoch: number; seq: number; stagingSha: string; signature: string };
    grant: { ready: boolean; basis: string; epoch: number | null; priorSeq: number | null };
    successorAdvance: SignedStagingAdvance;
    successorAcceptance: { ok: boolean; reason: string | null };
    staleAdvance: SignedStagingAdvance;
    staleAcceptance: { ok: boolean; reason: string | null };
    receiverRefBeforeStaleReplay: string;
    receiverRefAfterStaleReplay: string;
  };
  retryPersistence: {
    productionSurfaces: ['runWorktreeBridgeTick', 'decideWorktreeBridgePersistence', 'deriveMaxGrantedEpoch'];
    rowId: number;
    beforeRetry: number;
    duringUnknownSha: number;
    unknownShaReason: string | null;
    duringUngrantedEpoch: number;
    ungrantedEpochReason: string | null;
    derivedGrantedEpoch: number | null;
    afterAccept: number;
    acceptedCount: number;
    acceptedStagingSha: string | null;
  };
  pgAndPushRecovery: {
    productionSurfaces: ['readPotGitMode', 'runGitSync'];
    modeDuringReadFailure: { mode: string; source: string };
    syncStatus: string;
    pushAttempts: PushAttempt[];
    firstPushRejectedNonFastForward: boolean;
    peerLoserWasNoisy: boolean;
    noForcePush: boolean;
    originContainsLocalCommit: boolean;
    originContainsPeerCommit: boolean;
  };
  restartRoundTrip: {
    productionSurfaces: ['openOwnLog', 'deviceNamespaceKey', 'writeNamespaceRef', 'readNamespaceRef'];
    oldCoreKey: string;
    newCoreKey: string;
    stableDeviceKeyBefore: string;
    stableDeviceKeyAfter: string;
    namespaceBefore: string;
    namespaceAfter: string;
    canonicalOid: string;
    namespaceOid: string;
    worktreeOid: string;
    payloadSha256: string;
    worktreePayloadSha256: string;
  };
  temporaryStateRemoved: true;
};

export type PhysicalPhaseGInput = {
  schemaVersion: typeof PHASE_G_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  result: PhysicalPhaseGResult;
};

export type PhysicalPhaseGVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_G_RESULT_SCHEMA;
    phase: 'G';
    planItem: typeof PHASE_G_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
  };
};

type PhaseGDeps = {
  makeTempDir?: () => Promise<string>;
  removeTempDir?: (path: string) => Promise<void>;
  now?: () => string;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase G runId is invalid: ${runId}`);
}

function validDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY.test(value) && Buffer.from(value, 'base64').length === 32;
}

function assertPhysicalIdentities(towerDeviceKey: string, vmDeviceKey: string): void {
  if (!validDeviceKey(towerDeviceKey) || !validDeviceKey(vmDeviceKey)) {
    throw new Error('physical Phase G requires raw 32-byte Ed25519 device keys in base64');
  }
  if (towerDeviceKey === vmDeviceKey) throw new Error('physical Phase G requires two distinct physical devices');
}

async function git(runGit: RunGit, cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(`physical Phase G git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function configureWorktree(runGit: RunGit, path: string): Promise<void> {
  await git(runGit, path, ['config', 'user.name', 'Papercusp Physical Drill']);
  await git(runGit, path, ['config', 'user.email', 'physical-drill@papercusp.invalid']);
  await git(runGit, path, ['config', 'commit.gpgsign', 'false']);
}

async function writeCommit(
  runGit: RunGit,
  repoPath: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repoPath, relativePath), content, 'utf8');
  await git(runGit, repoPath, ['add', relativePath]);
  await git(runGit, repoPath, ['commit', '-m', message]);
  return git(runGit, repoPath, ['rev-parse', 'HEAD']);
}

function rejectionReason(result: { ok: boolean; reason?: string }): string | null {
  return result.ok ? null : result.reason ?? null;
}

function tickReason(outcome: WorktreeBridgeTickOutcome): string | null {
  const bridge = outcome.results[0]?.bridge;
  return bridge?.outcome === 'rejected' ? bridge.reason : null;
}

function cursorAfter(outcome: WorktreeBridgeTickOutcome, nowMs: number): number {
  return decideWorktreeBridgePersistence({
    prior: null,
    maxRowId: CURSOR_ROW,
    pendingRows: [{ id: CURSOR_ROW, tsMs: nowMs }],
    outcome,
    nowMs,
  }).bridgeState.lastEventId;
}

async function makeProtocolAuthority(input: {
  root: string;
  runId: string;
  nowMs: number;
  runGit: RunGit;
}): Promise<{
  oldAuthority: ReturnType<typeof generateEd25519KeypairDer>;
  survivor: ReturnType<typeof generateEd25519KeypairDer>;
  authorityRepo: string;
  priorStaging: string;
  successorStaging: string;
  handoff: Awaited<ReturnType<typeof publishHandoffToken>>;
  grant: Awaited<ReturnType<typeof deriveIntegratorGrant>>;
  successorAdvance: SignedStagingAdvance;
  staleAdvance: SignedStagingAdvance;
}> {
  const { root, runId, nowMs, runGit } = input;
  const oldAuthority = generateEd25519KeypairDer();
  const survivor = generateEd25519KeypairDer();
  const authorityRepo = join(root, 'authority.git');
  const authorWorktree = join(root, 'authority-worktree');
  await git(runGit, root, ['init', '--bare', authorityRepo]);
  await git(runGit, root, ['clone', authorityRepo, authorWorktree]);
  await configureWorktree(runGit, authorWorktree);
  const priorStaging = await writeCommit(
    runGit,
    authorWorktree,
    'phase-g.txt',
    `${runId}:pre-failure\n`,
    'physical Phase G pre-failure staging',
  );
  await git(runGit, authorWorktree, ['push', 'origin', 'HEAD:main']);
  await writeNamespaceRef(authorityRepo, oldAuthority.pubkeyBase64, STAGING_REF, priorStaging, runGit);
  const handoff = await publishHandoffToken(
    authorityRepo,
    oldAuthority.pubkeyBase64,
    { epoch: PRIOR_EPOCH, seq: 3, stagingSha: priorStaging, nowMs },
    async (bytes) => signWithPrivateKeyDer(oldAuthority.privateKeyDer, bytes),
    { runGit },
  );
  const grant = await deriveIntegratorGrant({
    repoPath: authorityRepo,
    selfDevicePubkeyBase64: survivor.pubkeyBase64,
    memberDevicePubkeysBase64: [oldAuthority.pubkeyBase64, survivor.pubkeyBase64],
    priorIntegrator: { epoch: 1, seq: 0 },
    bridgeWatermark: { epoch: PRIOR_EPOCH, seq: 3 },
    runGit,
  });
  if (!grant.ready) throw new Error(`physical Phase G grant did not become ready: ${grant.detail}`);

  const successorStaging = await writeCommit(
    runGit,
    authorWorktree,
    'phase-g-successor.txt',
    `${runId}:successor\n`,
    'physical Phase G successor staging',
  );
  await git(runGit, authorWorktree, ['push', 'origin', 'HEAD:main']);
  await writeNamespaceRef(authorityRepo, survivor.pubkeyBase64, STAGING_REF, successorStaging, runGit);
  const successorAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: survivor.pubkeyBase64,
      epoch: grant.epoch,
      seq: grant.priorSeq + 1,
      stagingSha: successorStaging,
      nowMs: nowMs + 1,
    },
    async (bytes) => signWithPrivateKeyDer(survivor.privateKeyDer, bytes),
  );
  const staleAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: oldAuthority.pubkeyBase64,
      epoch: PRIOR_EPOCH,
      seq: 4,
      stagingSha: successorStaging,
      nowMs: nowMs + 2,
    },
    async (bytes) => signWithPrivateKeyDer(oldAuthority.privateKeyDer, bytes),
  );
  return {
    oldAuthority,
    survivor,
    authorityRepo,
    priorStaging,
    successorStaging,
    handoff,
    grant,
    successorAdvance,
    staleAdvance,
  };
}

async function exerciseRetryPersistence(input: {
  root: string;
  authorityRepo: string;
  priorStaging: string;
  successorStaging: string;
  successorAdvance: SignedStagingAdvance;
  oldAuthority: string;
  survivor: string;
  nowMs: number;
  runGit: RunGit;
}): Promise<PhysicalPhaseGResult['retryPersistence']> {
  const retryRepo = join(input.root, 'retry.git');
  const retryWorktree = join(input.root, 'retry-worktree');
  await git(input.runGit, input.root, ['init', '--bare', retryRepo]);
  await git(input.runGit, retryRepo, ['fetch', input.authorityRepo, `${input.priorStaging}:refs/heads/main`]);
  await git(input.runGit, retryRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(input.runGit, input.root, ['clone', retryRepo, retryWorktree]);
  await configureWorktree(input.runGit, retryWorktree);

  const prior = {
    epochSeq: { epoch: PRIOR_EPOCH, seq: 3 },
    stagingSha: input.priorStaging,
  };
  const unknown = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: { allowedDevices: [input.oldAuthority, input.survivor], maxGrantedEpoch: SUCCESSOR_EPOCH },
    runGit: input.runGit,
  });
  const duringUnknownSha = cursorAfter(unknown, input.nowMs);

  const survivorRef = `refs/namespaces/${deviceNamespaceKey(input.survivor)}/${STAGING_REF}`;
  await git(input.runGit, retryRepo, ['fetch', input.authorityRepo, `+${survivorRef}:${survivorRef}`]);
  const ungranted = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: { allowedDevices: [input.oldAuthority, input.survivor], maxGrantedEpoch: PRIOR_EPOCH },
    runGit: input.runGit,
  });
  const duringUngrantedEpoch = cursorAfter(ungranted, input.nowMs + 1);

  const handoffRef = `refs/namespaces/${deviceNamespaceKey(input.oldAuthority)}/refs/rad/handoff`;
  await git(input.runGit, retryRepo, ['fetch', input.authorityRepo, `+${handoffRef}:${handoffRef}`]);
  const derivedGrantedEpoch = await deriveMaxGrantedEpoch({
    repoPath: retryRepo,
    memberDevicePubkeysBase64: [input.oldAuthority, input.survivor],
    ownIntegratorEpoch: undefined,
    runGit: input.runGit,
  });
  const accepted = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: {
      allowedDevices: [input.oldAuthority, input.survivor],
      ...(derivedGrantedEpoch === undefined ? {} : { maxGrantedEpoch: derivedGrantedEpoch }),
    },
    runGit: input.runGit,
  });
  const afterAccept = cursorAfter(accepted, input.nowMs + 2);
  return {
    productionSurfaces: ['runWorktreeBridgeTick', 'decideWorktreeBridgePersistence', 'deriveMaxGrantedEpoch'],
    rowId: CURSOR_ROW,
    beforeRetry: CURSOR_BEFORE,
    duringUnknownSha,
    unknownShaReason: tickReason(unknown),
    duringUngrantedEpoch,
    ungrantedEpochReason: tickReason(ungranted),
    derivedGrantedEpoch: derivedGrantedEpoch ?? null,
    afterAccept,
    acceptedCount: accepted.acceptedCount,
    acceptedStagingSha: accepted.watermark.stagingSha,
  };
}

async function exercisePgAndPushRecovery(input: {
  root: string;
  runId: string;
  runGit: RunGit;
}): Promise<PhysicalPhaseGResult['pgAndPushRecovery']> {
  const modeDuringReadFailure = await readPotGitMode(
    'phase-g-workspace',
    'phase-g-hive',
    (() => {
      throw new Error('physical Phase G injected settings read failure');
    }) as unknown as Parameters<typeof readPotGitMode>[2],
  );

  const origin = join(input.root, 'push-origin.git');
  const seed = join(input.root, 'push-seed');
  const local = join(input.root, 'push-local');
  const peer = join(input.root, 'push-peer');
  await git(input.runGit, input.root, ['init', '--bare', origin]);
  await git(input.runGit, input.root, ['clone', origin, seed]);
  await configureWorktree(input.runGit, seed);
  await writeCommit(input.runGit, seed, 'base.txt', `${input.runId}:base\n`, 'physical Phase G push base');
  await git(input.runGit, seed, ['push', 'origin', 'HEAD:main']);
  await git(input.runGit, origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(input.runGit, input.root, ['clone', origin, local]);
  await git(input.runGit, input.root, ['clone', origin, peer]);
  await configureWorktree(input.runGit, local);
  await configureWorktree(input.runGit, peer);
  await writeFile(join(local, 'local.txt'), `${input.runId}:local\n`, 'utf8');

  let injectedPeerAdvance = false;
  const pushAttempts: PushAttempt[] = [];
  const wrappedRunGit: RunGit = async (args, cwd) => {
    const isLocalPush = cwd === local && args.includes('push');
    if (isLocalPush && !injectedPeerAdvance) {
      injectedPeerAdvance = true;
      await writeCommit(input.runGit, peer, 'peer.txt', `${input.runId}:peer\n`, 'physical Phase G peer race');
      await git(input.runGit, peer, ['push', 'origin', 'HEAD:main']);
    }
    const result = await input.runGit(args, cwd);
    if (isLocalPush) pushAttempts.push({ args: [...args], ...result });
    return result;
  };
  const sync = await runGitSync('physical-phase-g', {
    repoPath: local,
    runGit: wrappedRunGit,
    submodulePaths: [],
    contentDetectors: [],
    deletionGuard: false,
    diffSubjects: false,
    config: { branch: 'main', push: true, pushSubmodules: false },
  });
  const remoteLocal = await input.runGit(['--git-dir', origin, 'show', 'main:local.txt'], input.root);
  const remotePeer = await input.runGit(['--git-dir', origin, 'show', 'main:peer.txt'], input.root);
  const first = pushAttempts[0];
  const firstText = `${first?.stdout ?? ''}\n${first?.stderr ?? ''}`;
  return {
    productionSurfaces: ['readPotGitMode', 'runGitSync'],
    modeDuringReadFailure,
    syncStatus: sync.status,
    pushAttempts,
    firstPushRejectedNonFastForward: first?.code !== 0 && /non-fast-forward|\[rejected\]/i.test(firstText),
    peerLoserWasNoisy: first?.code !== 0 && firstText.trim().length > 0,
    noForcePush: pushAttempts.every((attempt) => !attempt.args.some((arg) => /force/.test(arg))),
    originContainsLocalCommit: remoteLocal.code === 0 && remoteLocal.stdout === `${input.runId}:local\n`,
    originContainsPeerCommit: remotePeer.code === 0 && remotePeer.stdout === `${input.runId}:peer\n`,
  };
}

async function exerciseRestartRoundTrip(input: {
  root: string;
  runId: string;
  runGit: RunGit;
}): Promise<{
  record: PhysicalPhaseGResult['restartRoundTrip'];
  stableDeviceKey: string;
}> {
  const stable = generateEd25519KeypairDer();
  const storeBefore = new Corestore(join(input.root, 'corestore-before'));
  await storeBefore.ready();
  const oldCoreKey = (await openOwnLog(storeBefore)).keyHex;
  await storeBefore.close();
  const storeAfter = new Corestore(join(input.root, 'corestore-after'));
  await storeAfter.ready();
  const newCoreKey = (await openOwnLog(storeAfter)).keyHex;
  await storeAfter.close();

  const canonicalRepo = join(input.root, 'restart-canonical.git');
  const author = join(input.root, 'restart-author');
  const checkout = join(input.root, 'restart-checkout');
  await git(input.runGit, input.root, ['init', '--bare', canonicalRepo]);
  await git(input.runGit, input.root, ['clone', canonicalRepo, author]);
  await configureWorktree(input.runGit, author);
  const payload = `${input.runId}:restart-roundtrip\n`;
  const canonicalOid = await writeCommit(
    input.runGit,
    author,
    'restart.txt',
    payload,
    'physical Phase G restart roundtrip',
  );
  await git(input.runGit, author, ['push', 'origin', 'HEAD:main']);
  await git(input.runGit, canonicalRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeNamespaceRef(canonicalRepo, stable.pubkeyBase64, STAGING_REF, canonicalOid, input.runGit);
  const namespaceOid = await readNamespaceRef(canonicalRepo, stable.pubkeyBase64, STAGING_REF, input.runGit);
  await git(input.runGit, input.root, ['clone', '--branch', 'main', canonicalRepo, checkout]);
  const worktreeOid = await git(input.runGit, checkout, ['rev-parse', 'HEAD']);
  const worktreePayload = await readFile(join(checkout, 'restart.txt'));
  return {
    stableDeviceKey: stable.pubkeyBase64,
    record: {
      productionSurfaces: ['openOwnLog', 'deviceNamespaceKey', 'writeNamespaceRef', 'readNamespaceRef'],
      oldCoreKey,
      newCoreKey,
      stableDeviceKeyBefore: stable.pubkeyBase64,
      stableDeviceKeyAfter: stable.pubkeyBase64,
      namespaceBefore: deviceNamespaceKey(stable.pubkeyBase64),
      namespaceAfter: deviceNamespaceKey(stable.pubkeyBase64),
      canonicalOid,
      namespaceOid: namespaceOid ?? '',
      worktreeOid,
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      worktreePayloadSha256: createHash('sha256').update(worktreePayload).digest('hex'),
    },
  };
}

export async function executePhysicalPhaseG(
  input: { runId: string; towerDeviceKey: string; vmDeviceKey: string },
  deps: PhaseGDeps = {},
): Promise<PhysicalPhaseGResult> {
  assertRunId(input.runId);
  assertPhysicalIdentities(input.towerDeviceKey, input.vmDeviceKey);
  const runGit = defaultRunGit;
  const observedAt = (deps.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs)) throw new Error('physical Phase G now() must return ISO-8601');
  const root = await (deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'papercusp-phase-g-'))))();
  const removeTempDir = deps.removeTempDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  let assembled: Omit<PhysicalPhaseGResult, 'temporaryStateRemoved'>;
  try {
    const authority = await makeProtocolAuthority({ root, runId: input.runId, nowMs, runGit });
    const successorAcceptance = await acceptStagingAdvanceFF(
      authority.authorityRepo,
      authority.successorAdvance,
      { epoch: PRIOR_EPOCH, seq: 3 },
      authority.priorStaging,
      {
        allowedDevices: [authority.oldAuthority.pubkeyBase64, authority.survivor.pubkeyBase64],
        maxGrantedEpoch: SUCCESSOR_EPOCH,
        runGit,
      },
    );
    const receiverRefBeforeStaleReplay = authority.successorStaging;
    const staleAcceptance = await acceptStagingAdvanceFF(
      authority.authorityRepo,
      authority.staleAdvance,
      { epoch: SUCCESSOR_EPOCH, seq: 1 },
      authority.successorStaging,
      {
        allowedDevices: [authority.oldAuthority.pubkeyBase64, authority.survivor.pubkeyBase64],
        maxGrantedEpoch: SUCCESSOR_EPOCH,
        runGit,
      },
    );
    const receiverRefAfterStaleReplay = await readNamespaceRef(
      authority.authorityRepo,
      authority.survivor.pubkeyBase64,
      STAGING_REF,
      runGit,
    );
    if (!receiverRefAfterStaleReplay) throw new Error('physical Phase G successor staging ref disappeared');

    const retryPersistence = await exerciseRetryPersistence({
      root,
      authorityRepo: authority.authorityRepo,
      priorStaging: authority.priorStaging,
      successorStaging: authority.successorStaging,
      successorAdvance: authority.successorAdvance,
      oldAuthority: authority.oldAuthority.pubkeyBase64,
      survivor: authority.survivor.pubkeyBase64,
      nowMs,
      runGit,
    });
    const pgAndPushRecovery = await exercisePgAndPushRecovery({ root, runId: input.runId, runGit });
    const restart = await exerciseRestartRoundTrip({ root, runId: input.runId, runGit });
    assembled = {
      schemaVersion: PHASE_G_RESULT_SCHEMA,
      runId: input.runId,
      planItem: PHASE_G_PLAN_ITEM,
      observedAt,
      physicalExecutionBinding: {
        provenance: 'outer-manifest-host-receipts',
        towerDeviceKey: input.towerDeviceKey,
        vmDeviceKey: input.vmDeviceKey,
      },
      protocolIdentities: {
        provenance: 'ephemeral-adapter-keypairs',
        oldAuthority: authority.oldAuthority.pubkeyBase64,
        survivor: authority.survivor.pubkeyBase64,
        stableRestartIdentity: restart.stableDeviceKey,
      },
      authorityFence: {
        productionSurfaces: ['publishHandoffToken', 'deriveIntegratorGrant', 'signStagingAdvance', 'acceptStagingAdvanceFF'],
        handoff: {
          epoch: authority.handoff.epoch,
          seq: authority.handoff.seq,
          stagingSha: authority.handoff.staging_sha,
          signature: authority.handoff.sig,
        },
        grant: {
          ready: authority.grant.ready,
          basis: authority.grant.basis,
          epoch: authority.grant.ready ? authority.grant.epoch : null,
          priorSeq: authority.grant.ready ? authority.grant.priorSeq : null,
        },
        successorAdvance: authority.successorAdvance,
        successorAcceptance: {
          ok: successorAcceptance.ok,
          reason: rejectionReason(successorAcceptance),
        },
        staleAdvance: authority.staleAdvance,
        staleAcceptance: { ok: staleAcceptance.ok, reason: rejectionReason(staleAcceptance) },
        receiverRefBeforeStaleReplay,
        receiverRefAfterStaleReplay,
      },
      retryPersistence,
      pgAndPushRecovery,
      restartRoundTrip: restart.record,
    };
  } finally {
    await removeTempDir(root);
  }
  return { ...assembled, temporaryStateRemoved: true };
}

function pushError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

export function validatePhysicalPhaseG(input: PhysicalPhaseGInput): PhysicalPhaseGVerdict {
  const errors: string[] = [];
  const result = input?.result;
  pushError(errors, input?.schemaVersion === PHASE_G_INPUT_SCHEMA, `Phase G schemaVersion must be ${PHASE_G_INPUT_SCHEMA}`);
  pushError(errors, RUN_ID.test(input?.runId ?? ''), 'Phase G runId is invalid');
  pushError(errors, result?.schemaVersion === PHASE_G_RESULT_SCHEMA, `Phase G result schemaVersion must be ${PHASE_G_RESULT_SCHEMA}`);
  pushError(errors, result?.runId === input?.runId, 'Phase G result runId must match the enclosing run');
  pushError(errors, result?.planItem === PHASE_G_PLAN_ITEM, 'Phase G planItem must be P-308');
  pushError(errors, validDeviceKey(input?.identities?.towerDeviceKey), 'Phase G tower physical device key is invalid');
  pushError(errors, validDeviceKey(input?.identities?.vmDeviceKey), 'Phase G vm physical device key is invalid');
  pushError(errors, input?.identities?.towerDeviceKey !== input?.identities?.vmDeviceKey, 'Phase G requires two distinct physical devices');

  const startedAt = Date.parse(input?.window?.startedAt ?? '');
  const finishedAt = Date.parse(input?.window?.finishedAt ?? '');
  const observedAt = Date.parse(result?.observedAt ?? '');
  pushError(errors, Number.isFinite(startedAt) && Number.isFinite(finishedAt) && startedAt <= finishedAt, 'Phase G window is invalid');
  pushError(errors, Number.isFinite(observedAt) && observedAt >= startedAt && observedAt <= finishedAt, 'Phase G observation must fall inside the same-run window');

  const physical = result?.physicalExecutionBinding;
  pushError(errors, physical?.provenance === 'outer-manifest-host-receipts', 'Phase G physical binding must name outer manifest host receipts');
  pushError(errors, physical?.towerDeviceKey === input?.identities?.towerDeviceKey, 'Phase G tower physical binding must match the attesting device');
  pushError(errors, physical?.vmDeviceKey === input?.identities?.vmDeviceKey, 'Phase G vm physical binding must match the attesting device');
  const protocol = result?.protocolIdentities;
  pushError(errors, protocol?.provenance === 'ephemeral-adapter-keypairs', 'Phase G protocol identities must be explicitly ephemeral');
  const protocolKeys = [protocol?.oldAuthority, protocol?.survivor, protocol?.stableRestartIdentity];
  pushError(errors, protocolKeys.every(validDeviceKey), 'Phase G protocol identities must be valid Ed25519 public keys');
  pushError(errors, new Set(protocolKeys).size === 3, 'Phase G protocol identities must be distinct');
  const physicalKeys = new Set([input?.identities?.towerDeviceKey, input?.identities?.vmDeviceKey]);
  pushError(errors, protocolKeys.every((key) => !physicalKeys.has(key)), 'Phase G ephemeral protocol signers must not be represented as physical hosts');

  const authority = result?.authorityFence;
  pushError(errors, authority?.handoff?.epoch === PRIOR_EPOCH && authority?.handoff?.seq === 3, 'Phase G handoff must carry the prior accepted epoch and sequence');
  pushError(errors, authority?.grant?.ready === true && authority?.grant?.basis === 'token-adoption', 'Phase G successor grant must be a ready token adoption');
  pushError(errors, authority?.grant?.epoch === SUCCESSOR_EPOCH && authority?.grant?.priorSeq === 0, 'Phase G successor grant must advance to epoch 8 at a fresh sequence');
  pushError(errors, authority?.successorAdvance?.device_pubkey === protocol?.survivor, 'Phase G successor advance must be signed by the ephemeral survivor');
  pushError(errors, authority?.successorAcceptance?.ok === true, 'Phase G successor advance must pass real FF acceptance');
  pushError(errors, authority?.staleAdvance?.device_pubkey === protocol?.oldAuthority, 'Phase G stale advance must be signed by the ephemeral old authority');
  pushError(errors, authority?.staleAcceptance?.ok === false && authority?.staleAcceptance?.reason === 'stale-epoch-seq', 'Phase G stale authority must be rejected by the epoch fence');
  pushError(errors, authority?.receiverRefBeforeStaleReplay === authority?.receiverRefAfterStaleReplay, 'Phase G stale authority replay must not move the receiver ref');
  pushError(errors, OID.test(authority?.receiverRefAfterStaleReplay ?? ''), 'Phase G receiver staging ref must be a Git OID');

  const retry = result?.retryPersistence;
  pushError(errors, retry?.rowId === CURSOR_ROW && retry?.beforeRetry === CURSOR_BEFORE, 'Phase G retry row and starting cursor are invalid');
  pushError(errors, retry?.unknownShaReason === 'unknown-sha' && retry?.duringUnknownSha === CURSOR_BEFORE, 'Phase G retryable unknown-sha must hold the fed-event cursor');
  pushError(errors, retry?.ungrantedEpochReason === 'ungranted-epoch' && retry?.duringUngrantedEpoch === CURSOR_BEFORE, 'Phase G retryable ungranted-epoch must hold the fed-event cursor');
  pushError(errors, retry?.derivedGrantedEpoch === SUCCESSOR_EPOCH, 'Phase G receiver must derive the successor epoch from the replicated handoff token');
  pushError(errors, retry?.afterAccept === CURSOR_ROW && retry?.acceptedCount === 1, 'Phase G cursor must advance exactly after acceptance');
  pushError(errors, retry?.acceptedStagingSha === authority?.successorAdvance?.staging_sha, 'Phase G accepted retry must persist the successor staging SHA');

  const pg = result?.pgAndPushRecovery;
  pushError(errors, pg?.modeDuringReadFailure?.mode === 'legacy' && pg?.modeDuringReadFailure?.source === 'error', 'Phase G PG blip must fail open to legacy while preserving source:error');
  pushError(errors, pg?.syncStatus === 'synced', 'Phase G non-FF recovery must finish with a synced git-sync outcome');
  pushError(errors, (pg?.pushAttempts?.length ?? 0) >= 2, 'Phase G non-FF recovery must record the rejected push and retry');
  pushError(errors, pg?.firstPushRejectedNonFastForward === true && pg?.peerLoserWasNoisy === true, 'Phase G first push loser must be a noisy non-fast-forward');
  pushError(errors, pg?.noForcePush === true, 'Phase G non-FF recovery must never use force push');
  pushError(errors, pg?.originContainsLocalCommit === true && pg?.originContainsPeerCommit === true, 'Phase G final origin must contain both sides of the push race');

  const restart = result?.restartRoundTrip;
  pushError(errors, /^[0-9a-f]{64}$/.test(restart?.oldCoreKey ?? '') && /^[0-9a-f]{64}$/.test(restart?.newCoreKey ?? ''), 'Phase G restart core keys must be 64-hex');
  pushError(errors, restart?.oldCoreKey !== restart?.newCoreKey, 'Phase G restart must create a different Hypercore key');
  pushError(errors, restart?.stableDeviceKeyBefore === protocol?.stableRestartIdentity && restart?.stableDeviceKeyAfter === protocol?.stableRestartIdentity, 'Phase G restart must preserve the explicitly ephemeral device identity');
  pushError(errors, restart?.namespaceBefore === restart?.namespaceAfter, 'Phase G restart must preserve the device namespace');
  pushError(errors, restart?.canonicalOid === restart?.namespaceOid && restart?.canonicalOid === restart?.worktreeOid, 'Phase G restart Git roundtrip must preserve the exact commit OID');
  pushError(errors, SHA256.test(restart?.payloadSha256 ?? '') && restart?.payloadSha256 === restart?.worktreePayloadSha256, 'Phase G restart Git roundtrip must preserve exact payload bytes');
  pushError(errors, result?.temporaryStateRemoved === true, 'Phase G temporary state must be removed before returning');

  if (errors.length > 0) return { ok: false, errors, result: null };
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: PHASE_G_RESULT_SCHEMA,
      phase: 'G',
      planItem: PHASE_G_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: result.observedAt,
    },
  };
}
