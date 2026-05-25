/**
 * Distributed feature-claim primitive (Phase 6 P-036).
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 * v5 §0.6 — race-free feature claim via Autobase merge-order
 * arbitration. Mathematical guarantee that two peers can't both
 * fire workers on the same feature.
 *
 * Algorithm:
 *   1. Append a claim record `{kind: 'feature_claim', feature_id,
 *      claimer_pubkey, claimer_github_user_id, ts, schema_version}`
 *      to our local Autobase view.
 *   2. Await our own append's merge into the merged view.
 *   3. Scan the merged view for claims on this feature_id.
 *   4. The earliest claim (by merged sequence + pubkey tiebreak)
 *      wins. If ours, return `{won: true, claim_seq}`. Otherwise,
 *      return `{won: false, claim_seq}` and drop the candidate.
 *
 * Pure logic — accepts a `ClaimAutobaseHandle` interface that the
 * substrate boot wiring provides. Tests inject a fake handle to
 * exercise single-writer, two-writer race, and contested-feature
 * paths without booting the substrate.
 *
 * Per D-024: every op carries `schema_version` (currently `1`).
 * Per v5 §0.6 ordering rule: deterministic `(writer_pubkey, seq)`
 * tiebreak — bytewise lex of the pubkey hex.
 */

import { CURRENT_SCHEMA_VERSION } from '../sync/hyperbee/schema-version';

/**
 * On-the-wire claim record. Mirrors the shape projected to PG by
 * `feature-claims.ts`; the two stay in lock-step.
 */
export interface FeatureClaimRecord {
  kind: 'feature_claim';
  feature_id: string;
  claimer_pubkey: string;
  claimer_github_user_id: number;
  ts: number;                      // epoch ms
  schema_version: number;
}

/**
 * The minimal Autobase interface this primitive needs. Production
 * uses `apps/operator/lib/sync/hyperbee/autobase-setup.ts`'s real
 * Autobase handle; tests use a fake.
 */
export interface ClaimAutobaseHandle {
  /** Our own pubkey (hex), used for tiebreak + filtering. */
  myPubkey: string;
  /** Append a claim op. Resolves once the op is in our local view. */
  appendClaim(record: FeatureClaimRecord): Promise<{ seq: number }>;
  /** Read all claim ops in the merged view for this feature_id, in merge order. */
  readClaimsForFeature(feature_id: string): Promise<ReadonlyArray<MergedClaim>>;
}

/** A claim as seen in the merged Autobase view — carries its merged seq. */
export interface MergedClaim {
  record: FeatureClaimRecord;
  /** Monotonic merged sequence number; deterministic across peers. */
  seq: number;
}

export interface ClaimResult {
  won: boolean;
  /** The seq of OUR claim op (always defined; we always appended ours). */
  claim_seq: number;
  /** When `won: false`, the pubkey of the actual winner. Undefined on win. */
  winner_pubkey?: string;
}

export interface ClaimOpts {
  feature_id: string;
  claimer_github_user_id: number;
  /** Override for tests. Defaults to `Date.now()`. */
  now_ms?: number;
}

export class ClaimValidationError extends Error {
  constructor(public field: string) {
    super(`claimFeature: invalid ${field}`);
  }
}

/**
 * Pick the winner across multiple claims on the same feature.
 * Earliest seq wins. On exact seq tie (Autobase normally precludes
 * this but defensive nonetheless), bytewise-lex of pubkey hex breaks
 * the tie. Returns the winning `MergedClaim`.
 */
export function pickWinningClaim(claims: ReadonlyArray<MergedClaim>): MergedClaim | null {
  if (claims.length === 0) return null;
  let winner = claims[0];
  for (let i = 1; i < claims.length; i++) {
    const c = claims[i];
    if (c.seq < winner.seq) {
      winner = c;
      continue;
    }
    if (c.seq === winner.seq && c.record.claimer_pubkey < winner.record.claimer_pubkey) {
      winner = c;
    }
  }
  return winner;
}

/**
 * Append our claim + decide whether we won the race.
 *
 * Returns `won: true` only if our claim appears first in the merged
 * view's ordering. On `won: false`, the orchestrator drops the
 * feature and moves on.
 */
export async function claimFeature(
  base: ClaimAutobaseHandle,
  opts: ClaimOpts,
): Promise<ClaimResult> {
  if (!opts.feature_id) throw new ClaimValidationError('feature_id');
  if (!Number.isInteger(opts.claimer_github_user_id) || opts.claimer_github_user_id <= 0) {
    throw new ClaimValidationError('claimer_github_user_id');
  }
  const record: FeatureClaimRecord = {
    kind: 'feature_claim',
    feature_id: opts.feature_id,
    claimer_pubkey: base.myPubkey,
    claimer_github_user_id: opts.claimer_github_user_id,
    ts: opts.now_ms ?? Date.now(),
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  const { seq } = await base.appendClaim(record);

  const all = await base.readClaimsForFeature(opts.feature_id);
  // Defensive: filter to ops that match the feature_id we care about,
  // in case the handle returns broader scope.
  const filtered = all.filter((c) => c.record.feature_id === opts.feature_id);
  const winner = pickWinningClaim(filtered);
  if (!winner) {
    // Our own append went missing — treat as loss (orchestrator drops + retries).
    return { won: false, claim_seq: seq, winner_pubkey: undefined };
  }
  const won = winner.record.claimer_pubkey === base.myPubkey;
  return won
    ? { won: true, claim_seq: seq }
    : { won: false, claim_seq: seq, winner_pubkey: winner.record.claimer_pubkey };
}
