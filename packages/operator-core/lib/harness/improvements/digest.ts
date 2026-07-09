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
import { classifyIdeaType, type IdeaType } from './triage';

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
  /** Last lifecycle update (issue.updated_at) — bumped by ANY claim/release/state
   *  change, including a cross-lane touch that clears assignee without ever
   *  going through the auto-implement dispatch loop (EI-8385: the interactive
   *  backlog-drain fleet claiming + releasing an item the auto-implement lane
   *  has an open dispatch on). Used for the short post-touch cooldown below —
   *  `assignedAt` alone goes stale the instant such a claim is released. */
  updatedAt?: string | null;
  /** Auto-implement dispatch attempts so far (anti-re-dispatch counter). */
  attempts?: number;
  tier: Tier;
  /** Priority score (higher = triage sooner). */
  score: number;
  ageDays: number;
  /** Why this tier — from the policy decision. */
  tierReason: string;
  /** Idea type — the D-005 routing taxonomy (consume-edges P-021). */
  ideaType?: IdeaType;
  /** Idea-lifecycle state (payload.ideaLifecycle.state) — undefined for legacy
   *  captures. The scheduled triage pass picks untriaged items off this. */
  ideaLifecycleState?: import('./lifecycle').IdeaLifecycleState;
  /** The Queen's (or the scheduled pass's) recorded type-route, when triaged. */
  triageDecision?: 'place' | 'gate' | 'gym' | 'reject';
  /** Who filed it (payload.sourceRole, P-010): 'Scout' | 'Queen' | 'bee' | 'system';
   *  undefined = human/legacy. Drives the Learning tab's source filter. */
  source?: string;
}

export interface DupCluster {
  /** The normalized signature the members share. */
  signature: string;
  ids: string[];
}

/**
 * Recurrence-decay over a STABLE friction signature (self-learning-central P-003,
 * D-003). The keystone is the same normalized-signature + Jaccard matcher the
 * dedup uses — NOT raw title text — so re-encountered friction collides even when
 * the wording differs. For one signature we count how often it recurred and how
 * long since it last did:
 *
 *   - `count` — how many captures share this signature (recurrence strength).
 *   - `lastSeenMs` — the most recent capture/update of the signature.
 *   - `decayDays` — days since `lastSeenMs`. The recurrence-decay OUTCOME signal
 *     (D-003): a signature that stopped recurring is a WEAK *negative* — "the
 *     friction may have stopped" — fine for the broad product/local class, too
 *     weak alone for the process/prompt class (that class earns the gym's
 *     positive A/B). This struct exposes the raw decay; the consumer applies the
 *     class-specific weight.
 *   - `openCount` / `resolvedCount` — split so a still-open recurring signature
 *     (active friction) reads differently from a resolved one (probably handled).
 */
export interface SignatureRecurrence {
  signature: string;
  count: number;
  openCount: number;
  resolvedCount: number;
  /** Member ids, newest-first. */
  ids: string[];
  lastSeenMs: number;
  decayDays: number;
}

/**
 * The "already decided: <reason>" recall (self-learning-central P-003). When a
 * NEW friction is captured, the loop should recognise it if the SAME stable
 * signature was already decided (resolved/closed) — so it doesn't re-propose a
 * settled question. This is the recall hit for one candidate title.
 */
export interface AlreadyDecidedRecall {
  /** The prior decided item that matches the signature. */
  id: string;
  title: string;
  state: string;
  /** Exact normalized-signature match, or a near-dup (Jaccard ≥ threshold). */
  matchKind: 'signature' | 'near-dup';
  similarity: number;
  /** The recall line: "already decided: <reason>" when a durable reason was recorded. */
  reason?: string;
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
  /**
   * Recurring friction signatures (P-003) — every signature seen more than once,
   * recurrence + decay attached. The Queen reads this to weight a *recurring*
   * friction up and to spot one that has decayed (stopped recurring). Keyed on the
   * stable signature, so re-worded re-encounters collide. Sorted recurrence desc.
   */
  recurringSignatures: SignatureRecurrence[];
  /** One-line summary for a coord broadcast / notification. */
  headline: string;
}

export interface BuildDigestOptions {
  policy?: RiskTierPolicy;
  /** Now, in ms — passed for deterministic tests; the tool passes Date.now(). */
  nowMs?: number;
  /**
   * The OWNER FULL-AUTONOMY grant (`FLAGS.QUEEN_FULL_AUTONOMY`, Phase 2). When true the
   * tier split lifts the protected-path/keyword TCB bars (see {@link classifyImprovement}),
   * so a protected-surface kind=bug lands in the auto lane. The IO boundary reads the flag;
   * defaults off (today's classification). Display surfaces that omit it render the baseline.
   */
  ownerFullAutonomy?: boolean;
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

/** Above this candidate count the O(n²) near-dup pass is skipped (exact-signature
 *  clusters are still returned). Dedup is best-effort surfacing, NOT a gate
 *  (D-001), so degrading to exact-signature-only on a pathological backlog is safe
 *  — and it keeps findLikelyDuplicates off the operator event loop's critical path
 *  (round-4 P-001: the near-dup pass recomputed tokenSet() ~n²/2 times → a
 *  regex+sort+alloc storm + GC churn that saturated the loop at a 775+ backlog). */
const NEAR_DUP_MAX_CANDIDATES = 4000;

/** Cluster candidates that are likely duplicates (exact normalized-signature OR
 *  token-overlap ≥ NEAR_DUP_JACCARD). Best-effort surfacing for a cheap merge. */
export function findLikelyDuplicates(candidates: ImprovementCandidate[]): DupCluster[] {
  // 1. exact signature groups — compute each signature ONCE (reused in step 2).
  const bySig = new Map<string, string[]>();
  const sigById = new Map<string, string>();
  for (const c of candidates) {
    const sig = dedupSignature(c.title);
    sigById.set(c.id, sig);
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
  // 2. near-dup pass (token overlap) over the not-yet-claimed.
  const remaining = candidates.filter((c) => !claimed.has(c.id));
  // Bound: above NEAR_DUP_MAX_CANDIDATES skip the O(n²) pass (best-effort, D-001)
  // so a pathological backlog can't peg the event loop.
  if (remaining.length > NEAR_DUP_MAX_CANDIDATES) return clusters;
  // Precompute each token set ONCE. The previous implementation recomputed
  // tokenSet() (regex strip + lowercase + split + sort + Set alloc) inside the
  // inner loop — ~n²/2 heavy calls — which dominated the operator-loop CPU + GC at
  // a 775+ backlog (round-4 P-001, cpuprofile-attributed). The inner loop is now a
  // cheap set intersection over the prebuilt sets; results are unchanged.
  const tokenSets = remaining.map((c) => tokenSet(c.title));
  for (let i = 0; i < remaining.length; i++) {
    if (claimed.has(remaining[i].id)) continue;
    const a = tokenSets[i];
    if (a.size === 0) continue;
    const group = [remaining[i].id];
    for (let j = i + 1; j < remaining.length; j++) {
      if (claimed.has(remaining[j].id)) continue;
      if (jaccard(a, tokenSets[j]) >= NEAR_DUP_JACCARD) {
        group.push(remaining[j].id);
        claimed.add(remaining[j].id);
      }
    }
    if (group.length > 1) {
      claimed.add(remaining[i].id);
      clusters.push({ signature: sigById.get(remaining[i].id) ?? dedupSignature(remaining[i].title), ids: group });
    }
  }
  return clusters;
}

/** The most recent activity timestamp for a candidate (resolution time when
 *  resolved/closed, else creation). The recurrence-decay clock. */
function lastSeenMsOf(c: ImprovementCandidate): number {
  const ts = c.updatedAt ?? c.createdAt;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Compute recurrence-decay per stable signature (P-003). Groups every candidate
 * by `dedupSignature` (the same matcher the dedup + recall use), then for each
 * signature reports recurrence strength + decay. Sorted by recurrence count desc,
 * then freshest-first — the most-recurring, most-recent friction surfaces first.
 */
export function signatureRecurrence(
  candidates: ImprovementCandidate[],
  opts: { nowMs?: number } = {},
): SignatureRecurrence[] {
  const nowMs = opts.nowMs ?? Date.now();
  const bySig = new Map<string, ImprovementCandidate[]>();
  for (const c of candidates) {
    const sig = dedupSignature(c.title);
    if (!sig) continue;
    const arr = bySig.get(sig) ?? [];
    arr.push(c);
    bySig.set(sig, arr);
  }
  const out: SignatureRecurrence[] = [];
  for (const [signature, members] of bySig) {
    const sorted = [...members].sort((a, b) => lastSeenMsOf(b) - lastSeenMsOf(a));
    const lastSeenMs = sorted.length ? lastSeenMsOf(sorted[0]) : 0;
    const openCount = members.filter((m) => (m.state ?? 'open') === 'open').length;
    const resolvedCount = members.length - openCount;
    out.push({
      signature,
      count: members.length,
      openCount,
      resolvedCount,
      ids: sorted.map((m) => m.id),
      lastSeenMs,
      decayDays: lastSeenMs ? Math.round(((nowMs - lastSeenMs) / DAY_MS) * 10) / 10 : 0,
    });
  }
  return out.sort((a, b) => b.count - a.count || b.lastSeenMs - a.lastSeenMs);
}

/**
 * "Already decided" recall (P-003). Given a candidate title and the set of PRIOR
 * candidates, surface decided (resolved/closed) items whose STABLE signature
 * matches — exact normalized-signature first, then a near-dup Jaccard pass — so a
 * new capture of a settled friction is recognised before it re-enters the queue.
 * Returns the strongest matches first. Reads the signature, never raw title.
 */
export function recallAlreadyDecided(
  title: string,
  prior: ImprovementCandidate[],
  opts: { minSimilarity?: number; excludeId?: string } = {},
): AlreadyDecidedRecall[] {
  const minSim = opts.minSimilarity ?? NEAR_DUP_JACCARD;
  const sig = dedupSignature(title);
  if (!sig) return [];
  const tokens = tokenSet(title);
  const hits: AlreadyDecidedRecall[] = [];
  for (const c of prior) {
    if (opts.excludeId && c.id === opts.excludeId) continue;
    const state = c.state ?? 'open';
    if (state === 'open') continue; // only ALREADY-DECIDED (resolved/closed) items recall
    const candSig = dedupSignature(c.title);
    if (!candSig) continue;
    const exact = candSig === sig;
    const sim = exact ? 1 : jaccard(tokens, tokenSet(c.title));
    if (!exact && sim < minSim) continue;
    hits.push({
      id: c.id,
      title: c.title,
      state,
      matchKind: exact ? 'signature' : 'near-dup',
      similarity: Math.round(sim * 100) / 100,
      ...(c.decidedReason ? { reason: `already decided: ${c.decidedReason}` } : {}),
    });
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
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
  const { decisions } = partitionByTier(candidates, policy, {
    ...(opts.ownerFullAutonomy !== undefined ? { ownerFullAutonomy: opts.ownerFullAutonomy } : {}),
  });

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
    // Full-fidelity classification (D-005): the candidate carries paths +
    // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
    const { type: ideaType } = classifyIdeaType(c);
    const scored: ScoredItem = {
      id: c.id,
      kind: c.kind,
      title: c.title,
      scope: c.scope,
      severity: c.severity,
      state: c.state,
      assignee: c.assignee ?? null,
      assignedAt: c.assignedAt ?? null,
      updatedAt: c.updatedAt ?? null,
      attempts: c.attempts ?? 0,
      tier: decision.tier,
      score: scoreOf(c, decision.tier, ageDays),
      ageDays: Math.round(ageDays * 10) / 10,
      tierReason: decision.reasons[decision.reasons.length - 1] ?? '',
      ideaType,
      ...(c.ideaLifecycle ? { ideaLifecycleState: c.ideaLifecycle.state } : {}),
      ...(c.ideaLifecycle?.triageDecision ? { triageDecision: c.ideaLifecycle.triageDecision } : {}),
      ...(c.sourceRole ? { source: c.sourceRole } : {}),
    };
    // Only OPEN items go into the actionable queues.
    if (!isOpen) continue;
    (decision.tier === 'auto' ? autoEligible : humanQueue).push(scored);
  }

  const byScore = (a: ScoredItem, b: ScoredItem): number => b.score - a.score;
  autoEligible.sort(byScore);
  humanQueue.sort(byScore);

  const likelyDuplicates = findLikelyDuplicates(candidates);
  // Recurrence-decay on the stable signature (P-003) — only the signatures that
  // actually recurred (count > 1) are interesting for triage.
  const recurringSignatures = signatureRecurrence(candidates, { nowMs }).filter((s) => s.count > 1);
  const generatedAt = new Date(nowMs).toISOString();
  const headline =
    `papercusp-improvement digest: ${candidates.length} captured (${open} open) — ` +
    `${autoEligible.length} auto-eligible, ${humanQueue.length} need a human` +
    (likelyDuplicates.length ? `, ${likelyDuplicates.length} likely-dup cluster(s)` : '') +
    (recurringSignatures.length ? `, ${recurringSignatures.length} recurring signature(s)` : '');

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
    recurringSignatures,
    headline,
  };
}
