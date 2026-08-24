/**
 * Pure decision core for git-sync's failure escalation (EI-18).
 *
 * Background: git-sync escalated merge CONFLICTS (→ merge-resolver) but push
 * ERRORS only ever landed in routine metadata — on 2026-06-05 the push failed
 * silently every tick for ~20h (10.4GB of accumulated Rust target/ artifacts,
 * GitHub HTTP 500) with zero fleet-visible signal. This module decides, from one
 * tick's outcome + the previous tick's counters, whether to:
 *   - write/refresh a `git-sync-error` escalation row (repeated push failures
 *     and/or oversized-file exclusions — both need a human/agent),
 *   - clear it (a genuinely clean pass),
 *   - broadcast a coord message (TRANSITION-only, so a persistent condition
 *     doesn't spam every 10-min tick).
 *
 * Deliberately PG-free: `git-sync-action.ts` reads the previous counters from
 * the routine metadata, calls this, and applies the side effects.
 */
import {
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_COMMIT_TOTAL_BYTES,
  type RepoError,
  type ScopedOversized,
} from './run-git-sync';

/** Consecutive error ticks before the failure escalates (3 ticks ≈ 30 min).
 *  NOTE the name is historical: this counts ANY failing leg, not just pushes
 *  (EI-19275994927087666). */
export const PUSH_FAILURE_ESCALATION_TICKS = 3;

/** Which LEG of a git-sync tick failed (EI-19275994927087666). */
export type GitSyncFailingLeg = 'commit' | 'push' | 'conflict' | 'config-lock' | 'unknown';

/**
 * PURE: classify which leg actually failed, from the error text git-sync recorded.
 *
 * EI-19275994927087666: both the escalation broadcast and the /admin/git deploy
 * panel used to call EVERY git-sync failure a PUSH failure, and say "commits are
 * NOT reaching origin". That sentence sends a responder at origin / credentials /
 * the pooler. For 32h it was pointing at a corrupt git object in one abandoned
 * scratch pot's tree — a COMMIT-leg fault that never touched the network, while
 * origin/staging was byte-identical to local HEAD.
 *
 * `pushMode` is only a fallback inference: a `commit-only:*` member never pushes,
 * so its failure cannot be a push failure. It is checked LAST on purpose — the
 * real offender's push_mode was `push`, so push_mode alone would not have caught
 * it. The recorded error text is the load-bearing signal.
 */
export function classifyGitSyncFailingLeg(
  lastError: string | null,
  pushMode: string | null,
): GitSyncFailingLeg {
  const e = (lastError ?? '').toLowerCase();
  if (e.includes('conflict')) return 'conflict';
  if (e.includes('could not lock config file') && e.includes('config')) return 'config-lock';
  if (e.includes('commit failed') || e.includes('commit error')) return 'commit';
  if (e.includes('push')) return 'push';
  // No usable error text: a commit-only member still cannot have push-failed.
  if (pushMode?.startsWith('commit-only')) return 'commit';
  return 'unknown';
}

/** The human sentence for a failing leg. Only the 'push' arm may claim anything
 *  about origin — that claim was the whole misdirection. */
export function gitSyncLegPhrase(leg: GitSyncFailingLeg | null): string {
  switch (leg) {
    case 'push':
      return 'push failing — commits NOT reaching origin';
    case 'commit':
      return 'COMMIT failing — nothing has reached the push stage; origin is unaffected';
    case 'conflict':
      return 'merge conflict — needs a resolver';
    case 'config-lock':
      return 'submodule config-lock contention — canonical URL sync blocked locally; origin is unaffected';
    default:
      return "cause unclassified — read that routine's last_error";
  }
}

export interface EscalationInput {
  /** The harness/install slug whose git-sync tick produced this decision.
   * Broadcasts are fleet-global, so omitting this makes a sibling harness's
   * repo-relative paths and failure streak look like the caller's own. */
  installSlug: string;
  /** `skipped-locked` is intentionally neither a failure escalation nor a clean
   * pass: a live peer lock deferred work, so preserve any existing escalation
   * until a later measured sync/nothing outcome can clear it. */
  status: 'nothing' | 'synced' | 'conflict' | 'error' | 'skipped-locked';
  /** This tick's consecutive-error count (already bumped/reset for this tick). */
  consecutiveErrorTicks: number;
  errors: RepoError[];
  /** EI-19275994927087666: this member's push mode (`push` | `commit-only:*`), used
   *  only as a fallback when the error text alone cannot classify the failing leg.
   *  OPTIONAL on purpose — an omitted value just degrades to the error-text
   *  classification, so no existing caller or fixture has to change. */
  pushMode?: string | null;
  oversized: ScopedOversized[];
  /** Effective per-file dirty-byte limit used by this git-sync tick. */
  maxBlobBytes: number;
  /** Effective cumulative dirty-set limit used by this git-sync tick. */
  maxCommitTotalBytes: number;
  /** `scope:path` keys reported oversized on the PREVIOUS tick (from metadata). */
  prevOversizedKeys: string[];
}

export type EscalationReason = 'push-failure' | 'oversized-blobs';

export interface EscalationDecision {
  /** Write/refresh the `git-sync-error` escalation row this tick. */
  escalate: boolean;
  reasons: EscalationReason[];
  /** Clear the `git-sync-error` escalation row (clean pass, nothing wrong). */
  clear: boolean;
  /** Coord broadcast summary — non-null only on a TRANSITION (threshold reached /
   *  new oversized file appeared), never on a persisting condition. */
  broadcast: string | null;
}

const formatMegabytes = (bytes: number): string =>
  Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(1)}MB` : 'an unknown byte limit';

export const oversizedKey = (f: ScopedOversized): string => `${f.scope}:${f.path}`;

export function decideGitSyncEscalation(i: EscalationInput): EscalationDecision {
  const reasons: EscalationReason[] = [];
  if (i.consecutiveErrorTicks >= PUSH_FAILURE_ESCALATION_TICKS) reasons.push('push-failure');
  if (i.oversized.length > 0) reasons.push('oversized-blobs');
  const escalate = reasons.length > 0;

  const parts: string[] = [];
  if (i.consecutiveErrorTicks === PUSH_FAILURE_ESCALATION_TICKS) {
    const detail = i.errors.map((e) => `${e.scope}: ${e.message.split('\n')[0]}`).join('; ').slice(0, 300);
    // EI-19275994927087666: say WHICH leg failed. This used to hardcode "push has
    // FAILED … local commits are NOT reaching origin" for every failure, including
    // commit-leg faults that never reached the network.
    const leg = classifyGitSyncFailingLeg(i.errors.map((e) => e.message).join('; ') || null, i.pushMode ?? null);
    parts.push(
      `⚠ git-sync on ${i.installSlug} has FAILED ${i.consecutiveErrorTicks} consecutive ticks — ${gitSyncLegPhrase(leg)}${detail ? ` (${detail})` : ''}`,
    );
  }
  const newOversized = i.oversized.filter((f) => !i.prevOversizedKeys.includes(oversizedKey(f)));
  if (newOversized.length > 0) {
    const list = newOversized
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path} (${(f.sizeBytes / 1048576).toFixed(1)}MB)`)
      .join(', ')
      .slice(0, 400);
    const perFile = newOversized.filter((f) => f.exclusionReason !== 'cumulative-limit');
    const cumulative = newOversized.filter((f) => f.exclusionReason === 'cumulative-limit');
    const guards: string[] = [];
    if (perFile.length > 0) {
      guards.push(
        `${perFile.length} file(s) exceeded the configured per-file limit of ${formatMegabytes(i.maxBlobBytes)} ` +
          `(GitHub's individual-blob ceiling is 100MB)`,
      );
    }
    if (cumulative.length > 0) {
      guards.push(
        `the dirty set exceeded the configured cumulative limit of ${formatMegabytes(i.maxCommitTotalBytes)} ` +
          `(${cumulative.length} file(s) peeled; GitHub's 100MB ceiling applies to individual blobs, not this guard)`,
      );
    }
    parts.push(
      `⚠ git-sync on ${i.installSlug} EXCLUDED file(s) from the auto-commit — ${guards.join('; ')}; ` +
        `gitignore or remove them: ${list}`,
    );
  }

  // A pass is only "clean" when nothing moved wrong AND no oversized files linger —
  // 'nothing' with oversized still has the unpushable file sitting in the tree.
  const clear = !escalate && (i.status === 'synced' || i.status === 'nothing');

  return { escalate, reasons, clear, broadcast: parts.length > 0 ? parts.join('\n') : null };
}
