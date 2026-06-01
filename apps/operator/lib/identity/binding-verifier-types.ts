/**
 * binding-verifier-types — types for the two-channel binding verifier.
 *
 * Sources from `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`
 * (Phase 1b P-075). Types-only — no I/O, no Octokit calls, no PG.
 *
 * Two consumers will eventually import from here:
 *   - apps/operator/lib/identity/two-channel-verifier.ts (the runtime,
 *     when the memo accepts and P-075 implementation lands)
 *   - apps/operator/app/_components/BindingStatusBadge.tsx (the UI
 *     surface used by Contributors tab, Insights People card, user
 *     profile, and claim-CTA gate per memo D-A)
 *
 * Why types-first: the memo is "draft for review" but the wire-shapes
 * + state-machine + grace-window constants are concrete enough to
 * ship without committing the behavior. Mirrors the same pattern as
 * `binding-types.ts` (P-068 groundwork, commit f05997aa) — see the
 * `types-first-from-design-memo` insight.
 */

/**
 * The three states from memo §"Visual vocabulary":
 *   - `verified`: both channels passed. Stats aggregate. ✓ badge.
 *   - `pending`: channel 1 passed; channel 2 still propagating or
 *     transient channel-2 re-verification failure within grace window.
 *     Stats do NOT aggregate yet. ⏳ badge.
 *   - `unverified`: channel 1 failed, or channel 2 conclusively missing
 *     (gist 404 / branch deleted), or pending grace window expired.
 *     Stats do not aggregate. ⚠ badge.
 */
export type BindingStatus = 'verified' | 'pending' | 'unverified';

/**
 * Per-channel verification result. The structured `reason` lets the
 * UI surface specific copy (e.g. "channel 2 file missing on
 * user/<id> branch") rather than free-text.
 *
 * Both channels return one of three outcomes; `pending` is the
 * channel-1-passed-channel-2-not-yet state, which is meaningful only
 * for channel 2 (channel 1 is synchronous OAuth re-check, no pending).
 */
export type ChannelResult =
  | { kind: 'ok' }
  | { kind: 'pending'; reason: ChannelPendingReason }
  | { kind: 'fail'; reason: ChannelFailReason };

export type ChannelPendingReason =
  | 'just_joined_channel2_propagating'
  | 'channel2_transient_network'
  | 'channel2_rate_limit_retry';

export type ChannelFailReason =
  // Channel 1 (OAuth re-check)
  | 'oauth_token_mismatch'
  | 'oauth_token_revoked'
  | 'oauth_user_id_mismatch'
  // Channel 2 (signed file on user branch)
  | 'channel2_file_missing'
  | 'channel2_signature_invalid'
  // Channel 2 (gist-ownership attestation — replaces commit-signing check)
  /** Gist 404 — was never published, or was deleted (revocation signal). */
  | 'channel2_attestation_missing'
  /** Gist exists but owner/pubkey/signature mismatch — forgery indicator. */
  | 'channel2_attestation_invalid'
  // Either
  | 'github_api_down'
  | 'unknown';

/**
 * Combined verification result. `verifyBoth(...)` (P-075's runtime,
 * when it lands) returns this shape.
 */
export interface BindingVerificationResult {
  status: BindingStatus;
  channel1: ChannelResult;
  channel2: ChannelResult;
  checkedAt: number; // epoch ms
  /** When status is pending, the wall-clock deadline (ms) at which it
   * should flip to unverified if not resolved. Null for verified +
   * unverified. */
  pendingUntil?: number;
}

/**
 * Default grace window for pending → unverified flip. Per memo D-D
 * + Q-2 (24h default). Q-2 leaves room for per-harness override
 * (1-week max); when implemented, callers pass an explicit value.
 */
export const PENDING_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
export const PENDING_GRACE_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

/**
 * Clamp a caller-supplied grace window into [0, max]. Defensive — UI
 * could pass a garbage number and we don't want negative or
 * year-long values silently honored.
 *
 * Exported for testing.
 */
export function clampGraceWindowMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return PENDING_GRACE_WINDOW_MS;
  if (ms > PENDING_GRACE_WINDOW_MAX_MS) return PENDING_GRACE_WINDOW_MAX_MS;
  return ms;
}

/**
 * Predicate: does the binding state allow this contributor to claim
 * a harness? Per memo D-E + addendum-1: only `verified` qualifies.
 * Used by the claim-CTA gate (Phase 8 P-069e).
 */
export function canClaimHarness(status: BindingStatus): boolean {
  return status === 'verified';
}

/**
 * Predicate: does the binding state count for stats aggregation?
 * Per memo §"Per-surface treatment": only verified contributors
 * contribute to any tier's rollup. `pending` defers; `unverified`
 * excludes outright.
 *
 * Used by the contributor_usage_events rollup (P-070) + the Insights
 * People card filter (memo D-B: unverified excluded).
 */
export function statsAggregateForStatus(status: BindingStatus): boolean {
  return status === 'verified';
}

/**
 * Derive the binding status from two channel results + the current
 * pending-grace window (if applicable). Pure function — the runtime
 * verifier (P-075) calls this after `verifyChannel1` + `verifyChannel2`.
 *
 * State machine (from memo):
 *   - Channel 1 fail               → unverified
 *   - Channel 1 ok, channel 2 ok   → verified
 *   - Channel 1 ok, channel 2 fail → unverified (conclusive)
 *   - Channel 1 ok, channel 2 pending, within grace  → pending
 *   - Channel 1 ok, channel 2 pending, past grace    → unverified
 */
export function deriveBindingStatus(input: {
  channel1: ChannelResult;
  channel2: ChannelResult;
  /** When channel 2 first entered the pending state. Used to compare
   * against the grace window. Null when channel 2 has never been
   * pending (e.g. fresh just-joined). */
  channel2PendingSince?: number;
  /** Caller-supplied grace window; defaults to 24h. */
  graceWindowMs?: number;
  /** Current wall-clock (ms); injectable for tests. */
  nowMs?: number;
}): BindingStatus {
  const { channel1, channel2 } = input;
  if (channel1.kind === 'fail') return 'unverified';
  // channel1.kind === 'pending' is not a valid state (channel 1 is
  // synchronous); if it appears, treat as unverified defensively.
  if (channel1.kind === 'pending') return 'unverified';

  if (channel2.kind === 'fail') return 'unverified';
  if (channel2.kind === 'ok') return 'verified';

  // channel 2 is pending.
  const grace = clampGraceWindowMs(
    input.graceWindowMs ?? PENDING_GRACE_WINDOW_MS,
  );
  const since = input.channel2PendingSince ?? (input.nowMs ?? Date.now());
  const now = input.nowMs ?? Date.now();
  return now - since <= grace ? 'pending' : 'unverified';
}
