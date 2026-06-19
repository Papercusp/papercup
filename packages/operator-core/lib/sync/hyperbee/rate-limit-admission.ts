/**
 * rate-limit-admission — EN-2 (P-RATE) write/op admission wiring (plan
 * `shared-hive-owner-enforcement-2026-06-19`, Phase EN-2).
 *
 * Wraps the substrate's per-harness op-apply sink (boot.ts `scopedApply`) so that,
 * when an owner has set a `hive_policy.rate` cap (EN-1), an over-cap op FROM A
 * MEMBER is DROPPED at write/op admission — never written to PG, so it never
 * becomes canonical on this (honest) peer. Because every honest peer runs this
 * same wrapper independently, a flooding member's excess is dropped by ALL honest
 * peers and the flood never becomes canonical (the plan's honest-majority teeth).
 *
 * This is the wiring; `rate-limiter.ts` is the pure decider. Responsibilities:
 *   1. ATTRIBUTION — resolve an op's author to a `github_user_id`. For a REMOTE
 *      op the trustworthy key is `op.sourceLogKeyHex` (the receiver-stamped source
 *      log core key — UNFORGEABLE, D-004), resolved via the admission map
 *      (`admittedIdentities`). The self-declared `op.writerPubkey` is NOT trusted.
 *      LOCAL ops (own log) are the operator's own writes and are NEVER limited.
 *   2. CLASSIFICATION — map an op to the rate classes it counts against
 *      (`ops` always; `rows` for content puts). Ephemeral + governance/identity
 *      tables are never limited (heartbeat/usage churn + owner-authored governance
 *      must not be throttled).
 *   3. ENFORCEMENT — consult the limiter; on `drop`, return `false` (the op is not
 *      applied to PG). Default-off: with no policy / no rate caps it is a pure
 *      passthrough (zero behavior change for an un-policed hive).
 *
 * FAIL-CLOSED: when a rate cap IS in force but a remote op's author cannot be
 * resolved (no admission-map entry — e.g. a concurrent revoke), the op is dropped
 * rather than slipping past unattributed (the brief's "no resolvable author under
 * a non-open policy fails closed").
 */

import type { OpEnvelope } from './op-envelope-types';
import { capForClass, type MemberRateLimiter, type RateCaps, type RateClass } from './rate-limiter';

/**
 * Tables NEVER rate-limited:
 *   - ephemeral system churn (`presence`, `usage`) — heartbeat/telemetry, not a
 *     content-spam vector; limiting them would break normal operation.
 *   - identity/governance (`contributors`, `hive-members`, `hive-settings-by-key`)
 *     — owner/system authored (and `hive-settings` carries the OWNER's signed
 *     policy itself, EN-1; throttling it could choke policy propagation).
 */
export const NEVER_RATE_LIMITED_TABLE_TAGS: ReadonlySet<string> = new Set([
  'presence',
  'usage',
  'contributors',
  'hive-members',
  'hive-settings-by-key',
]);

/**
 * Human-authored CONTENT tables — a put here counts against BOTH `ops` and the
 * `rowsPerHour` cap (the "rows that land in the canonical hive" a flood produces).
 * Everything else not in NEVER_RATE_LIMITED (queue / working-set / claims /
 * item-assignments) counts against `ops` only (orchestration, not content rows).
 */
export const CONTENT_TABLE_TAGS: ReadonlySet<string> = new Set([
  'coord-messages',
  'coord-threads',
  'coord-thread-posts',
  'coord-conversations',
  'issues',
  'engineer-issues',
  'features-by-id',
  'plans-by-slug',
  'plan-parts',
]);

/**
 * The rate classes an op counts against. `[]` ⇒ never limited (ephemeral /
 * governance / unknown-table). A del counts only against `ops` (it adds no content
 * row); a content put counts against `ops` + `rows`. NOTE: `prs` is never produced
 * here — pull requests ride the CODE plane (git-sync → main), not the substrate.
 */
export function classifyOpRate(op: OpEnvelope): RateClass[] {
  const tag = op.table;
  if (!tag || NEVER_RATE_LIMITED_TABLE_TAGS.has(tag)) return [];
  if (op.type !== 'put' && op.type !== 'del') return [];
  const classes: RateClass[] = ['ops'];
  if (op.type === 'put' && CONTENT_TABLE_TAGS.has(tag)) classes.push('rows');
  return classes;
}

/**
 * A STABLE per-op identity for the limiter's re-fold idempotency. Built from the
 * unforgeable source-log key + table + key + ts + hlc, so the SAME op produces the
 * SAME id across folds (a cursor reset replays it), and distinct ops from one
 * author differ. The hlc (when present) makes two same-key writes at the same ms
 * distinct.
 */
export function buildOpId(op: OpEnvelope): string {
  const src = op.sourceLogKeyHex ?? op.writerPubkey ?? '';
  return `${src}|${op.table ?? ''}|${op.hbKey ?? ''}|${op.ts ?? ''}|${op.hlc ?? ''}`;
}

/** Origin of an op: `local` (own log / synthetic) ops are the operator's own
 *  writes and are never rate-limited; only `remote` member ops are. */
export function originOf(op: OpEnvelope, ownLogKeyHex: string): 'local' | 'remote' {
  if (op.sourceLogKeyHex === undefined) return 'local'; // synthetic / pre-merge op
  return op.sourceLogKeyHex === ownLogKeyHex ? 'local' : 'remote';
}

export interface RateDropInfo {
  authorId: number | null;
  /** The class that tripped, or 'unattributable' for a fail-closed drop. */
  cls: RateClass | 'unattributable';
  cap: number | null;
  table?: string;
  hbKey?: string;
}

export interface RateLimitedApplyDeps {
  /** The pure decider (one instance per booted harness). */
  limiter: MemberRateLimiter;
  /** This harness's own writable log keyHex — to detect (and skip) local ops. */
  ownLogKeyHex: string;
  /**
   * Resolve a remote op's source log key → the admitted author's github_user_id
   * via the admission map (`admittedIdentities`). Returns null when unresolvable
   * (⇒ fail-closed drop while a cap is in force).
   */
  resolveAuthorId: (sourceLogKeyHex: string) => number | null;
  /**
   * The CURRENT owner-set rate caps (the cached EN-1 `hive_policy.rate` snapshot),
   * or null when there is no policy / no rate caps. Synchronous — boot refreshes
   * the snapshot once per merge pass, not per op.
   */
  currentCaps: () => RateCaps | null;
  /** The underlying apply sink to wrap (boot's per-harness scopedApply). */
  apply: (op: OpEnvelope) => Promise<boolean>;
  /** Best-effort drop observer (boot-history / telemetry). Must not throw. */
  onDrop?: (info: RateDropInfo) => void;
}

/**
 * Build the rate-limited apply wrapper. Returns a drop-in replacement for the
 * `applyImpl` the merge driver calls per winning op. When no rate policy is in
 * force it is a pure passthrough.
 */
export function makeRateLimitedApply(
  deps: RateLimitedApplyDeps,
): (op: OpEnvelope) => Promise<boolean> {
  const { limiter, ownLogKeyHex, resolveAuthorId, currentCaps, apply, onDrop } = deps;

  const safeOnDrop = (info: RateDropInfo): void => {
    if (!onDrop) return;
    try {
      onDrop(info);
    } catch {
      // observability must never abort the apply
    }
  };

  return async (op: OpEnvelope): Promise<boolean> => {
    const caps = currentCaps();
    // No policy ⇒ no enforcement ⇒ passthrough (zero behavior change).
    if (!caps) return apply(op);

    // Local (own / synthetic) ops are the operator's own writes — never limited.
    if (originOf(op, ownLogKeyHex) === 'local') return apply(op);

    const classes = classifyOpRate(op);
    if (classes.length === 0) return apply(op); // ephemeral / governance / unknown

    // Are any of this op's classes actually capped? If not, skip (passthrough).
    const capped = classes
      .map((cls) => ({ cls, cap: capForClass(caps, cls) }))
      .filter((c) => c.cap !== undefined) as Array<{ cls: RateClass; cap: number }>;
    if (capped.length === 0) return apply(op);

    // A cap IS in force for this op's class(es). Attribute the author.
    const authorId = resolveAuthorId(op.sourceLogKeyHex!);
    if (authorId === null) {
      // FAIL-CLOSED: an unattributable op must not bypass an in-force cap.
      safeOnDrop({
        authorId: null,
        cls: 'unattributable',
        cap: capped[0]?.cap ?? null,
        table: op.table,
        hbKey: op.hbKey,
      });
      return false;
    }

    const outcome = limiter.decide(authorId, buildOpId(op), op.ts ?? 0, capped);
    if (outcome === 'drop') {
      // Conclusive drop (mirrors the slug-filter's `out_of_scope`): not merged,
      // never canonical. Report the tightest tripped class for observability.
      const tripped = capped[0];
      safeOnDrop({
        authorId,
        cls: tripped?.cls ?? 'ops',
        cap: tripped?.cap ?? null,
        table: op.table,
        hbKey: op.hbKey,
      });
      return false;
    }
    return apply(op);
  };
}
