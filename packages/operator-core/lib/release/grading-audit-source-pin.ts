import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BuildInfo } from '../build-info';
import { measureBootOperatorArtifact } from './operator-artifact';

/** A crash-recovery window, never an indefinite claim on a staging generation. */
export const GRADING_AUDIT_SOURCE_PIN_MAX_SEC = 6 * 60 * 60;
export const GRADING_AUDIT_SOURCE_PIN_DIR = '.audit-runtime-pins';

export interface GradingAuditSourcePin {
  schemaVersion: 1;
  sourceRoot: string;
  ownerRef: string;
  evaluatorBuild: BuildInfo;
  bundleSha256: string;
  expiresAtSec: number;
  /** Prepared external outputs retain their measured manifest, never a directory-name assertion. */
  externalArtifact?: { bundlePath: string; artifactRoot: string; sourceSha: string; manifestSha256: string };
}

function pinPath(sourceRoot: string, ownerRef: string): string {
  // The shell collector owns only immutable candidate roots. Never pin the
  // mutable canonical checkout or an alias whose destination can advance.
  if (!ownerRef.trim()) throw new Error('Audit source pin owner is required');
  const directory = basename(sourceRoot) === 'checkout' && basename(dirname(sourceRoot)).startsWith('.candidate-')
    ? join(dirname(sourceRoot), GRADING_AUDIT_SOURCE_PIN_DIR)
    : join(dirname(sourceRoot), GRADING_AUDIT_SOURCE_PIN_DIR,
      'external-' + createHash('sha256').update(sourceRoot).digest('hex'));
  return join(directory,
    createHash('sha256').update(ownerRef).digest('hex'));
}

function validSource(input: Omit<GradingAuditSourcePin, 'schemaVersion'>): boolean {
  const artifact = input.externalArtifact;
  if (!artifact) return basename(input.sourceRoot) === 'checkout' &&
    basename(dirname(input.sourceRoot)).startsWith('.candidate-');
  try {
    if (realpathSync(artifact.artifactRoot) !== resolve(artifact.artifactRoot) ||
        artifact.bundlePath !== join(artifact.artifactRoot, 'hono-host.mjs') ||
        realpathSync(artifact.bundlePath) !== artifact.bundlePath) return false;
    const measured = measureBootOperatorArtifact(artifact.bundlePath, input.evaluatorBuild.sha, Date.now() + 1);
    return measured.status === 'measured' && measured.bundleSha256 === input.bundleSha256 &&
      measured.sourceSha === artifact.sourceSha && measured.manifestSha256 === artifact.manifestSha256;
  } catch { return false; }
}

/** The same pin directory bridges a crash before external output reaches the task ledger. */
export function recoverExternalGradingAuditSourcePins(root: string, ownerRef: string, nowSec: number): GradingAuditSourcePin[] {
  const pins: GradingAuditSourcePin[] = [];
  const directory = join(root, GRADING_AUDIT_SOURCE_PIN_DIR);
  let entries: string[];
  try { entries = readdirSync(directory).filter(name => /^external-[a-f0-9]{64}$/.test(name)); }
  catch { return pins; }
  for (const entry of entries) {
    try {
      const path = join(directory, entry, createHash('sha256').update(ownerRef).digest('hex'));
      const raw = JSON.parse(readFileSync(path, 'utf8').split('\n')[1] ?? '') as GradingAuditSourcePin;
      if (typeof raw.sourceRoot !== 'string' || pinPath(raw.sourceRoot, ownerRef) !== path) continue;
      const pin = readGradingAuditSourcePin(raw.sourceRoot, ownerRef, nowSec);
      if (pin?.externalArtifact) pins.push(pin);
    } catch { /* An incomplete or expired pin cannot confer source authority. */ }
  }
  return pins;
}

/**
 * Acquire while the source is still protected by the spawning process (or the
 * staging checkout lock). The pin then bridges a process crash. The task ledger
 * stores the same locator; it remains the authority for endpoint ownership.
 * First line is the collector's bounded expiry; the rest is the replay locator.
 */
export function writeGradingAuditSourcePin(
  input: Omit<GradingAuditSourcePin, 'schemaVersion'>,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  if (!Number.isSafeInteger(input.expiresAtSec) || input.expiresAtSec <= nowSec ||
      input.expiresAtSec > nowSec + GRADING_AUDIT_SOURCE_PIN_MAX_SEC) {
    throw new Error('Audit source pin expiry must be within the bounded recovery window');
  }
  if (!input.evaluatorBuild.sha || !input.evaluatorBuild.version || !/^[a-f0-9]{64}$/i.test(input.bundleSha256)) {
    throw new Error('Audit source pins require exact build and bundle identities');
  }
  const sourceRoot = realpathSync(input.sourceRoot);
  if (!validSource({ ...input, sourceRoot })) throw new Error('Audit source pins require an immutable candidate or measured external artifact');
  const path = pinPath(sourceRoot, input.ownerRef);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const pin: GradingAuditSourcePin = { ...input, sourceRoot, schemaVersion: 1 };
    writeFileSync(temporary, `${pin.expiresAtSec}\n${JSON.stringify(pin)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

export function readGradingAuditSourcePin(
  sourceRoot: string,
  ownerRef: string,
  nowSec = Math.floor(Date.now() / 1000),
): GradingAuditSourcePin | null {
  try {
    const physicalRoot = realpathSync(sourceRoot);
    const [expiry, body] = readFileSync(pinPath(physicalRoot, ownerRef), 'utf8').split('\n');
    const pin = JSON.parse(body ?? '') as GradingAuditSourcePin;
    if (pin.schemaVersion !== 1 || pin.sourceRoot !== physicalRoot || pin.ownerRef !== ownerRef ||
        !Number.isSafeInteger(pin.expiresAtSec) || String(pin.expiresAtSec) !== expiry ||
        pin.expiresAtSec <= nowSec || pin.expiresAtSec > nowSec + GRADING_AUDIT_SOURCE_PIN_MAX_SEC ||
        !pin.evaluatorBuild?.sha || !pin.evaluatorBuild.version || !/^[a-f0-9]{64}$/i.test(pin.bundleSha256) ||
        !validSource(pin)) return null;
    return pin;
  } catch {
    return null;
  }
}

export function releaseGradingAuditSourcePin(sourceRoot: string, ownerRef: string): void {
  rmSync(pinPath(sourceRoot, ownerRef), { force: true });
}
