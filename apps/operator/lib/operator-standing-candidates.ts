/**
 * Standing-approval auto-upgrade detector (Phase 4e).
 *
 * After 3 silent dispatches of `(capability, target_harness)` within 24h,
 * surface the (capability, target) pair as a candidate for a standing
 * approval. The user promotes a candidate via the settings page, which
 * appends an `[OPERATOR-PROPOSED-USER-CONFIRMED-…] [STANDING-APPROVE]`
 * entry to preferences.md.
 *
 * Reads dispatch counts from `audit_log` rows written by `operator-audit.ts`.
 * Candidates are stored as a tiny JSON cache so the settings page can
 * render them without re-querying audit_log on every mount.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { papercuspPath } from './papercusp-root';
import { loadPreferences } from './operator-preferences';

const SILENT_DISPATCH_THRESHOLD = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function CANDIDATES_PATH() {
  return papercuspPath('system', 'operator', 'standing-candidates.json');
}

export interface StandingCandidate {
  capability: string;
  targetHarness: string;
  /** How many silent dispatches landed in the trailing 24h window. */
  count: number;
  /** ISO of the most recent qualifying dispatch. */
  lastSeenAt: string;
  /**
   * ISO of when this candidate was first surfaced in the UI. Required
   * non-null for `operator approve <slug>` voice eligibility per
   * voice-mode-plan-v4 §5d. Implementer note: each NEW candidate id
   * MUST start `null` — do NOT copy from a prior candidate with the
   * same (capability, targetHarness) pair. Re-proposed = user hasn't
   * seen this round.
   */
  firstShownAt: string | null;
}

export function readCandidates(): StandingCandidate[] {
  const p = CANDIDATES_PATH();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeCandidates(cands: StandingCandidate[]): void {
  const p = CANDIDATES_PATH();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cands, null, 2));
}

/**
 * Recompute candidates from audit_log. Called after each successful
 * dispatch. Cheap query — bounded by ~the last 24h of operator dispatches.
 */
export async function refreshCandidates(): Promise<StandingCandidate[]> {
  const workspaceId = activeWorkspaceId();
  const cutoffMs = Date.now() - WINDOW_MS;
  let rows: { details: { capability?: string; target?: string }; ts: number }[] = [];
  try {
    rows = await withWorkspace(workspaceId, async (tx) => {
      return tx<{ details: { capability?: string; target?: string }; ts: number }[]>`
        SELECT details, ts
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action = 'operator.dispatched'
           AND ts     >= ${cutoffMs}
      `;
    });
  } catch {
    return readCandidates();
  }

  const groups = new Map<string, { count: number; lastSeenMs: number; capability: string; target: string }>();
  for (const r of rows) {
    const cap = r.details?.capability;
    const target = r.details?.target;
    if (!cap || !target) continue;
    const key = `${cap}::${target}`;
    const cur = groups.get(key);
    if (cur) {
      cur.count++;
      if (r.ts > cur.lastSeenMs) cur.lastSeenMs = r.ts;
    } else {
      groups.set(key, { count: 1, lastSeenMs: r.ts, capability: cap, target });
    }
  }

  // Filter out (capability, target) pairs the user has already approved.
  const approved = new Set(
    loadPreferences().standingApprovals.map((a) => `${a.capability}::${a.targetHarness}`),
  );

  // Preserve firstShownAt across recomputations: if the same
  // (capability, targetHarness) pair already had a non-null
  // firstShownAt in the prior list, carry it forward. The plan §5d
  // implementer-comment exception: this preservation is keyed on
  // (cap, target) NOT on candidate id, so a re-proposed pair after a
  // dismissal carries forward only when the pair was previously shown.
  const prior = readCandidates();
  const priorShown = new Map<string, string>();
  for (const p of prior) {
    if (p.firstShownAt) priorShown.set(`${p.capability}::${p.targetHarness}`, p.firstShownAt);
  }

  const candidates: StandingCandidate[] = [];
  for (const [key, g] of groups) {
    if (g.count < SILENT_DISPATCH_THRESHOLD) continue;
    if (approved.has(key)) continue;
    candidates.push({
      capability: g.capability,
      targetHarness: g.target,
      count: g.count,
      lastSeenAt: new Date(g.lastSeenMs).toISOString(),
      firstShownAt: priorShown.get(key) ?? null,
    });
  }

  writeCandidates(candidates);
  return candidates;
}

/**
 * Mark a candidate as having been shown in the UI (sets firstShownAt
 * to now, idempotent — only sets if currently null). Settings page
 * calls this when rendering a candidate row for the first time.
 *
 * Voice-approve eligibility (per v4 §2f) requires firstShownAt to be
 * non-null, so the user can only voice-grant something they've actually
 * seen.
 */
export function markCandidateShown(capability: string, targetHarness: string): void {
  const all = readCandidates();
  let changed = false;
  for (const c of all) {
    if (c.capability === capability && c.targetHarness === targetHarness && !c.firstShownAt) {
      c.firstShownAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeCandidates(all);
}
