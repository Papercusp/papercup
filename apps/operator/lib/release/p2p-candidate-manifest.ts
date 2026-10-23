/**
 * P-521 candidate manifest — plan p2p-public-release-endgame-2026-09-01, D-038
 * (WI-10002524).
 *
 * Binds the ONE packaged release candidate (exact source sha + exact artifact bytes)
 * to the P-519 computed readiness manifest (`current-readiness-manifest.ts`):
 *
 *   - the eight physical two-machine journeys P-521 names are MANDATORY rows. A journey
 *     reads `passed-on-this-artifact` only when its evidence was measured against THIS
 *     candidate's content digest and saw every expected peer. Evidence from any other
 *     artifact is refused as `lineage-mismatch` (twice: by the profile evaluator via
 *     `expectedLineage`, and by the manifest adapter's artifact-lineage check).
 *   - the F1–F8 + v1-scope items (P-512..P-520) closed on source/test evidence and handed
 *     their packaged proof to these journeys (D-036, D-037). They are therefore journey
 *     DEPENDENCIES, never rows: a manifest row is GO only when it passed on this artifact,
 *     so component tests alone cannot advance the verdict (P-521: "do not advance the
 *     global release verdict from component tests alone").
 *
 * The candidate's artifact identity is a content digest over the sorted
 * `<sha256>  <basename>` lines of its artifact set, so the identity is independent of
 * listing order and changes when any byte of any artifact changes.
 */
import { createHash } from 'node:crypto';
import {
  evaluateReleaseProfile,
  type ComponentRawVerdict,
  type ComponentSpec,
  type EvidenceRef,
} from '@papercusp/release-profile';
import {
  buildCurrentReadinessManifest,
  type CurrentReadinessManifest,
  type ReadinessCapabilityInput,
  type ReadinessHistoryEntry,
} from './current-readiness-manifest';

export const P2P_CANDIDATE_PROFILE_REF = 'p2p-public-release-p521-candidate';

/** The two physical machines every P-521 journey must observe. */
export const P2P_EXPECTED_PEERS = ['mac-vm', 'tower'] as const;

export interface P2pCandidateArtifact {
  /** Artifact basename (e.g. `Papercusp_0.0.22_amd64.AppImage`). */
  name: string;
  /** Lower-case hex sha256 of the artifact bytes. */
  sha256: string;
}

export interface P2pCandidateProvenance {
  version: string;
  channel: string;
  /** Exact 40-char superproject commit the candidate was cut from. */
  sourceSha: string;
  artifacts: readonly P2pCandidateArtifact[];
}

/** One physical journey's measured outcome on a specific artifact. */
export interface P2pJourneyResult {
  verdict: ComponentRawVerdict;
  reason: string;
  measuredAt: string;
  evidence: EvidenceRef[];
  /** `candidateArtifactDigest` of the artifact the journey actually ran on. */
  artifactDigest: string;
  observedPeers: readonly string[];
  /** Physical start, distinct from the observation/finish time. */
  startedAt?: string;
  precheckSubject?: P521PrecheckSubject;
}

export interface P521PrecheckSubject {
  artifactDigest: string;
  installerSha256?: string;
  runtimeSha256?: string;
  seedSha256?: string;
}

export interface P521LocalPrecheck {
  journey: string;
  check: string;
  verdict: string;
  startedAt: string;
  finishedAt: string;
  subject: P521PrecheckSubject;
  command: string[];
  evidence: EvidenceRef[];
  exitCode?: number;
  skipped?: boolean | number;
}

interface JourneyDef {
  key: string;
  title: string;
  localPrecheck: string;
  /** Source-closed plan items (F1–F8 + v1 scope) whose packaged proof this journey
   *  discharges. Graph edges only — they never become rows of their own. */
  dependencies: readonly string[];
}

/** The physical journeys P-521 requires on the one exact artifact, in P-521's order. */
export const P521_JOURNEYS: readonly JourneyDef[] = [
  { key: 'discovery-join', title: 'Discovery and join', dependencies: ['P-512'] },
  { key: 'git-consistency-signed-scope', title: 'Exact Git consistency and signed scope/generation', dependencies: ['P-512', 'P-513'] },
  { key: 'serving-identity-restart', title: 'Serving identity through restart/snapshot omission', dependencies: ['P-514'] },
  { key: 'replicated-write-outage-replay', title: 'Replicated-write outage/replay recovery', dependencies: ['P-515'] },
  { key: 'delegated-seat-lifecycle', title: 'Trusted delegated-seat boot/work/receipts/stop/revocation', dependencies: ['P-516'] },
  { key: 'protected-effect-fencing', title: 'Protected-effect fencing', dependencies: ['P-517'] },
  { key: 'github-bridge', title: 'GitHub bridge', dependencies: ['P-517'] },
  { key: 'full-installer-compat', title: 'Full-installer compatibility', dependencies: ['P-518', 'P-520'] },
].map((journey) => ({ ...journey, localPrecheck: 'p521-local-precheck:' + journey.key }));

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const SUBJECT_KEYS = new Set(['artifactDigest', 'installerSha256', 'runtimeSha256', 'seedSha256']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPrecheckSubject(value: unknown): value is P521PrecheckSubject {
  return record(value) && typeof value.artifactDigest === 'string'
    && SHA256_HEX.test(value.artifactDigest)
    && Object.entries(value).every(([key, hash]) =>
      SUBJECT_KEYS.has(key) && typeof hash === 'string' && SHA256_HEX.test(hash));
}

/** Optional byte identities must have identical presence, as well as equal values. */
export function p521PrecheckSubjectsMatch(a: unknown, b: unknown): boolean {
  return validPrecheckSubject(a) && validPrecheckSubject(b)
    && Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([key, hash]) => b[key as keyof P521PrecheckSubject] === hash);
}

function precheckTime(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return NaN;
  const [, yearText, monthText, dayText] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

/** Shared admission rule for dispatch and both evidence consumers (D283/D286). */
export function validateP521LocalPrechecks(
  receipts: unknown,
  subject: unknown,
  physicalStartedAt: unknown,
  requiredJourneys: readonly string[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!validPrecheckSubject(subject)) errors.push('complete precheck subject required');
  const physicalStart = precheckTime(physicalStartedAt);
  if (!Number.isFinite(physicalStart)) errors.push('physical startedAt required');
  if (!Array.isArray(receipts)) return { ok: false, errors: [...errors, 'local precheck receipts missing'] };
  const byJourney = new Map<string, Record<string, unknown>>();
  for (const receipt of receipts) {
    if (!record(receipt) || typeof receipt.journey !== 'string') {
      errors.push('malformed local precheck receipt');
      continue;
    }
    const journey = P521_JOURNEYS.find((row) => row.key === receipt.journey);
    if (!journey || receipt.check !== journey.localPrecheck) errors.push('unknown journey/check in local precheck');
    if (byJourney.has(receipt.journey)) errors.push('duplicate local precheck journey: ' + receipt.journey);
    byJourney.set(receipt.journey, receipt);
  }
  for (const key of requiredJourneys) {
    const receipt = byJourney.get(key);
    if (!receipt) { errors.push('local precheck missing: ' + key); continue; }
    if (receipt.verdict !== 'pass'
      || ('exitCode' in receipt && receipt.exitCode !== 0)
      || ('skipped' in receipt && receipt.skipped !== false && receipt.skipped !== 0)) {
      errors.push('local precheck refused verdict/skip/exit: ' + key);
    }
    if (!p521PrecheckSubjectsMatch(receipt.subject, subject)) errors.push('local precheck subject mismatch: ' + key);
    const started = precheckTime(receipt.startedAt), finished = precheckTime(receipt.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished)
      || started > finished || !(finished < physicalStart)) errors.push('local precheck time invalid/late: ' + key);
    if (!Array.isArray(receipt.command) || !receipt.command.length
      || !receipt.command.every((part) => typeof part === 'string' && part.trim())) {
      errors.push('local precheck command required: ' + key);
    }
    if (!Array.isArray(receipt.evidence) || !receipt.evidence.length
      || !receipt.evidence.every((ref) => record(ref) && typeof ref.ref === 'string'
        && ref.ref.trim() && (ref.kind === undefined || typeof ref.kind === 'string'))) {
      errors.push('local precheck evidence required: ' + key);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Content digest of a candidate's artifact set: sha256 over the sorted
 * `<sha256>  <basename>\n` lines. Refuses an empty set, a malformed hash, or a
 * duplicate basename (two different files would otherwise collapse to one identity).
 */
export function candidateArtifactDigest(artifacts: readonly P2pCandidateArtifact[]): string {
  if (artifacts.length === 0) throw new Error('candidate artifact set is empty');
  const seen = new Set<string>();
  const lines = artifacts.map(({ name, sha256 }) => {
    const base = name.trim();
    if (!base || base.includes('/')) throw new Error(`artifact name must be a basename: '${name}'`);
    if (!SHA256_HEX.test(sha256)) throw new Error(`artifact '${base}' has a malformed sha256`);
    if (seen.has(base)) throw new Error(`duplicate artifact basename '${base}'`);
    seen.add(base);
    return `${sha256}  ${base}\n`;
  });
  return createHash('sha256').update(lines.sort().join('')).digest('hex');
}

export interface BuildP2pCandidateManifestOptions {
  candidate: P2pCandidateProvenance;
  /** Journey results keyed by `P521_JOURNEYS[].key`; an absent key is unmeasured. */
  journeys?: Readonly<Record<string, P2pJourneyResult>>;
  localPrechecks?: readonly P521LocalPrecheck[];
  now?: number;
  history?: readonly ReadinessHistoryEntry[];
}

export async function buildP2pCandidateManifest(
  options: BuildP2pCandidateManifestOptions,
): Promise<CurrentReadinessManifest> {
  const { candidate } = options;
  if (!GIT_SHA.test(candidate.sourceSha)) throw new Error('candidate sourceSha must be a 40-char git sha');
  const known = new Set(P521_JOURNEYS.map((j) => j.key));
  for (const key of Object.keys(options.journeys ?? {})) {
    if (!known.has(key)) throw new Error(`unknown P-521 journey '${key}'`);
  }
  const nowMs = options.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const digest = candidateArtifactDigest(candidate.artifacts);

  const journeyComponents: ComponentSpec[] = P521_JOURNEYS.map((journey) => ({
    key: journey.key,
    title: journey.title,
    mandatory: true,
    check: async () => {
      const result = options.journeys?.[journey.key];
      if (!result) {
        return { verdict: 'unknown', reason: 'not yet run on this artifact', measuredAt: nowIso, evidence: [] };
      }
      const precheck = validateP521LocalPrechecks(
        options.localPrechecks, result.precheckSubject, result.startedAt, [journey.key],
      );
      const subjectMatches = result.precheckSubject?.artifactDigest === digest
        && result.artifactDigest === digest;
      return {
        verdict: precheck.ok && subjectMatches ? result.verdict : 'fail',
        reason: precheck.ok && subjectMatches ? result.reason
          : 'local precheck refused: ' + [...precheck.errors, ...(subjectMatches ? [] : ['candidate subject mismatch'])].join('; '),
        measuredAt: result.measuredAt,
        evidence: result.evidence,
        lineage: { sha: result.artifactDigest },
      };
    },
  }));

  const profile = await evaluateReleaseProfile(
    {
      profileRef: P2P_CANDIDATE_PROFILE_REF,
      expectedLineage: { sha: digest },
      components: journeyComponents,
    },
    { now: nowMs },
  );

  const capabilities: ReadinessCapabilityInput[] = P521_JOURNEYS.map((journey) => {
    const result = options.journeys?.[journey.key];
    return {
      key: journey.key,
      scenario: journey.title,
      expectedPeers: P2P_EXPECTED_PEERS,
      observedPeers: result?.observedPeers ?? [],
      owner: 'P-521',
      dependencies: journey.dependencies,
      executionState: result ? 'executed' : 'unmeasured',
    };
  });

  return buildCurrentReadinessManifest({
    profile,
    artifact: {
      id: `desktop-v${candidate.version}-${candidate.channel}@${candidate.sourceSha.slice(0, 12)}`,
      sha256: digest,
      sourceRevision: candidate.sourceSha,
    },
    capabilities,
    now: nowMs,
    history: options.history,
  });
}
