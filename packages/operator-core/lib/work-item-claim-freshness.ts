/**
 * Claim-time freshness envelope + scorer (fleet-member DX P-014).
 *
 * The envelope is evidence, never authority: a likely-stale score routes a bug
 * through a cheap validation pass but can never close it. This is deliberately a
 * payload extension rather than a parallel table — every issue-family row already
 * has a JSON payload and every claim surface already returns it.
 */

export interface WorkItemFreshnessEnvelope {
  observedAt: string;
  observedSourceSha: string | null;
  observedRuntimeSha: string | null;
  reporterSession: string | null;
  reporterRuntimeVersion: string | null;
  toolSchemaVersion: string | null;
  lastSuccessfulReproductionAt: string | null;
  deployBuildIdentity: string | null;
  linkedFixRefs: string[];
}

export interface CurrentClaimIdentity {
  headSha: string | null;
  runtimeSha: string | null;
  runtimeVersion: string | null;
}

export interface ClaimFreshnessVerdict {
  lane: 'implementation' | 'validation';
  score: number;
  likelyStale: boolean;
  reasons: string[];
  envelope: WorkItemFreshnessEnvelope | null;
  current: CurrentClaimIdentity;
  instruction: string;
}

export function createBugFreshnessEnvelope(args: {
  now?: string;
  sourceSha?: string | null;
  runtimeSha?: string | null;
  reporterSession?: string | null;
  reporterRuntimeVersion?: string | null;
  toolSchemaVersion?: string | null;
  lastSuccessfulReproductionAt?: string | null;
  deployBuildIdentity?: string | null;
  linkedFixRefs?: string[];
}): WorkItemFreshnessEnvelope {
  return {
    observedAt: args.now ?? new Date().toISOString(),
    observedSourceSha: args.sourceSha ?? null,
    observedRuntimeSha: args.runtimeSha ?? null,
    reporterSession: args.reporterSession ?? null,
    reporterRuntimeVersion: args.reporterRuntimeVersion ?? null,
    toolSchemaVersion: args.toolSchemaVersion ?? null,
    lastSuccessfulReproductionAt: args.lastSuccessfulReproductionAt ?? null,
    deployBuildIdentity: args.deployBuildIdentity ?? null,
    linkedFixRefs: [...(args.linkedFixRefs ?? [])],
  };
}

function shaMatches(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function finiteAgeMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
}

function readEnvelope(payload: unknown): WorkItemFreshnessEnvelope | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).freshnessEnvelope;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Partial<WorkItemFreshnessEnvelope>;
  if (typeof e.observedAt !== 'string') return null;
  return createBugFreshnessEnvelope({
    now: e.observedAt,
    sourceSha: typeof e.observedSourceSha === 'string' ? e.observedSourceSha : null,
    runtimeSha: typeof e.observedRuntimeSha === 'string' ? e.observedRuntimeSha : null,
    reporterSession: typeof e.reporterSession === 'string' ? e.reporterSession : null,
    reporterRuntimeVersion: typeof e.reporterRuntimeVersion === 'string' ? e.reporterRuntimeVersion : null,
    toolSchemaVersion: typeof e.toolSchemaVersion === 'string' ? e.toolSchemaVersion : null,
    lastSuccessfulReproductionAt:
      typeof e.lastSuccessfulReproductionAt === 'string' ? e.lastSuccessfulReproductionAt : null,
    deployBuildIdentity: typeof e.deployBuildIdentity === 'string' ? e.deployBuildIdentity : null,
    linkedFixRefs: Array.isArray(e.linkedFixRefs) ? e.linkedFixRefs.filter((x): x is string => typeof x === 'string') : [],
  });
}

/** Score freshness against the claimant's current operator HEAD/runtime. */
export function assessClaimFreshness(
  payload: unknown,
  current: CurrentClaimIdentity,
  nowMs = Date.now(),
): ClaimFreshnessVerdict {
  const envelope = readEnvelope(payload);
  const validationInstruction =
    'Cheap validation lane: inspect current HEAD and run the smallest targeted reproduction/test first. ' +
    'If it no longer reproduces, close only with that evidence; this score never auto-closes an item.';
  if (!envelope) {
    return {
      lane: 'validation',
      score: 0.2,
      likelyStale: true,
      reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
      envelope: null,
      current,
      instruction: validationInstruction,
    };
  }

  let score = 0.5;
  const reasons: string[] = [];
  const sourceMatch = shaMatches(envelope.observedSourceSha, current.headSha);
  if (sourceMatch === true) score += 0.25;
  else if (sourceMatch === false) {
    score -= 0.35;
    reasons.push('source HEAD moved since observation');
  } else {
    score -= 0.1;
    reasons.push('source HEAD identity unavailable');
  }
  const runtimeMatch = shaMatches(envelope.observedRuntimeSha, current.runtimeSha);
  if (runtimeMatch === true) score += 0.2;
  else if (runtimeMatch === false) {
    score -= 0.35;
    reasons.push('runtime/deploy generation moved since observation');
  } else {
    score -= 0.1;
    reasons.push('runtime identity unavailable');
  }

  const reproductionAge = finiteAgeMs(envelope.lastSuccessfulReproductionAt, nowMs);
  if (reproductionAge != null && reproductionAge <= 24 * 60 * 60 * 1000) score += 0.2;
  else if (reproductionAge != null && reproductionAge > 7 * 24 * 60 * 60 * 1000) {
    score -= 0.2;
    reasons.push('last successful reproduction is older than seven days');
  } else if (reproductionAge == null) {
    score -= 0.05;
    reasons.push('no successful reproduction timestamp');
  }

  const observationAge = finiteAgeMs(envelope.observedAt, nowMs);
  if (observationAge != null && observationAge > 30 * 24 * 60 * 60 * 1000) {
    score -= 0.2;
    reasons.push('observation is older than thirty days');
  } else if (observationAge != null && observationAge > 7 * 24 * 60 * 60 * 1000) {
    score -= 0.1;
    reasons.push('observation is older than seven days');
  }
  if (envelope.linkedFixRefs.length > 0) {
    score -= 0.45;
    reasons.push(`linked fixing work exists: ${envelope.linkedFixRefs.join(', ')}`);
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const likelyStale = score < 0.6;
  return {
    lane: likelyStale ? 'validation' : 'implementation',
    score,
    likelyStale,
    reasons: reasons.length > 0 ? reasons : ['observation matches the current source/runtime generation'],
    envelope,
    current,
    instruction: likelyStale
      ? validationInstruction
      : 'Implementation lane: freshness evidence matches the current generation. Reproduce before editing as usual.',
  };
}
