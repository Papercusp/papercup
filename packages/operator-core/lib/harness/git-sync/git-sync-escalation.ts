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
import type { RepoError, ScopedOversized } from './run-git-sync';

/** Consecutive error ticks before the failure escalates (3 ticks ≈ 30 min). */
export const PUSH_FAILURE_ESCALATION_TICKS = 3;

export interface EscalationInput {
  status: 'nothing' | 'synced' | 'conflict' | 'error';
  /** This tick's consecutive-error count (already bumped/reset for this tick). */
  consecutiveErrorTicks: number;
  errors: RepoError[];
  oversized: ScopedOversized[];
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

export const oversizedKey = (f: ScopedOversized): string => `${f.scope}:${f.path}`;

export function decideGitSyncEscalation(i: EscalationInput): EscalationDecision {
  const reasons: EscalationReason[] = [];
  if (i.consecutiveErrorTicks >= PUSH_FAILURE_ESCALATION_TICKS) reasons.push('push-failure');
  if (i.oversized.length > 0) reasons.push('oversized-blobs');
  const escalate = reasons.length > 0;

  const parts: string[] = [];
  if (i.consecutiveErrorTicks === PUSH_FAILURE_ESCALATION_TICKS) {
    const detail = i.errors.map((e) => `${e.scope}: ${e.message.split('\n')[0]}`).join('; ').slice(0, 300);
    parts.push(
      `⚠ git-sync push has FAILED ${i.consecutiveErrorTicks} consecutive ticks — local commits are NOT reaching origin${detail ? ` (${detail})` : ''}`,
    );
  }
  const newOversized = i.oversized.filter((f) => !i.prevOversizedKeys.includes(oversizedKey(f)));
  if (newOversized.length > 0) {
    const list = newOversized
      .map((f) => `${f.scope === 'superproject' ? '' : `${f.scope}/`}${f.path} (${(f.sizeBytes / 1048576).toFixed(1)}MB)`)
      .join(', ')
      .slice(0, 400);
    parts.push(
      `⚠ git-sync EXCLUDED oversized file(s) from the auto-commit — they will never push (GitHub 100MB limit); gitignore or remove them: ${list}`,
    );
  }

  // A pass is only "clean" when nothing moved wrong AND no oversized files linger —
  // 'nothing' with oversized still has the unpushable file sitting in the tree.
  const clear = !escalate && (i.status === 'synced' || i.status === 'nothing');

  return { escalate, reasons, clear, broadcast: parts.length > 0 ? parts.join('\n') : null };
}
