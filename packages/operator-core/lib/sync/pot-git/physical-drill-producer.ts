/** Canonical assembly CLI for the two-machine hive-git physical probe. */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  issuePhysicalDrillHostReceipt,
  resolvePhysicalDrillHostIdentity,
  validatePhysicalDrillHostReceipt,
  type PhysicalDrillHostIdentity,
  type PhysicalDrillHostReceipt,
} from './physical-drill-host-receipt';
import { validatePhysicalDrillEvidence } from './physical-drill-evidence';
import {
  capturePhysicalPhaseARepo,
  quarantineAndObservePhysicalPhaseAAbsence,
  quarantinePhysicalPhaseARepo,
  validatePhysicalPhaseA,
  type PhysicalPhaseAInput,
} from './physical-drill-phase-a';
import {
  capturePhysicalPhaseBRepo,
  createPhysicalPhaseBCommit,
  validatePhysicalPhaseB,
  type PhysicalPhaseBDirection,
  type PhysicalPhaseBHost,
  type PhysicalPhaseBInput,
} from './physical-drill-phase-b';
import {
  executePhysicalPhaseCHost,
  validatePhysicalPhaseC,
  type PhysicalPhaseCHost,
  type PhysicalPhaseCInput,
} from './physical-drill-phase-c';
import {
  PHASE_D_EVENT_WAIT_MAX_MS,
  capturePhysicalPhaseDEvent,
  capturePhysicalPhaseDObservation,
  phaseDObservationLag,
  capturePhysicalPhaseDRequest,
  createPhysicalPhaseDMutation,
  dirtyPhysicalPhaseDWorktree,
  holdPhysicalPhaseDBelowSteer,
  ratifyPhysicalPhaseDRequest,
  resetPhysicalPhaseDDirt,
  restorePhysicalPhaseDTier,
  validatePhysicalPhaseD,
  type PhysicalPhaseDHost,
  type PhysicalPhaseDInput,
  type PhysicalPhaseDMutationKind,
  type PhysicalPhaseDObservationStage,
} from './physical-drill-phase-d';
import {
  capturePhysicalPhaseEObservation,
  createPhysicalPhaseEDivergence,
  createPhysicalPhaseEIngress,
  ensurePhysicalPhaseEMode,
  PHASE_E_MODE_WAIT_MAX_MS,
  preflightPhysicalPhaseERemotes,
  readPhysicalPhaseEMode,
  requirePhysicalPhaseEStageMode,
  restorePhysicalPhaseEDivergence,
  runPhysicalPhaseEWatchdogSweep,
  setPhysicalPhaseEMode,
  validatePhysicalPhaseE,
  type PhysicalPhaseEHost,
  type PhysicalPhaseEInput,
  type PhysicalPhaseEObservationStage,
  type PhysicalPhaseERemoteMutation,
} from './physical-drill-phase-e';
import {
  executePhysicalPhaseFHost,
  validatePhysicalPhaseF,
  type PhysicalPhaseFHost,
  type PhysicalPhaseFInput,
} from './physical-drill-phase-f';
import {
  executePhysicalPhaseG,
  validatePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';
import {
  validatePostGoReleaseCanary,
  type PostGoReleaseCanaryInput,
} from './post-go-release-canary';
import {
  appendCanaryObservation,
  capturePostGoCanaryObservation,
  type PostGoCanaryObservation,
} from './post-go-canary-observations';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Match the CLI entrypoint by physical path, not merely its spelling. macOS
 * exposes `/tmp` through `/private/tmp`; comparing `resolve(argv[1])` with the
 * module URL therefore made a successfully loaded CLI exit 0 without running.
 */
export function samePhysicalDrillPath(
  left: string,
  right: string,
  canonicalize: (path: string) => string = realpathSync,
): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function assertDistinctHosts(identities: PhysicalDrillHostIdentity[]): void {
  if (identities.length !== 2) throw new Error('physical-drill-producer: exactly two host identities required');
  for (const field of ['hostId', 'deviceKey', 'machineFingerprint'] as const) {
    if (new Set(identities.map((identity) => identity[field])).size !== 2) {
      throw new Error(`physical-drill-producer: two physical hosts must have distinct ${field} values`);
    }
  }
}

export function preflightPhysicalDrillHosts(rawIdentities: unknown[]): PhysicalDrillHostIdentity[] {
  const identities = rawIdentities.map((raw, index) => {
    const identity = record(raw);
    if (!identity || identity.schemaVersion !== 'hive-git-physical-host-identity/v1') {
      throw new Error(`physical-drill-producer: host identity ${index} has an invalid schema`);
    }
    return identity as unknown as PhysicalDrillHostIdentity;
  });
  assertDistinctHosts(identities);
  return identities;
}

export function finalizePhysicalDrillArtifacts(input: { evidence: unknown; receipts: unknown[] }): {
  evidence: JsonRecord;
  trust: JsonRecord;
} {
  const evidence = record(input.evidence);
  if (!evidence) throw new Error('physical-drill-producer: unsigned evidence must be an object');
  if (Array.isArray(evidence.attestations) && evidence.attestations.length > 0) {
    throw new Error('physical-drill-producer: scenario output must not contain pre-banked attestations');
  }
  if (input.receipts.length !== 2) {
    throw new Error('physical-drill-producer: exactly two fresh host receipts required');
  }

  const receipts = input.receipts.map((raw, index) => {
    const verdict = validatePhysicalDrillHostReceipt(raw, evidence);
    if (!verdict.ok || !verdict.receipt) {
      throw new Error(`physical-drill-producer: host receipt ${index} rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict.receipt;
  });
  assertDistinctHosts(
    receipts.map((receipt) => ({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId: receipt.hostId,
      deviceKey: receipt.deviceKey,
      keychainId: receipt.keychainId,
      githubUserId: receipt.githubUserId,
      githubLogin: receipt.githubLogin,
      machineFingerprint: receipt.machineFingerprint,
    })),
  );

  const finalizedEvidence: JsonRecord = {
    ...evidence,
    attestations: receipts.map((receipt) => ({
      deviceKey: receipt.deviceKey,
      signature: receipt.evidenceAttestation,
    })),
  };
  const window = record(evidence.window);
  const trust: JsonRecord = {
    schemaVersion: 'hive-git-physical-trust/v1',
    source: 'papercusp-vm-rig/v1',
    runId: evidence.runId,
    observedAt: window?.finishedAt,
    hosts: receipts.map((receipt) => ({
      id: receipt.hostId,
      deviceKey: receipt.deviceKey,
      machineFingerprint: receipt.machineFingerprint,
    })),
    receipts,
  };
  const verdict = validatePhysicalDrillEvidence(finalizedEvidence, trust);
  if (!verdict.ok) {
    throw new Error(`physical-drill-producer: finalized evidence rejected: ${verdict.errors.join('; ')}`);
  }
  return { evidence: finalizedEvidence, trust };
}

function writeOutputsAtomically(
  evidencePath: string,
  trustPath: string,
  artifacts: { evidence: JsonRecord; trust: JsonRecord },
): void {
  for (const path of [evidencePath, trustPath]) {
    if (!path.startsWith('/') || existsSync(path)) {
      throw new Error(`physical-drill-producer: output must be an absent absolute path: ${path}`);
    }
  }
  if (dirname(evidencePath) !== dirname(trustPath)) {
    throw new Error('physical-drill-producer: evidence and trust outputs must share one directory');
  }
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const evidenceTmp = `${evidencePath}${suffix}`;
  const trustTmp = `${trustPath}${suffix}`;
  writeFileSync(evidenceTmp, `${JSON.stringify(artifacts.evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(trustTmp, `${JSON.stringify(artifacts.trust, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(trustTmp, trustPath);
  renameSync(evidenceTmp, evidencePath);
}

async function cli(argv: string[]): Promise<unknown> {
  const [mode, ...args] = argv;
  if (mode === 'identity') {
    const [hostId, cachePath] = args;
    if (!hostId || !cachePath) {
      throw new Error('usage: physical-drill-producer identity <host-id> <absolute-cache-path>');
    }
    return resolvePhysicalDrillHostIdentity({ hostId, cachePath });
  }
  if (mode === 'preflight') {
    const [towerIdentityPath, vmIdentityPath] = args;
    if (!towerIdentityPath || !vmIdentityPath) {
      throw new Error('usage: physical-drill-producer preflight <tower-identity.json> <vm-identity.json>');
    }
    return {
      ok: true,
      hosts: preflightPhysicalDrillHosts([readJson(towerIdentityPath), readJson(vmIdentityPath)]),
    };
  }
  if (mode === 'sign') {
    const [evidencePath, hostId, cachePath] = args;
    if (!evidencePath || !hostId || !cachePath) {
      throw new Error('usage: physical-drill-producer sign <unsigned-evidence.json> <host-id> <absolute-cache-path>');
    }
    return issuePhysicalDrillHostReceipt({ evidencePath, hostId, cachePath });
  }
  if (mode === 'phase-a-observe') {
    const [hostId, state, repoPath, ownDeviceKey, peerDeviceKey, observedAt] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (state !== 'present' && state !== 'absent') ||
      !repoPath ||
      !ownDeviceKey ||
      !peerDeviceKey
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-a-observe <tower|vm> <present|absent> <repo-path> <own-device-key> <peer-device-key> [observed-at]',
      );
    }
    return capturePhysicalPhaseARepo({
      hostId,
      state,
      repoPath,
      ownDeviceKey,
      peerDeviceKey,
      ...(observedAt ? { observedAt } : {}),
    });
  }
  if (mode === 'phase-a-quarantine') {
    const [repoPath, runId] = args;
    if (!repoPath || !runId) {
      throw new Error('usage: physical-drill-producer phase-a-quarantine <canonical-vm-repo-path> <run-id>');
    }
    return quarantinePhysicalPhaseARepo({ repoPath, runId });
  }
  if (mode === 'phase-a-quarantine-observe') {
    const [repoPath, runId, ownDeviceKey, peerDeviceKey] = args;
    if (!repoPath || !runId || !ownDeviceKey || !peerDeviceKey) {
      throw new Error(
        'usage: physical-drill-producer phase-a-quarantine-observe <canonical-vm-repo-path> <run-id> <own-device-key> <peer-device-key>',
      );
    }
    return quarantineAndObservePhysicalPhaseAAbsence({ repoPath, runId, ownDeviceKey, peerDeviceKey });
  }
  if (mode === 'phase-a-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-a-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseA(readJson(inputPath) as PhysicalPhaseAInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase A rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-b-observe') {
    const [hostId, direction, state, repoPath, sourceDeviceKey, runId, observedAt] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (direction !== 'tower-to-vm' && direction !== 'vm-to-tower') ||
      (state !== 'present' && state !== 'absent') ||
      !repoPath ||
      !sourceDeviceKey ||
      !runId
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-b-observe <tower|vm> <tower-to-vm|vm-to-tower> <present|absent> <repo-path> <source-device-key> <run-id> [observed-at]',
      );
    }
    return capturePhysicalPhaseBRepo({
      hostId: hostId as PhysicalPhaseBHost,
      direction: direction as PhysicalPhaseBDirection,
      state,
      repoPath,
      sourceDeviceKey,
      runId,
      ...(observedAt ? { observedAt } : {}),
    });
  }
  if (mode === 'phase-b-commit') {
    const [sourceHost, direction, repoPath, sourceDeviceKey, runId, createdAt] = args;
    if (
      (sourceHost !== 'tower' && sourceHost !== 'vm') ||
      (direction !== 'tower-to-vm' && direction !== 'vm-to-tower') ||
      !repoPath ||
      !sourceDeviceKey ||
      !runId
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-b-commit <tower|vm> <tower-to-vm|vm-to-tower> <repo-path> <source-device-key> <run-id> [created-at]',
      );
    }
    return createPhysicalPhaseBCommit({
      sourceHost: sourceHost as PhysicalPhaseBHost,
      direction: direction as PhysicalPhaseBDirection,
      repoPath,
      sourceDeviceKey,
      runId,
      ...(createdAt ? { createdAt } : {}),
    });
  }
  if (mode === 'phase-b-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-b-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseB(readJson(inputPath) as PhysicalPhaseBInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase B rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-c-run') {
    const [hostId, repoPath, physicalDeviceKey, peerDeviceKey, runId] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !repoPath || !physicalDeviceKey || !peerDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-c-run <tower|vm> <repo-path> <physical-device-key> <peer-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseCHost({
      hostId: hostId as PhysicalPhaseCHost,
      repoPath,
      physicalDeviceKey,
      peerDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-c-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-c-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseC(readJson(inputPath) as PhysicalPhaseCInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase C rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-d-commit') {
    const [hostId, kind, sourceDeviceKey, runId] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (kind !== 'below-steer' && kind !== 'dirty-overlap') ||
      !sourceDeviceKey ||
      !runId
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-commit <tower|vm> <below-steer|dirty-overlap> <source-device-key> <run-id>',
      );
    }
    return createPhysicalPhaseDMutation({
      sourceHost: hostId as PhysicalPhaseDHost,
      kind: kind as PhysicalPhaseDMutationKind,
      sourceDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-d-dirty') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-d-dirty <run-id>');
    return dirtyPhysicalPhaseDWorktree({ runId });
  }
  if (mode === 'phase-d-reset') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-d-reset <run-id>');
    return resetPhysicalPhaseDDirt({ runId });
  }
  if (mode === 'phase-d-tier-hold') {
    const [vmDevicePubkey, runId, holdPath] = args;
    if (!vmDevicePubkey || !runId || !holdPath) {
      throw new Error('usage: physical-drill-producer phase-d-tier-hold <vm-device-pubkey> <run-id> <hold-path>');
    }
    return holdPhysicalPhaseDBelowSteer({ vmDevicePubkey, runId, holdPath });
  }
  if (mode === 'phase-d-tier-restore') {
    const [holdPath] = args;
    if (!holdPath) throw new Error('usage: physical-drill-producer phase-d-tier-restore <hold-path>');
    return restorePhysicalPhaseDTier({ holdPath });
  }
  if (mode === 'phase-d-request') {
    const [state, devicePubkey, headSha] = args;
    if ((state !== 'pending' && state !== 'ratified') || !devicePubkey || !headSha) {
      throw new Error(
        'usage: physical-drill-producer phase-d-request <pending|ratified> <device-pubkey> <head-sha>',
      );
    }
    return capturePhysicalPhaseDRequest({ state, devicePubkey, headSha });
  }
  if (mode === 'phase-d-ratify') {
    const [devicePubkey, headSha] = args;
    if (!devicePubkey || !headSha) {
      throw new Error('usage: physical-drill-producer phase-d-ratify <device-pubkey> <head-sha>');
    }
    return ratifyPhysicalPhaseDRequest({ devicePubkey, headSha });
  }
  if (mode === 'phase-d-event') {
    const [hostId, afterRowIdRaw, integratorDeviceKey, stagingSha, waitSecondsRaw] = args;
    const afterRowId = Number(afterRowIdRaw);
    // Optional bounded wait (WI-10003787): the tower's event can land after git-sync:run returns in_progress.
    const waitSeconds = waitSecondsRaw === undefined ? 0 : Number(waitSecondsRaw);
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !Number.isSafeInteger(afterRowId) ||
      afterRowId < 0 ||
      !integratorDeviceKey ||
      !stagingSha ||
      !Number.isSafeInteger(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds * 1000 > PHASE_D_EVENT_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-event <tower|vm> <after-row-id> <integrator-device-key> <staging-sha> [wait-seconds<=1200]',
      );
    }
    return capturePhysicalPhaseDEvent({
      hostId: hostId as PhysicalPhaseDHost,
      afterRowId,
      integratorDeviceKey,
      stagingSha,
      waitMs: waitSeconds * 1000,
    });
  }
  if (mode === 'phase-d-observe') {
    const [hostId, stage, integratorDeviceKey, runId, expectedSha] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !['first-source', 'first-destination', 'dirty-before', 'dirty-after'].includes(stage ?? '') ||
      !integratorDeviceKey ||
      !runId ||
      (expectedSha !== undefined && !/^[0-9a-f]{40}$/.test(expectedSha))
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-observe <tower|vm> <first-source|first-destination|dirty-before|dirty-after> <integrator-device-key> <run-id> [expected-staging-sha]',
      );
    }
    const observation = await capturePhysicalPhaseDObservation({
      hostId: hostId as PhysicalPhaseDHost,
      stage: stage as PhysicalPhaseDObservationStage,
      integratorDeviceKey,
      runId,
    });
    // With an expected head, a host that has not converged yet exits 3 and still
    // prints the observation, so the scenario can nudge git-sync and retry
    // without losing the evidence (WI-10003811).
    if (expectedSha !== undefined) {
      const lagging = phaseDObservationLag(observation, stage as PhysicalPhaseDObservationStage, expectedSha);
      if (lagging.length > 0) {
        throw new PhysicalDrillIncompleteEvidenceError(
          `physical-drill-producer: ${hostId} ${stage} has not converged to ${expectedSha}: lagging ${lagging.join(', ')}`,
          observation,
        );
      }
    }
    return observation;
  }
  if (mode === 'phase-d-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-d-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseD(readJson(inputPath) as PhysicalPhaseDInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase D rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-e-mode') {
    const [nextMode, runId] = args;
    if ((nextMode !== 'legacy' && nextMode !== 'bridged') || !runId) {
      throw new Error('usage: physical-drill-producer phase-e-mode <legacy|bridged> <run-id>');
    }
    return setPhysicalPhaseEMode({ runId, mode: nextMode });
  }
  if (mode === 'phase-e-preflight') {
    if (args.length !== 0) {
      throw new Error('usage: physical-drill-producer phase-e-preflight');
    }
    return preflightPhysicalPhaseERemotes();
  }
  if (mode === 'phase-e-mode-read') {
    if (args.length !== 0) throw new Error('usage: physical-drill-producer phase-e-mode-read');
    return readPhysicalPhaseEMode();
  }
  if (mode === 'phase-e-mode-ensure') {
    const [nextMode, runId] = args;
    if ((nextMode !== 'legacy' && nextMode !== 'bridged') || !runId || args.length !== 2) {
      throw new Error('usage: physical-drill-producer phase-e-mode-ensure <legacy|bridged> <run-id>');
    }
    return ensurePhysicalPhaseEMode({ runId, mode: nextMode });
  }
  if (mode === 'phase-e-await-mode') {
    const [stage, waitSecRaw] = args;
    const waitSec = Number(waitSecRaw);
    if (
      !['legacy-before', 'bridged-member', 'healthy-egress', 'divergence-before', 'divergence-after', 'legacy-after'].includes(stage ?? '') ||
      args.length !== 2 || !Number.isInteger(waitSec) || waitSec < 0 || waitSec * 1000 > PHASE_E_MODE_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-e-await-mode <legacy-before|bridged-member|healthy-egress|divergence-before|divergence-after|legacy-after> <wait-sec<=1200>',
      );
    }
    return requirePhysicalPhaseEStageMode({ stage: stage as PhysicalPhaseEObservationStage, waitMs: waitSec * 1000 });
  }
  if (mode === 'phase-e-observe') {
    const [hostId, stage, deviceKey, runId, waitSecRaw] = args;
    const waitSec = waitSecRaw === undefined ? 0 : Number(waitSecRaw);
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !['legacy-before', 'bridged-member', 'healthy-egress', 'divergence-before', 'divergence-after', 'legacy-after'].includes(stage ?? '') ||
      !deviceKey || !runId || args.length > 5 ||
      !Number.isInteger(waitSec) || waitSec < 0 || waitSec * 1000 > PHASE_E_MODE_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-e-observe <tower|vm> <legacy-before|bridged-member|healthy-egress|divergence-before|divergence-after|legacy-after> <device-key> <run-id> [mode-wait-sec<=1200]',
      );
    }
    return capturePhysicalPhaseEObservation({
      hostId: hostId as PhysicalPhaseEHost,
      stage: stage as PhysicalPhaseEObservationStage,
      deviceKey,
      runId,
      waitMs: waitSec * 1000,
    });
  }
  if (mode === 'phase-e-ingress') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-e-ingress <run-id>');
    return createPhysicalPhaseEIngress({ runId });
  }
  if (mode === 'phase-e-diverge') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-e-diverge <run-id>');
    return createPhysicalPhaseEDivergence({ runId });
  }
  if (mode === 'phase-e-recover') {
    const [mutationPath] = args;
    if (!mutationPath) throw new Error('usage: physical-drill-producer phase-e-recover <fork-ahead-mutation.json>');
    return restorePhysicalPhaseEDivergence(readJson(mutationPath) as PhysicalPhaseERemoteMutation);
  }
  if (mode === 'phase-e-watchdog') {
    const [ordinalRaw, runId] = args;
    const ordinal = Number(ordinalRaw);
    if ((ordinal !== 1 && ordinal !== 2) || !runId) {
      throw new Error('usage: physical-drill-producer phase-e-watchdog <1|2> <run-id>');
    }
    return runPhysicalPhaseEWatchdogSweep({ runId, ordinal: ordinal as 1 | 2 });
  }
  if (mode === 'phase-e-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-e-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseE(readJson(inputPath) as PhysicalPhaseEInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase E rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-f-run') {
    const [hostId, deviceKey, peerDeviceKey, runId] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !deviceKey || !peerDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-f-run <tower|vm> <device-key> <peer-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseFHost({
      hostId: hostId as PhysicalPhaseFHost,
      deviceKey,
      peerDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-f-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-f-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseF(readJson(inputPath) as PhysicalPhaseFInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase F rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-g-run') {
    const [towerDeviceKey, vmDeviceKey, runId] = args;
    if (!towerDeviceKey || !vmDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-g-run <tower-device-key> <vm-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseG({ runId, towerDeviceKey, vmDeviceKey });
  }
  if (mode === 'phase-g-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-g-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseG(readJson(inputPath) as PhysicalPhaseGInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase G rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'post-go-canary-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer post-go-canary-verify <post-go-canary-input.json>');
    }
    const verdict = validatePostGoReleaseCanary(
      readJson(inputPath) as PostGoReleaseCanaryInput,
    );
    if (!verdict.ok) {
      throw new Error(
        `physical-drill-producer: post-GO release canary rejected: ${verdict.errors.join('; ')}`,
      );
    }
    return verdict;
  }
  if (mode === 'post-go-canary-observe') {
    // One hourly P-501 sample (WI-10002545). The first sample of a soak is its
    // START, refused unless the hive's bridge egress is real (endgame D-044).
    const [hive, samplesPath] = args;
    if (!hive || !samplesPath) {
      throw new Error('usage: physical-drill-producer post-go-canary-observe <canary-hive> <samples.json>');
    }
    const existing = existsSync(samplesPath) ? readJson(samplesPath) : [];
    if (!Array.isArray(existing)) {
      throw new Error(`physical-drill-producer: ${samplesPath} must hold a JSON array of P-501 observations`);
    }
    const sample = await capturePostGoCanaryObservation(hive);
    const samples = appendCanaryObservation(existing as PostGoCanaryObservation[], sample);
    const tmpPath = `${samplesPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(samples, null, 2)}\n`);
    renameSync(tmpPath, samplesPath);
    return { ok: true, hive, samplesPath, count: samples.length, sample };
  }
  if (mode === 'finalize') {
    const [unsignedEvidencePath, towerReceiptPath, vmReceiptPath, evidencePath, trustPath] = args;
    if (!unsignedEvidencePath || !towerReceiptPath || !vmReceiptPath || !evidencePath || !trustPath) {
      throw new Error(
        'usage: physical-drill-producer finalize <unsigned-evidence.json> <tower-receipt.json> <vm-receipt.json> <evidence-out.json> <trust-out.json>',
      );
    }
    const artifacts = finalizePhysicalDrillArtifacts({
      evidence: readJson(unsignedEvidencePath),
      receipts: [readJson(towerReceiptPath), readJson(vmReceiptPath)],
    });
    writeOutputsAtomically(evidencePath, trustPath, artifacts);
    return { ok: true, runId: artifacts.evidence.runId, evidencePath, trustPath };
  }
  throw new Error(
    'physical-drill-producer: mode must be identity, preflight, phase-a-observe, phase-a-quarantine, phase-a-quarantine-observe, phase-a-verify, phase-b-observe, phase-b-commit, phase-b-verify, phase-c-run, phase-c-verify, phase-d-commit, phase-d-dirty, phase-d-reset, phase-d-tier-hold, phase-d-tier-restore, phase-d-request, phase-d-ratify, phase-d-event, phase-d-observe, phase-d-verify, phase-e-preflight, phase-e-mode, phase-e-mode-read, phase-e-mode-ensure, phase-e-await-mode, phase-e-observe, phase-e-ingress, phase-e-diverge, phase-e-recover, phase-e-watchdog, phase-e-verify, phase-f-run, phase-f-verify, phase-g-run, phase-g-verify, post-go-canary-observe, post-go-canary-verify, sign, or finalize',
  );
}

type PhysicalDrillCliStream = { write(chunk: string, callback: (error?: Error | null) => void): boolean };

function writeFlushed(stream: PhysicalDrillCliStream, text: string): Promise<void> {
  return new Promise((resolveWrite) => {
    stream.write(text, () => resolveWrite());
  });
}

/**
 * Run one producer mode, write its result, then END THE PROCESS (WI-10003741).
 *
 * The scenario calls every mode over ssh and waits for the remote process to
 * exit. Modes that take or release a file lock open the @papercusp/locks pg
 * pool, whose idle clients keep the event loop alive, so a CLI that only sets
 * `process.exitCode` never exits. Measured in P-505 run 23: `phase-d-dirty`
 * wrote its receipt at 21:50:03Z and was still running 26 minutes later, which
 * stalled Phase D until the dirt lock's TTL nearly lapsed. The exit waits for
 * the write callback so a piped stdout is flushed before the process ends.
 */
export async function runPhysicalDrillCliToExit(
  argv: string[],
  deps: {
    run: (argv: string[]) => Promise<unknown>;
    stdout: PhysicalDrillCliStream;
    stderr: PhysicalDrillCliStream;
    exit: (code: number) => void;
  },
): Promise<void> {
  let code = 0;
  try {
    const result = await deps.run(argv);
    await writeFlushed(deps.stdout, `${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof PhysicalDrillIncompleteEvidenceError) {
      code = PHYSICAL_DRILL_INCOMPLETE_EXIT;
      await writeFlushed(deps.stdout, `${JSON.stringify(error.evidence)}\n`);
    } else {
      code = 1;
    }
    await writeFlushed(deps.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
  }
  deps.exit(code);
}

/** Exit code for "the evidence is valid but the host has not converged yet; retry". */
export const PHYSICAL_DRILL_INCOMPLETE_EXIT = 3;

/**
 * A mode that measured something real but not yet the state it waits for. The
 * CLI prints `evidence` to stdout and exits {@link PHYSICAL_DRILL_INCOMPLETE_EXIT},
 * so a retry loop keeps the last observation for diagnostics (WI-10003811).
 */
export class PhysicalDrillIncompleteEvidenceError extends Error {
  constructor(
    message: string,
    readonly evidence: unknown,
  ) {
    super(message);
    this.name = 'PhysicalDrillIncompleteEvidenceError';
  }
}

const invokedPath = process.argv[1];
if (invokedPath && samePhysicalDrillPath(invokedPath, fileURLToPath(import.meta.url))) {
  void runPhysicalDrillCliToExit(process.argv.slice(2), {
    run: cli,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
  });
}
