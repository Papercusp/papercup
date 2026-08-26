/**
 * Exact-SHA certification projected from the live-federation gate's durable
 * verdict bank.
 *
 * P-010 deliberately keeps code promotion and specialized live qualification
 * as two separate stages. The green-checkpoint may advance `main` after its
 * code/test invariants pass; an ordinary deploy may consume that pin only when
 * the live-federation writer has certified the same immutable source.
 *
 * This module is a reader over the existing JSONL bank, not a second scheduler
 * or state store. The writer remains `papercusp-desktop/bin/live-federation-
 * gate.sh`; all deployment paths share this one fail-closed interpretation.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION = 2 as const;
export const LIVE_RELEASE_CERTIFICATION_BANK_ENV = 'PAPERCUSP_LIVE_CERTIFICATION_BANK';

export interface LiveFederationVerdictRecord {
  schema_version?: number;
  epoch?: number;
  verdict?: string;
  head?: string;
  desktop_head?: string;
  source_mode?: string;
  source_head?: string;
  source_desktop_head?: string;
  source_dirty_files?: number;
  terminal_dirty_files?: number;
  certification_target_sha?: string;
  certification_expires_epoch?: number;
  line?: string;
  [key: string]: unknown;
}

export type LiveReleaseCertificationStatus =
  | 'certified'
  | 'missing'
  | 'target-mismatch'
  | 'failed'
  | 'expired'
  | 'unqualified'
  | 'unreadable';

export interface LiveReleaseCertification {
  status: LiveReleaseCertificationStatus;
  targetSha: string;
  certified: boolean;
  reason: string;
  bankPath: string | null;
  evidence: LiveFederationVerdictRecord | null;
  invalidLines: number;
}

export interface ReadLiveReleaseCertificationOptions {
  bankPath?: string;
  nowMs?: number;
  readText?: (filePath: string) => Promise<string>;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function liveReleaseCertificationBankPath(): string {
  return (
    process.env[LIVE_RELEASE_CERTIFICATION_BANK_ENV]?.trim() ||
    path.join(homedir(), '.papercusp', 'live-fed-gate', 'verdicts.jsonl')
  );
}

/** The bank stores short SHAs. Prefix equality is therefore the exact relation. */
export function certificationShaMatches(left: string | null | undefined, right: string): boolean {
  const a = left?.trim().toLowerCase() ?? '';
  const b = right.trim().toLowerCase();
  if (!SHA_RE.test(a) || !SHA_RE.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function result(
  status: LiveReleaseCertificationStatus,
  targetSha: string,
  reason: string,
  evidence: LiveFederationVerdictRecord | null,
  invalidLines: number,
  bankPath: string | null,
): LiveReleaseCertification {
  return {
    status,
    targetSha,
    certified: status === 'certified',
    reason,
    bankPath,
    evidence,
    invalidLines,
  };
}

function recordTargets(record: LiveFederationVerdictRecord, targetSha: string): boolean {
  return (
    certificationShaMatches(record.certification_target_sha, targetSha) ||
    certificationShaMatches(record.source_head, targetSha) ||
    certificationShaMatches(record.head, targetSha)
  );
}

/**
 * Assess the newest bank record attributable to `targetSha`.
 *
 * Append order is authoritative. A newer exact-source red invalidates an older
 * green. Non-verdict/freshness records do not inherit certification: they lack
 * the immutable build evidence and therefore return `unqualified` rather than
 * silently falling back to an older result.
 */
export function assessLiveReleaseCertification(
  rawBank: string,
  targetSha: string,
  nowMs = Date.now(),
  bankPath: string | null = null,
): LiveReleaseCertification {
  const normalizedTarget = targetSha.trim().toLowerCase();
  if (!SHA_RE.test(normalizedTarget)) {
    return result(
      'unreadable',
      normalizedTarget,
      `target sha is not a usable git object id: ${JSON.stringify(targetSha)}`,
      null,
      0,
      bankPath,
    );
  }
  if (!Number.isFinite(nowMs)) {
    return result('unreadable', normalizedTarget, 'evaluation instant is not finite', null, 0, bankPath);
  }

  const lines = rawBank.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed: LiveFederationVerdictRecord[] = [];
  let invalidLines = 0;
  let newestLineInvalid = false;
  lines.forEach((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed.push(value as LiveFederationVerdictRecord);
    } catch {
      invalidLines += 1;
      if (index === lines.length - 1) newestLineInvalid = true;
    }
  });

  // A torn newest append may contain a newer red or revocation. Falling back to
  // the previous green would manufacture authorization from unreadable state.
  if (newestLineInvalid) {
    return result(
      'unreadable',
      normalizedTarget,
      'the newest verdict-bank line is not valid JSON; refusing to infer certification from older state',
      null,
      invalidLines,
      bankPath,
    );
  }
  if (parsed.length === 0) {
    return result('missing', normalizedTarget, 'the verdict bank contains no readable records', null, invalidLines, bankPath);
  }

  const evidence = [...parsed].reverse().find((record) => recordTargets(record, normalizedTarget)) ?? null;
  if (!evidence) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the verdict bank contains no record attributable to the requested green pin',
      null,
      invalidLines,
      bankPath,
    );
  }

  if (evidence.schema_version !== LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION) {
    return result(
      'unqualified',
      normalizedTarget,
      `the newest target record uses certification schema ${String(evidence.schema_version ?? 'legacy')}, expected ${LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION}`,
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (evidence.source_mode !== 'rebuilt') {
    return result(
      'unqualified',
      normalizedTarget,
      `the live gate did not rebuild this source (source_mode=${String(evidence.source_mode ?? 'missing')})`,
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    !certificationShaMatches(evidence.source_head, normalizedTarget) ||
    !certificationShaMatches(evidence.head, normalizedTarget) ||
    !certificationShaMatches(evidence.source_head, evidence.head ?? '')
  ) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the build-start sha, terminal sha, and requested green pin are not the same source',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    evidence.certification_target_sha &&
    !certificationShaMatches(evidence.certification_target_sha, normalizedTarget)
  ) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the run declared a different certification target',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    !certificationShaMatches(evidence.source_desktop_head, evidence.desktop_head ?? '')
  ) {
    return result(
      'unqualified',
      normalizedTarget,
      'the desktop submodule changed between build start and terminal verdict',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (evidence.source_dirty_files !== 0 || evidence.terminal_dirty_files !== 0) {
    return result(
      'unqualified',
      normalizedTarget,
      `the certified source was not clean (start=${String(evidence.source_dirty_files)}, terminal=${String(evidence.terminal_dirty_files)})`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  const verdict = evidence.verdict?.trim().toUpperCase() ?? '';
  if (verdict === 'RED') {
    return result(
      'failed',
      normalizedTarget,
      'the newest exact-source live-federation verdict is RED',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (verdict !== 'GREEN') {
    return result(
      'unqualified',
      normalizedTarget,
      `the newest exact-source record is not a certifying verdict (${verdict || 'missing'})`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  const expiresEpoch = evidence.certification_expires_epoch;
  if (!Number.isFinite(expiresEpoch) || (expiresEpoch ?? 0) <= 0) {
    return result(
      'unqualified',
      normalizedTarget,
      'the GREEN record has no usable writer-owned certification expiry',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (nowMs >= (expiresEpoch as number) * 1_000) {
    return result(
      'expired',
      normalizedTarget,
      `the exact-source live certification expired at ${new Date((expiresEpoch as number) * 1_000).toISOString()}`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  return result(
    'certified',
    normalizedTarget,
    `live federation certified exact source ${evidence.source_head}`,
    evidence,
    invalidLines,
    bankPath,
  );
}

export async function readLiveReleaseCertification(
  targetSha: string,
  opts: ReadLiveReleaseCertificationOptions = {},
): Promise<LiveReleaseCertification> {
  const bankPath = opts.bankPath ?? liveReleaseCertificationBankPath();
  const readText = opts.readText ?? ((filePath: string) => readFile(filePath, 'utf8'));
  try {
    return assessLiveReleaseCertification(await readText(bankPath), targetSha, opts.nowMs ?? Date.now(), bankPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return result(
      code === 'ENOENT' ? 'missing' : 'unreadable',
      targetSha.trim().toLowerCase(),
      code === 'ENOENT'
        ? `live-certification verdict bank does not exist at ${bankPath}`
        : `could not read live-certification verdict bank at ${bankPath}: ${error instanceof Error ? error.message : String(error)}`,
      null,
      0,
      bankPath,
    );
  }
}

