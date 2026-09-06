/**
 * Pure readiness evaluator for the public-release post-GO sequence.
 *
 * It deliberately does not start a canary, run chaos, change defaults, or
 * authorize shipment. It consumes already-produced evidence and proves that:
 *   P-501 began only after an independent GO and ran for an actual 72 hours;
 *   P-502 followed the soak and retained the single-owning-hive freeze model;
 *   P-503 may now make the separate automatic-mode/default decision.
 */
import {
  validatePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';

export const POST_GO_RELEASE_CANARY_SCHEMA = 'hive-git-post-go-release-canary/v1' as const;
export const POST_GO_RELEASE_CANARY_MIN_DURATION_MS = 72 * 60 * 60 * 1_000;
export const POST_GO_RELEASE_PLAN_ITEMS = ['P-501', 'P-502', 'P-503'] as const;

const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OWNER_ID = /^[A-Za-z0-9._:@-]{3,160}$/;

export type PostGoReleaseCanaryInput = {
  schemaVersion: typeof POST_GO_RELEASE_CANARY_SCHEMA;
  candidateSha: string;
  independentGo: {
    decision: 'GO';
    candidateSha: string;
    approvedAt: string;
    reviewerOwnerId: string;
    implementationOwnerId: string;
    attestationRef: string;
  };
  canary: {
    candidateSha: string;
    startedAt: string;
    finishedAt: string;
  };
  ownerFreezeChaos: {
    candidateSha: string;
    window: {
      startedAt: string;
      finishedAt: string;
    };
    duringOwnerOutage: {
      protectedEffects: 'frozen';
      nonOwnerAttempt: 'refused';
      reason: 'missing-hive-authority';
    };
    afterOwnerRecovery: {
      owningHiveProof: 'restored';
      protectedEffects: 'resumed';
    };
    phaseG: PhysicalPhaseGInput;
  };
  evaluatedAt: string;
};

export type PostGoReleaseCanaryVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof POST_GO_RELEASE_CANARY_SCHEMA;
    candidateSha: string;
    status: 'ready-for-default-mode-decision';
    planItems: typeof POST_GO_RELEASE_PLAN_ITEMS;
    independentGoApprovedAt: string;
    canaryDurationMs: number;
    minimumDurationMs: typeof POST_GO_RELEASE_CANARY_MIN_DURATION_MS;
    ownerFreezeVerified: true;
    ownerRecoveryVerified: true;
    observedAt: string;
  };
};

function pushError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function timestamp(value: unknown): number {
  return Date.parse(typeof value === 'string' ? value : '');
}

export function validatePostGoReleaseCanary(
  input: PostGoReleaseCanaryInput,
): PostGoReleaseCanaryVerdict {
  const errors: string[] = [];
  const candidateSha = input?.candidateSha ?? '';

  pushError(
    errors,
    input?.schemaVersion === POST_GO_RELEASE_CANARY_SCHEMA,
    `schemaVersion must be ${POST_GO_RELEASE_CANARY_SCHEMA}`,
  );
  pushError(errors, GIT_OID.test(candidateSha), 'candidateSha must be a 40- or 64-hex Git OID');

  const go = input?.independentGo;
  pushError(errors, go?.decision === 'GO', 'independentGo.decision must be GO');
  pushError(errors, go?.candidateSha === candidateSha, 'independent GO must bind the exact candidate');
  pushError(
    errors,
    OWNER_ID.test(go?.reviewerOwnerId ?? '') && OWNER_ID.test(go?.implementationOwnerId ?? ''),
    'independent GO must name valid reviewer and implementation owner ids',
  );
  pushError(
    errors,
    go?.reviewerOwnerId !== go?.implementationOwnerId,
    'independent GO reviewer must differ from the implementation owner',
  );
  pushError(
    errors,
    typeof go?.attestationRef === 'string' && go.attestationRef.trim().length > 0,
    'independent GO must carry a durable attestationRef',
  );

  const approvedAt = timestamp(go?.approvedAt);
  const canaryStartedAt = timestamp(input?.canary?.startedAt);
  const canaryFinishedAt = timestamp(input?.canary?.finishedAt);
  const canaryDurationMs = canaryFinishedAt - canaryStartedAt;
  pushError(errors, Number.isFinite(approvedAt), 'independent GO approvedAt must be ISO-8601');
  pushError(
    errors,
    input?.canary?.candidateSha === candidateSha,
    'canary must bind the exact independently approved candidate',
  );
  pushError(
    errors,
    Number.isFinite(canaryStartedAt) &&
      Number.isFinite(canaryFinishedAt) &&
      canaryStartedAt <= canaryFinishedAt,
    'canary window must contain ordered ISO-8601 timestamps',
  );
  pushError(
    errors,
    Number.isFinite(approvedAt) &&
      Number.isFinite(canaryStartedAt) &&
      canaryStartedAt >= approvedAt,
    'canary cannot start before the independent GO',
  );
  pushError(
    errors,
    Number.isFinite(canaryDurationMs) &&
      canaryDurationMs >= POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
    'canary must run for an actual minimum of 72 hours',
  );

  const chaos = input?.ownerFreezeChaos;
  const chaosStartedAt = timestamp(chaos?.window?.startedAt);
  const chaosFinishedAt = timestamp(chaos?.window?.finishedAt);
  pushError(
    errors,
    chaos?.candidateSha === candidateSha,
    'owner-freeze chaos must bind the exact canary candidate',
  );
  pushError(
    errors,
    Number.isFinite(chaosStartedAt) &&
      Number.isFinite(chaosFinishedAt) &&
      chaosStartedAt <= chaosFinishedAt,
    'owner-freeze chaos window must contain ordered ISO-8601 timestamps',
  );
  pushError(
    errors,
    Number.isFinite(canaryFinishedAt) &&
      Number.isFinite(chaosStartedAt) &&
      chaosStartedAt >= canaryFinishedAt,
    'owner-freeze chaos cannot execute before the 72-hour canary finishes',
  );
  pushError(
    errors,
    chaos?.duringOwnerOutage?.protectedEffects === 'frozen' &&
      chaos?.duringOwnerOutage?.nonOwnerAttempt === 'refused' &&
      chaos?.duringOwnerOutage?.reason === 'missing-hive-authority',
    'owner outage must freeze protected effects and refuse non-owner authority',
  );
  pushError(
    errors,
    chaos?.afterOwnerRecovery?.owningHiveProof === 'restored' &&
      chaos?.afterOwnerRecovery?.protectedEffects === 'resumed',
    'protected effects may resume only after owning-hive proof is restored',
  );

  const phaseG = chaos?.phaseG;
  const phaseGStartedAt = timestamp(phaseG?.window?.startedAt);
  const phaseGFinishedAt = timestamp(phaseG?.window?.finishedAt);
  pushError(
    errors,
    Number.isFinite(phaseGStartedAt) &&
      Number.isFinite(phaseGFinishedAt) &&
      phaseGStartedAt >= chaosStartedAt &&
      phaseGFinishedAt <= chaosFinishedAt,
    'Phase G evidence must fall inside the post-canary owner-freeze chaos window',
  );
  try {
    const phaseGVerdict = validatePhysicalPhaseG(phaseG);
    for (const error of phaseGVerdict.errors) errors.push(`Phase G: ${error}`);
    pushError(
      errors,
      phaseGVerdict.ok && phaseGVerdict.result?.complete === true,
      'owner-freeze chaos must contain complete validated P-308 Phase G evidence',
    );
  } catch (error) {
    errors.push(
      `Phase G evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const evaluatedAt = timestamp(input?.evaluatedAt);
  pushError(
    errors,
    Number.isFinite(evaluatedAt) &&
      Number.isFinite(chaosFinishedAt) &&
      evaluatedAt >= chaosFinishedAt,
    'evaluatedAt must be at or after the completed owner-freeze chaos window',
  );

  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) return { ok: false, errors: uniqueErrors, result: null };
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: POST_GO_RELEASE_CANARY_SCHEMA,
      candidateSha,
      status: 'ready-for-default-mode-decision',
      planItems: POST_GO_RELEASE_PLAN_ITEMS,
      independentGoApprovedAt: go.approvedAt,
      canaryDurationMs,
      minimumDurationMs: POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
      ownerFreezeVerified: true,
      ownerRecoveryVerified: true,
      observedAt: input.evaluatedAt,
    },
  };
}
