/**
 * Strict adapter for the freshly produced result of the real two-machine hive-git drill.
 *
 * This does not simulate a physical run. It only turns the physical runner's
 * raw, hashed artifacts, signed host receipts, and exact causal assertions into a consumable verdict
 * for papercusp-desktop/bin/hive-git-drill.sh. A JSON claim without readable,
 * hash-matching artifacts from both hosts is deliberately insufficient.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEd25519 } from '../../identity/ed25519';
import {
  physicalDrillSigningBytes,
  validatePhysicalDrillHostReceipt,
  type PhysicalDrillHostReceipt,
} from './physical-drill-host-receipt';
import {
  validatePhysicalPhaseD,
  type PhysicalPhaseDInput,
} from './physical-drill-phase-d';
import {
  validatePhysicalPhaseE,
  type PhysicalPhaseEInput,
} from './physical-drill-phase-e';

export { physicalDrillSigningBytes } from './physical-drill-host-receipt';

const SCHEMA = 'hive-git-physical-evidence/v1';
const TRUST_SCHEMA = 'hive-git-physical-trust/v1';
const TRUST_SOURCE = 'papercusp-vm-rig/v1';
const PLAN = 'p2p-git-live-activation-2026-07-09';
const ALL_LEGS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const PRIOR_LEGS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

type JsonRecord = Record<string, unknown>;

export type PhysicalDrillEvidenceVerdict = {
  ok: boolean;
  schemaVersion: typeof SCHEMA;
  runId: string | null;
  errors: string[];
  summary: string;
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function validDeviceKey(value: string | null): value is string {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

function expectRecord(parent: JsonRecord | null, key: string, errors: string[]): JsonRecord | null {
  const value = record(parent?.[key]);
  if (!value) errors.push(`${key} must be an object`);
  return value;
}

function expectTrue(parent: JsonRecord | null, key: string, errors: string[]): void {
  if (parent?.[key] !== true) errors.push(`${key} must be true`);
}

function expectString(
  parent: JsonRecord | null,
  key: string,
  pattern: RegExp,
  errors: string[],
): string | null {
  const value = string(parent?.[key]);
  if (!value || !pattern.test(value)) {
    errors.push(`${key} has an invalid or missing value`);
    return null;
  }
  return value;
}

function expectDeviceKey(parent: JsonRecord | null, key: string, errors: string[]): string | null {
  const value = string(parent?.[key]);
  if (!validDeviceKey(value)) {
    errors.push(`${key} must be a raw 32-byte Ed25519 device key in base64`);
    return null;
  }
  return value;
}

function expectEqual(
  left: string | null,
  right: string | null,
  label: string,
  errors: string[],
): void {
  if (left === null || right === null || left !== right) errors.push(`${label} must match exactly`);
}

function validateArtifacts(
  raw: JsonRecord,
  hostIds: Set<string>,
  errors: string[],
): void {
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  if (artifacts.length < hostIds.size) {
    errors.push('artifacts must include at least one raw witness from each physical host');
  }

  const witnessedHosts = new Set<string>();
  for (const [index, candidate] of artifacts.entries()) {
    const artifact = record(candidate);
    if (!artifact) {
      errors.push(`artifacts[${index}] must be an object`);
      continue;
    }
    const host = string(artifact.host);
    const path = string(artifact.path);
    const expectedHash = string(artifact.sha256);
    if (!host || !hostIds.has(host)) {
      errors.push(`artifacts[${index}].host must name one of the two topology hosts`);
    } else {
      witnessedHosts.add(host);
    }
    if (!path || !isAbsolute(path)) {
      errors.push(`artifacts[${index}].path must be absolute`);
      continue;
    }
    if (!expectedHash || !SHA256.test(expectedHash)) {
      errors.push(`artifacts[${index}].sha256 must be a 64-hex digest`);
      continue;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(`artifacts[${index}].path is not a readable file: ${path}`);
      continue;
    }
    const actualHash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actualHash !== expectedHash.toLowerCase()) {
      errors.push(`artifacts[${index}] sha256 mismatch for ${path}`);
    }
  }
  for (const host of hostIds) {
    if (!witnessedHosts.has(host)) errors.push(`no raw artifact witnesses physical host ${host}`);
  }
}

function validateAttestations(raw: JsonRecord, hostKeys: Set<string>, errors: string[]): void {
  const attestations = Array.isArray(raw.attestations) ? raw.attestations : [];
  if (attestations.length !== hostKeys.size) {
    errors.push('attestations must contain exactly one signature from each physical device');
  }
  const witnessed = new Set<string>();
  const bytes = physicalDrillSigningBytes(raw);
  for (const [index, candidate] of attestations.entries()) {
    const attestation = record(candidate);
    const deviceKey = string(attestation?.deviceKey);
    const signatureBase64 = string(attestation?.signature);
    if (!deviceKey || !hostKeys.has(deviceKey) || witnessed.has(deviceKey)) {
      errors.push(`attestations[${index}].deviceKey is unknown or duplicated`);
      continue;
    }
    witnessed.add(deviceKey);
    const signature = signatureBase64 ? Buffer.from(signatureBase64, 'base64') : Buffer.alloc(0);
    if (signature.length !== 64 || !verifyEd25519(bytes, deviceKey, signature)) {
      errors.push(`attestations[${index}] is not a valid signature over the canonical evidence payload`);
    }
  }
  for (const deviceKey of hostKeys) {
    if (!witnessed.has(deviceKey)) errors.push(`no attestation from physical device ${deviceKey}`);
  }
}

function validateTrustAnchor(
  raw: unknown,
  evidence: JsonRecord,
  runId: string | null,
  startedAt: number,
  finishedAt: number,
  evidenceHostIds: Set<string>,
  evidenceHostKeys: Set<string>,
  errors: string[],
): void {
  const trust = record(raw);
  if (!trust) {
    errors.push('trusted physical-rig anchor is required outside the evidence manifest');
    return;
  }
  if (trust.schemaVersion !== TRUST_SCHEMA) {
    errors.push(`trusted anchor schemaVersion must be ${TRUST_SCHEMA}`);
  }
  if (trust.source !== TRUST_SOURCE) {
    errors.push(`trusted anchor source must be ${TRUST_SOURCE}`);
  }
  if (trust.runId !== runId) errors.push('trusted anchor runId must match evidence runId');
  const observedAt = Date.parse(String(trust.observedAt ?? ''));
  if (!Number.isFinite(observedAt) || observedAt < startedAt || observedAt > finishedAt) {
    errors.push('trusted anchor observedAt must fall inside the physical-run window');
  }

  const hosts = Array.isArray(trust.hosts) ? trust.hosts : [];
  if (hosts.length !== 2) errors.push('trusted anchor must contain exactly two VM-rig hosts');
  const hostIds = new Set<string>();
  const hostKeys = new Set<string>();
  const machineFingerprints = new Set<string>();
  const receipts = Array.isArray(trust.receipts) ? trust.receipts : [];
  if (receipts.length !== 2) {
    errors.push('trusted anchor must contain exactly two keychain-bound host receipts');
  }
  const receiptByHost = new Map<string, PhysicalDrillHostReceipt>();
  const receiptKeys = new Set<string>();
  const receiptFingerprints = new Set<string>();
  const evidenceAttestations = Array.isArray(evidence.attestations) ? evidence.attestations : [];
  for (const [index, candidate] of receipts.entries()) {
    const verdict = validatePhysicalDrillHostReceipt(candidate, evidence);
    if (!verdict.ok || !verdict.receipt) {
      for (const error of verdict.errors) errors.push(`trusted anchor receipts[${index}]: ${error}`);
      continue;
    }
    const receipt = verdict.receipt;
    if (receiptByHost.has(receipt.hostId)) {
      errors.push(`trusted anchor receipts[${index}].hostId is duplicate`);
    } else {
      receiptByHost.set(receipt.hostId, receipt);
    }
    if (receiptKeys.has(receipt.deviceKey)) {
      errors.push(`trusted anchor receipts[${index}].deviceKey is duplicate`);
    }
    receiptKeys.add(receipt.deviceKey);
    if (receiptFingerprints.has(receipt.machineFingerprint)) {
      errors.push(`trusted anchor receipts[${index}].machineFingerprint is duplicate`);
    }
    receiptFingerprints.add(receipt.machineFingerprint);
    const matchingAttestation = evidenceAttestations
      .map(record)
      .some((attestation) =>
        attestation?.deviceKey === receipt.deviceKey &&
        attestation?.signature === receipt.evidenceAttestation
      );
    if (!matchingAttestation) {
      errors.push(`trusted anchor receipts[${index}] has no exact evidence attestation`);
    }
  }
  for (const [index, candidate] of hosts.entries()) {
    const host = record(candidate);
    const id = string(host?.id);
    const deviceKey = string(host?.deviceKey);
    const machineFingerprint = string(host?.machineFingerprint);
    if (!id || !evidenceHostIds.has(id) || hostIds.has(id)) {
      errors.push(`trusted anchor hosts[${index}].id is not an exact evidence host or is duplicate`);
    } else {
      hostIds.add(id);
    }
    if (!validDeviceKey(deviceKey) || !evidenceHostKeys.has(deviceKey) || hostKeys.has(deviceKey)) {
      errors.push(`trusted anchor hosts[${index}].deviceKey is not an exact evidence device or is duplicate`);
    } else {
      hostKeys.add(deviceKey);
    }
    if (!machineFingerprint || !SHA256.test(machineFingerprint) || machineFingerprints.has(machineFingerprint)) {
      errors.push(`trusted anchor hosts[${index}].machineFingerprint must be a unique 64-hex physical-host fingerprint`);
    } else {
      machineFingerprints.add(machineFingerprint.toLowerCase());
    }
    const receipt = id ? receiptByHost.get(id) : undefined;
    if (
      !receipt ||
      receipt.deviceKey !== deviceKey ||
      receipt.machineFingerprint !== machineFingerprint
    ) {
      errors.push(`trusted anchor hosts[${index}] must match its signed host receipt exactly`);
    }
  }
  if (hostIds.size !== evidenceHostIds.size || hostKeys.size !== evidenceHostKeys.size) {
    errors.push('trusted anchor host ids and device keys must match the evidence topology exactly');
  }
  if (
    receiptByHost.size !== evidenceHostIds.size ||
    receiptKeys.size !== evidenceHostKeys.size ||
    receiptFingerprints.size !== evidenceHostIds.size
  ) {
    errors.push('signed host receipts must prove two distinct evidence hosts, devices, and machines');
  }
}

function validateLegVerdicts(
  raw: JsonRecord,
  startedAt: number,
  finishedAt: number,
  errors: string[],
): void {
  const verdicts = Array.isArray(raw.legVerdicts) ? raw.legVerdicts : [];
  if (verdicts.length !== ALL_LEGS.length) {
    errors.push('legVerdicts must contain exactly one same-run verdict for A through G');
  }
  const seen = new Set<string>();
  for (const candidate of verdicts) {
    const verdict = record(candidate);
    const leg = string(verdict?.leg);
    if (!leg || !ALL_LEGS.includes(leg as (typeof ALL_LEGS)[number]) || seen.has(leg)) {
      errors.push('legVerdicts contains a missing, unknown, or duplicate leg');
      continue;
    }
    seen.add(leg);
    if (verdict?.status !== 'pass') errors.push(`legVerdicts.${leg}.status must be pass`);
    if (verdict?.scope !== 'physical') errors.push(`legVerdicts.${leg}.scope must be physical`);
    const observedAt = Date.parse(String(verdict?.observedAt ?? ''));
    if (!Number.isFinite(observedAt)) errors.push(`legVerdicts.${leg}.observedAt must be ISO-8601`);
    else if (observedAt < startedAt || observedAt > finishedAt) {
      errors.push(`legVerdicts.${leg}.observedAt must fall inside the one physical-run window`);
    }
  }
  for (const leg of ALL_LEGS) {
    if (!seen.has(leg)) errors.push(`legVerdicts is missing leg ${leg}`);
  }
}

function validateLegE(
  raw: JsonRecord,
  runId: string | null,
  startedAt: number,
  finishedAt: number,
  hostKeys: Set<string>,
  errors: string[],
): void {
  const leg = expectRecord(raw, 'legE', errors);
  if (!leg) return;

  let verdict: ReturnType<typeof validatePhysicalPhaseE>;
  try {
    verdict = validatePhysicalPhaseE(leg as unknown as PhysicalPhaseEInput);
  } catch (error) {
    errors.push(`legE causal evidence is malformed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const error of verdict.errors) errors.push(`legE: ${error}`);
  if (!verdict.ok || !verdict.result?.complete) {
    errors.push('legE must contain the complete validated P-306 causal evidence object');
  }
  if (leg.runId !== runId) errors.push('legE.runId must match the enclosing physical run');

  const window = record(leg.window);
  const legStartedAt = Date.parse(String(window?.startedAt ?? ''));
  const legFinishedAt = Date.parse(String(window?.finishedAt ?? ''));
  if (
    !Number.isFinite(legStartedAt) ||
    !Number.isFinite(legFinishedAt) ||
    legStartedAt < startedAt ||
    legFinishedAt > finishedAt
  ) {
    errors.push('legE.window must fall inside the enclosing physical-run window');
  }

  const identities = record(leg.identities);
  const legHostKeys = new Set([
    string(identities?.towerDeviceKey),
    string(identities?.vmDeviceKey),
  ].filter((value): value is string => value !== null));
  if (
    legHostKeys.size !== hostKeys.size ||
    [...hostKeys].some((deviceKey) => !legHostKeys.has(deviceKey))
  ) {
    errors.push('legE identities must match the two attesting physical devices exactly');
  }
}

function validateLegD(
  raw: JsonRecord,
  runId: string | null,
  startedAt: number,
  finishedAt: number,
  hostKeys: Set<string>,
  errors: string[],
): void {
  const leg = expectRecord(raw, 'legD', errors);
  if (!leg) return;

  let verdict: ReturnType<typeof validatePhysicalPhaseD>;
  try {
    verdict = validatePhysicalPhaseD(leg as unknown as PhysicalPhaseDInput);
  } catch (error) {
    errors.push(`legD causal evidence is malformed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const error of verdict.errors) errors.push(`legD: ${error}`);
  if (!verdict.ok || !verdict.result?.complete) {
    errors.push('legD must contain the complete validated P-305 causal evidence object');
  }
  if (leg.runId !== runId) errors.push('legD.runId must match the enclosing physical run');

  const window = record(leg.window);
  const legStartedAt = Date.parse(String(window?.startedAt ?? ''));
  const legFinishedAt = Date.parse(String(window?.finishedAt ?? ''));
  if (
    !Number.isFinite(legStartedAt) ||
    !Number.isFinite(legFinishedAt) ||
    legStartedAt < startedAt ||
    legFinishedAt > finishedAt
  ) {
    errors.push('legD.window must fall inside the enclosing physical-run window');
  }

  const identities = record(leg.identities);
  const legHostKeys = new Set([
    string(identities?.towerDeviceKey),
    string(identities?.vmDeviceKey),
  ].filter((value): value is string => value !== null));
  if (
    legHostKeys.size !== hostKeys.size ||
    [...hostKeys].some((deviceKey) => !legHostKeys.has(deviceKey))
  ) {
    errors.push('legD identities must match the two attesting physical devices exactly');
  }
}

function validateLegG(raw: JsonRecord, hostKeys: Set<string>, errors: string[]): void {
  const leg = expectRecord(raw, 'legG', errors);
  if (leg?.planItem !== 'P-308') errors.push('legG.planItem must be P-308');
  if (leg?.status !== 'pass') errors.push('legG.status must be pass');
  const afterLegs = Array.isArray(leg?.afterLegs) ? leg.afterLegs : [];
  if (
    afterLegs.length !== PRIOR_LEGS.length ||
    PRIOR_LEGS.some((expected, index) => afterLegs[index] !== expected)
  ) {
    errors.push('legG.afterLegs must be the ordered same-run live sequence A through F');
  }

  const assertions = expectRecord(leg, 'assertions', errors);
  for (const key of [
    'preFailureConverged',
    'survivorElected',
    'grantReady',
    'successorDescendsFromPreFailure',
    'successorFederatedAndAccepted',
    'oldAuthorityRejectedStaleEpochSeq',
    'oldAuthorityCouldNotMoveRefs',
    'retryableUnknownShaHeldCursor',
    'retryableUngrantedEpochHeldCursor',
    'retryAcceptedAfterEvidence',
    'pgBlipFailedOpenLegacy',
    'pgBlipNoForcePush',
    'pgBlipLoserNoisy',
    'restartCoreKeyChanged',
    'stableDeviceIdentityPreserved',
    'postRestartRoundTripExact',
  ]) {
    expectTrue(assertions, key, errors);
  }

  const epochs = expectRecord(leg, 'epochs', errors);
  const priorEpoch = integer(epochs?.priorAccepted);
  const successorEpoch = integer(epochs?.successorGranted);
  if (priorEpoch === null || priorEpoch < 0) errors.push('legG.epochs.priorAccepted must be >= 0');
  if (successorEpoch === null || priorEpoch === null || successorEpoch <= priorEpoch) {
    errors.push('legG.epochs.successorGranted must be strictly greater than priorAccepted');
  }
  if (epochs?.basis !== 'crash-takeover' && epochs?.basis !== 'token-adoption') {
    errors.push('legG.epochs.basis must be crash-takeover or token-adoption');
  }

  const cursor = expectRecord(leg, 'cursor', errors);
  const beforeRetry = integer(cursor?.beforeRetry);
  const duringUnknownSha = integer(cursor?.duringUnknownSha);
  const duringUngrantedEpoch = integer(cursor?.duringUngrantedEpoch);
  const afterAccept = integer(cursor?.afterAccept);
  if (
    beforeRetry === null ||
    duringUnknownSha !== beforeRetry ||
    duringUngrantedEpoch !== beforeRetry
  ) {
    errors.push('legG retryable unknown-sha/ungranted-epoch must hold the fed-event cursor');
  }
  if (beforeRetry === null || afterAccept === null || afterAccept <= beforeRetry) {
    errors.push('legG cursor must advance after the missing evidence is accepted');
  }

  const devices = expectRecord(leg, 'devices', errors);
  const oldAuthority = expectDeviceKey(devices, 'oldAuthority', errors);
  const survivor = expectDeviceKey(devices, 'survivor', errors);
  const stableBefore = expectDeviceKey(devices, 'stableDeviceKeyBefore', errors);
  const stableAfter = expectDeviceKey(devices, 'stableDeviceKeyAfter', errors);
  const oldCore = expectDeviceKey(devices, 'oldCoreKey', errors);
  const newCore = expectDeviceKey(devices, 'newCoreKey', errors);
  for (const [label, key] of [
    ['oldAuthority', oldAuthority],
    ['survivor', survivor],
    ['stableDeviceKeyBefore', stableBefore],
    ['stableDeviceKeyAfter', stableAfter],
  ] as const) {
    if (key && !hostKeys.has(key)) errors.push(`legG.devices.${label} must belong to a physical host`);
  }
  expectEqual(stableBefore, stableAfter, 'legG stable device identity before/after restart', errors);
  if (oldAuthority !== null && survivor !== null && oldAuthority === survivor) {
    errors.push('legG oldAuthority and survivor must be different devices');
  }
  if (oldCore !== null && newCore !== null && oldCore === newCore) {
    errors.push('legG oldCoreKey and newCoreKey must differ after restart');
  }

  const oids = expectRecord(leg, 'oids', errors);
  const successorStaging = expectString(oids, 'successorStaging', OID, errors);
  const receiverStaging = expectString(oids, 'receiverStaging', OID, errors);
  const staleBefore = expectString(oids, 'beforeStaleAuthorityReplay', OID, errors);
  const staleAfter = expectString(oids, 'afterStaleAuthorityReplay', OID, errors);
  const restartCanonical = expectString(oids, 'postRestartCanonical', OID, errors);
  const restartWorktree = expectString(oids, 'postRestartWorktree', OID, errors);
  expectString(oids, 'preFailureStaging', OID, errors);
  expectEqual(successorStaging, receiverStaging, 'legG successor/receiver staging', errors);
  expectEqual(staleBefore, staleAfter, 'legG refs before/after stale-authority replay', errors);
  expectEqual(restartCanonical, restartWorktree, 'legG post-restart canonical/worktree', errors);
}

export function validatePhysicalDrillEvidence(
  raw: unknown,
  trustedAnchor?: unknown,
): PhysicalDrillEvidenceVerdict {
  const errors: string[] = [];
  const evidence = record(raw);
  if (!evidence) {
    return {
      ok: false,
      schemaVersion: SCHEMA,
      runId: null,
      errors: ['evidence root must be an object'],
      summary: 'invalid physical hive-git evidence',
    };
  }

  if (evidence.schemaVersion !== SCHEMA) errors.push(`schemaVersion must be ${SCHEMA}`);
  if (evidence.plan !== PLAN) errors.push(`plan must be ${PLAN}`);
  const runId = string(evidence.runId);
  if (!runId || !/^[A-Za-z0-9._:-]{8,160}$/.test(runId)) errors.push('runId is invalid or missing');

  const window = expectRecord(evidence, 'window', errors);
  const startedAt = Date.parse(String(window?.startedAt ?? ''));
  const finishedAt = Date.parse(String(window?.finishedAt ?? ''));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt <= startedAt) {
    errors.push('window must contain ordered ISO-8601 startedAt/finishedAt timestamps');
  }

  const topology = expectRecord(evidence, 'topology', errors);
  if (topology?.kind !== 'two-physical-machines') {
    errors.push('topology.kind must be two-physical-machines');
  }
  const hosts = Array.isArray(topology?.hosts) ? topology.hosts : [];
  if (hosts.length !== 2) errors.push('topology.hosts must contain exactly two physical hosts');
  const hostIds = new Set<string>();
  const hostKeys = new Set<string>();
  for (const [index, candidate] of hosts.entries()) {
    const host = record(candidate);
    const id = string(host?.id);
    const deviceKey = string(host?.deviceKey);
    if (!id || !/^[A-Za-z0-9._:-]{1,80}$/.test(id) || hostIds.has(id)) {
      errors.push(`topology.hosts[${index}].id is invalid or duplicate`);
    } else {
      hostIds.add(id);
    }
    if (!validDeviceKey(deviceKey) || hostKeys.has(deviceKey)) {
      errors.push(`topology.hosts[${index}].deviceKey is invalid or duplicate`);
    } else {
      hostKeys.add(deviceKey);
    }
  }

  validateTrustAnchor(
    trustedAnchor,
    evidence,
    runId,
    startedAt,
    finishedAt,
    hostIds,
    hostKeys,
    errors,
  );
  validateArtifacts(evidence, hostIds, errors);
  validateAttestations(evidence, hostKeys, errors);
  validateLegVerdicts(evidence, startedAt, finishedAt, errors);
  validateLegD(evidence, runId, startedAt, finishedAt, hostKeys, errors);
  validateLegE(evidence, runId, startedAt, finishedAt, hostKeys, errors);
  validateLegG(evidence, hostKeys, errors);

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    schemaVersion: SCHEMA,
    runId: runId ?? null,
    errors: uniqueErrors,
    summary:
      uniqueErrors.length === 0
        ? `physical hive-git run ${runId} proves same-run A-G with strict D/P-305, E/P-306, and G/P-308 witnesses`
        : `physical hive-git evidence rejected (${uniqueErrors.length} error${uniqueErrors.length === 1 ? '' : 's'})`,
  };
}

export function validatePhysicalDrillEvidenceFile(
  path: string,
  trustedAnchorPath: string,
): PhysicalDrillEvidenceVerdict {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const trustedAnchor = JSON.parse(readFileSync(trustedAnchorPath, 'utf8')) as unknown;
    return validatePhysicalDrillEvidence(parsed, trustedAnchor);
  } catch (error) {
    return {
      ok: false,
      schemaVersion: SCHEMA,
      runId: null,
      errors: [error instanceof Error ? error.message : String(error)],
      summary: 'physical hive-git evidence could not be read',
    };
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  const trustedAnchorPath = process.argv[3];
  const verdict = path && trustedAnchorPath
    ? validatePhysicalDrillEvidenceFile(path, trustedAnchorPath)
    : {
        ok: false,
        schemaVersion: SCHEMA,
        runId: null,
        errors: [
          'usage: physical-drill-evidence.ts /absolute/path/to/evidence.json /absolute/path/to/trusted-anchor.json',
        ],
        summary: 'physical hive-git evidence or trusted-anchor path missing',
      };
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (!verdict.ok) process.exitCode = 1;
}
