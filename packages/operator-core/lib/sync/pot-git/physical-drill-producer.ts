/** Canonical assembly CLI for the two-machine hive-git physical probe. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
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

export function finalizePhysicalDrillArtifacts(input: {
  evidence: unknown;
  receipts: unknown[];
}): { evidence: JsonRecord; trust: JsonRecord } {
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
  assertDistinctHosts(receipts.map((receipt) => ({
    schemaVersion: 'hive-git-physical-host-identity/v1',
    hostId: receipt.hostId,
    deviceKey: receipt.deviceKey,
    keychainId: receipt.keychainId,
    githubUserId: receipt.githubUserId,
    githubLogin: receipt.githubLogin,
    machineFingerprint: receipt.machineFingerprint,
  })));

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
      hosts: preflightPhysicalDrillHosts([
        readJson(towerIdentityPath),
        readJson(vmIdentityPath),
      ]),
    };
  }
  if (mode === 'sign') {
    const [evidencePath, hostId, cachePath] = args;
    if (!evidencePath || !hostId || !cachePath) {
      throw new Error(
        'usage: physical-drill-producer sign <unsigned-evidence.json> <host-id> <absolute-cache-path>',
      );
    }
    return issuePhysicalDrillHostReceipt({ evidencePath, hostId, cachePath });
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
  throw new Error('physical-drill-producer: mode must be identity, preflight, sign, or finalize');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
