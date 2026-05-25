/**
 * attemptClaimWithAudit — single-call wrapper for orchestrator pickup.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-037.
 *
 * Pairs the two primitives the orchestrator always uses together:
 *
 *   1. claimFeature(base, opts) — race-free distributed claim per v5 §0.6
 *   2. recordClaimAttempt({...}) — LOCAL PG audit row per attempt
 *
 * Returns the same ClaimResult as claimFeature, plus the outcome
 * string written to the audit log. Audit row mirrors the result
 * (won/lost), with `detail` carrying the winner_pubkey on losses.
 *
 * If the audit write fails (PG unreachable, schema not present),
 * the claim outcome still returns — auditing is best-effort. The
 * orchestrator's decision must not depend on the audit succeeding.
 */

import {
  claimFeature,
  ClaimValidationError,
  type ClaimAutobaseHandle,
  type ClaimResult,
} from './feature-claim';
import {
  recordClaimAttempt,
  type ClaimOutcome,
} from './claim-audit';

export interface AttemptClaimOpts {
  workspaceId: string;
  harnessSlug: string;
  feature_id: string;
  claimer_github_user_id: number;
  /** Override for tests; defaults to Date.now(). */
  now_ms?: number;
}

export interface AttemptClaimResult extends ClaimResult {
  audit_outcome: ClaimOutcome;
  audit_recorded: boolean;
  audit_error?: string;
}

function outcomeFromResult(r: ClaimResult): ClaimOutcome {
  return r.won ? 'won' : 'lost';
}

function detailFromResult(r: ClaimResult): string | undefined {
  if (r.won) return undefined;
  if (r.winner_pubkey) return `winner=${r.winner_pubkey}`;
  return 'own_claim_not_in_view';
}

export async function attemptClaimWithAudit(
  base: ClaimAutobaseHandle,
  opts: AttemptClaimOpts,
): Promise<AttemptClaimResult> {
  let result: ClaimResult;
  try {
    result = await claimFeature(base, {
      feature_id: opts.feature_id,
      claimer_github_user_id: opts.claimer_github_user_id,
      now_ms: opts.now_ms,
    });
  } catch (e) {
    // Validation errors propagate; only ClaimValidationError is expected.
    // Anything else (Autobase append failure, view scan failure) gets
    // audited as 'error' before re-throwing.
    if (e instanceof ClaimValidationError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    let auditRecorded = false;
    let auditError: string | undefined;
    try {
      await recordClaimAttempt({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        feature_id: opts.feature_id,
        claimer_pubkey: base.myPubkey,
        outcome: 'error',
        detail: msg.slice(0, 500),
        attempt_ts: opts.now_ms,
      });
      auditRecorded = true;
    } catch (auditErr) {
      auditError = auditErr instanceof Error ? auditErr.message : String(auditErr);
    }
    void auditRecorded;
    void auditError;
    throw e;
  }

  const outcome = outcomeFromResult(result);
  const detail = detailFromResult(result);
  let auditRecorded = false;
  let auditError: string | undefined;
  try {
    await recordClaimAttempt({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
      claimer_pubkey: base.myPubkey,
      outcome,
      detail,
      attempt_ts: opts.now_ms,
    });
    auditRecorded = true;
  } catch (e) {
    auditError = e instanceof Error ? e.message : String(e);
    // best-effort; don't fail the claim outcome
  }

  return {
    ...result,
    audit_outcome: outcome,
    audit_recorded: auditRecorded,
    audit_error: auditError,
  };
}
