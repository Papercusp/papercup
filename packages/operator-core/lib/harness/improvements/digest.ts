/**
 * Triage-digest for the papercusp self-improvement loop (Phase 2 —
 * papercusp-self-improvement-loop-2026-06-04). Pure logic over a set of captured
 * improvement candidates: it scores, dedups, and splits them into the **auto
 * lane** (kind=bug, no protected surface — D-004) vs the **human queue** (the
 * rest), producing a compact, human-reviewable digest. No implementing happens
 * here — Phase 2 is "triage only, earns trust cheaply with nothing auto-built."
 *
 * Dedup is best-effort surfacing, NOT a gate (D-001: search-first + cheap merge,
 * never machinery). A duplicate is flagged for a human/agent to merge, not
 * blocked.
 */

import {
  partitionByTier,
  type ImprovementCandidate,
  type ImprovementSeverity,
  type RiskTierPolicy,
  type Tier,
  type WorkItemKind,
  DEFAULT_RISK_TIER_POLICY,
} from './policy';

const SEVERITY_WEIGHT: Record<ImprovementSeverity, number> = {
  critical: 40,
  major: 25,
  minor: 12,
  nit: 4,
};
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoredItem {
  id: string;
  kind: WorkItemKind;
  title: string;
  scope: string;
  severity?: ImprovementSeverity;
  state?: string;
  assignee?: string | null;
  /** When the assignee claimed it — the dispatch loop's in-flight signal. */
  assignedAt?: string | null;
  /** Auto-implement dispatch attempts so far (anti-re-dispatch counter). */
  attempts?: number;
  tier: Tier;
  /** Priority score (higher = triage sooner). */
  score: number;
  ageDays: number;
  /** Why this tier — from the policy decision. */
  tierReason: string;
}

export interface DupCluster {
  /** The normalized signature the members share. */
  signature: string;
  ids: string[];
}

export interface ImprovementDigest {
  generatedAt: string;
  total: number;
  open: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
  byState: Record<string, number>;
  /** Open + auto-eligible (kind=bug, no protected surface), highest score first. */
  autoEligible: ScoredItem[];
  /** Open + human-tier, highest score first. */
  humanQueue: ScoredItem[];
  /** Groups of likely-duplicate candidates (open + resolved) for cheap merge. */
  likelyDuplicates: DupCluster[];
  /** One-line summary for a coord broadcast / notification. */
  headline: string;
}

export interface BuildDigestOptions {
  policy?: RiskTierPolicy;
  /** Now, in ms — passed for deterministic tests; the tool passes Date.now(). */
  nowMs?: number;
}

/** Normalize a title into a dedup signature: strip a leading `[kind]`, lowercase,
 *  drop punctuation, sort the remaining word-tokens (so word-order differences
 *  still collide). */
export function dedupSignature(title: string): string {
  const noKind = title.replace(/^\s*\[(bug|change|feature|research-task|chunk)\]\s*/i, '');
  const tokens = noKind
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2); // drop tiny stopword-ish tokens
  return [...new Set(tokens)].sort().join(' ');
}

function tokenSet(title: string): Set<string> {
  return new Set(dedupSignature(title).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Title similarity in [0,1] — token-set Jaccard over the dedup signature.
 *  Used by the capture tool's soft search-first dedup (D-001). */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenSet(a), tokenSet(b));
}

const NEAR_DUP_JACCARD = 0.8;

/** Cluster candidates that are likely duplicates (exact normalized-signature OR
 *  token-overlap ≥ NEAR_DUP_JACCARD). Best-effort surfacing for a cheap merge. */
export function findLikelyDuplicates(candidates: ImprovementCandidate[]): DupCluster[] {
  // 1. exact signature groups
  const bySig = new Map<string, string[]>();
  for (const c of candidates) {
    const sig = dedupSignature(c.title);
    if (!sig) continue;
    const arr = bySig.get(sig) ?? [];
    arr.push(c.id);
    bySig.set(sig, arr);
  }
  const clusters: DupCluster[] = [];
  const claimed = new Set<string>();
  for (const [signature, ids] of bySig) {
    if (ids.length > 1) {
      clusters.push({ signature, ids });
      ids.forEach((id) => claimed.add(id));
    }
  }
  // 2. near-dup pass (token overlap) over the not-yet-claimed
  const remaining = candidates.filter((c) => !claimed.has(c.id));
  for (let i = 0; i < remaining.length; i++) {
    if (claimed.has(remaining[i].id)) continue;
    const a = tokenSet(remaining[i].title);
    if (a.size === 0) continue;
    const group = [remaining[i].id];
    for (let j = i + 1; j < remaining.length; j++) {
      if (claimed.has(remaining[j].id)) continue;
      if (jaccard(a, tokenSet(remaining[j].title)) >= NEAR_DUP_JACCARD) {
        group.push(remaining[j].id);
        claimed.add(remaining[j].id);
      }
    }
    if (group.length > 1) {
      claimed.add(remaining[i].id);
      clusters.push({ signature: dedupSignature(remaining[i].title), ids: group });
    }
  }
  return clusters;
}

function inc(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function scoreOf(c: ImprovementCandidate, tier: Tier, ageDays: number): number {
  const sev = c.severity ? SEVERITY_WEIGHT[c.severity] : SEVERITY_WEIGHT.minor;
  // Age adds up to ~30 pts over a month (older = staler = triage sooner), capped.
  const age = Math.min(ageDays, 30);
  // A tiny nudge so the auto lane (verifiable, cheap to ship) floats up within a tier.
  const autoNudge = tier === 'auto' ? 3 : 0;
  return Math.round(sev + age + autoNudge);
}

/**
 * Build the triage digest from a set of candidates. Pure + deterministic given
 * `nowMs`. The auto/human split uses the risk-tier policy; only OPEN items are
 * queued (resolved/closed still count in the rollups + dedup).
 */
export function buildDigest(
  candidates: ImprovementCandidate[],
  opts: BuildDigestOptions = {},
): ImprovementDigest {
  const policy = opts.policy ?? DEFAULT_RISK_TIER_POLICY;
  const nowMs = opts.nowMs ?? Date.now();
  const { decisions } = partitionByTier(candidates, policy);

  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const autoEligible: ScoredItem[] = [];
  const humanQueue: ScoredItem[] = [];
  let open = 0;

  for (const c of candidates) {
    inc(byKind, c.kind);
    if (c.severity) inc(bySeverity, c.severity);
    inc(byState, c.state ?? 'open');
    const isOpen = (c.state ?? 'open') === 'open';
    if (isOpen) open += 1;

    const decision = decisions[c.id];
    const ageDays = c.createdAt ? Math.max(0, (nowMs - Date.parse(c.createdAt)) / DAY_MS) : 0;
    const scored: ScoredItem = {
      id: c.id,
      kind: c.kind,
      title: c.title,
      scope: c.scope,
      severity: c.severity,
      state: c.state,
      assignee: c.assignee ?? null,
      assignedAt: c.assignedAt ?? null,
      attempts: c.attempts ?? 0,
      tier: decision.tier,
      score: scoreOf(c, decision.tier, ageDays),
      ageDays: Math.round(ageDays * 10) / 10,
      tierReason: decision.reasons[decision.reasons.length - 1] ?? '',
    };
    // Only OPEN items go into the actionable queues.
    if (!isOpen) continue;
    (decision.tier === 'auto' ? autoEligible : humanQueue).push(scored);
  }

  const byScore = (a: ScoredItem, b: ScoredItem): number => b.score - a.score;
  autoEligible.sort(byScore);
  humanQueue.sort(byScore);

  const likelyDuplicates = findLikelyDuplicates(candidates);
  const generatedAt = new Date(nowMs).toISOString();
  const headline =
    `papercusp-improvement digest: ${candidates.length} captured (${open} open) — ` +
    `${autoEligible.length} auto-eligible, ${humanQueue.length} need a human` +
    (likelyDuplicates.length ? `, ${likelyDuplicates.length} likely-dup cluster(s)` : '');

  return {
    generatedAt,
    total: candidates.length,
    open,
    byKind,
    bySeverity,
    byState,
    autoEligible,
    humanQueue,
    likelyDuplicates,
    headline,
  };
}
