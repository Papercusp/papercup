/**
 * Risk-tier policy for the papercusp self-improvement loop
 * (papercusp-self-improvement-loop-2026-06-04, D-004 / D-005 / D-008 / Phase 4).
 *
 * Pure logic — no DB, no IO — so it is exhaustively unit-testable. It answers the
 * one per-item question the implement loop asks: **is this captured improvement
 * safe to AUTO-implement (no human approval), or must it wait for a human?**
 *
 * v1 (conservative, D-004): `kind=bug` → AUTO; every other kind + anything
 * touching the safety/deploy/loop machinery → HUMAN. "AUTO" means *no human
 * approval*, NOT *no gates* (D-005): an auto item still runs its blueprint
 * (validator/reviewer), needs green tests, and passes the Opus-4.8-xhigh
 * release-manager at deploy — which is the real backstop for the bootstrapping
 * hazard. This policy is the cheap *first* filter, not the last line of defence.
 *
 * Phase 4 (graduate) is a CONFIG change, not a code change: add a kind to
 * `autoKinds` (bug → change → feature) as each tier earns trust. The protected
 * path/keyword lists stay human-gated indefinitely (operator-core safety, the
 * deploy machinery, migrations, the loop itself — bootstrapping).
 */

/** Work-item kinds (forward-compatible with unify-work-items-2026-06-04 D-002). */
export type WorkItemKind = 'feature' | 'bug' | 'change' | 'research-task' | 'chunk';

export type ImprovementSeverity = 'critical' | 'major' | 'minor' | 'nit';
export type ImprovementState = 'open' | 'resolved' | 'closed';

/** The unit the loop reasons over — a captured improvement (an issue today, a
 *  work_item[kind=bug|change] after unify-work-items lands). Storage-agnostic. */
export interface ImprovementCandidate {
  id: string;
  kind: WorkItemKind;
  /** 'operator' | 'harness:<slug>' — per-Hive scope (P-010). */
  scope: string;
  title: string;
  body?: string;
  severity?: ImprovementSeverity;
  state?: ImprovementState;
  assignee?: string | null;
  /** When the current assignee claimed it (in-flight detection for the dispatch loop). */
  assignedAt?: string | null;
  createdAt?: string;
  /** Last lifecycle update (issue.updated_at) — for a resolved/closed item this is
   *  the resolution timestamp, which the recurrence-decay matcher reads as "when
   *  this signature last recurred / was last decided" (self-learning P-003). */
  updatedAt?: string;
  /** Optional one-line "already decided: <reason>" recall, surfaced when a NEW
   *  capture matches the stable signature of a prior resolved/closed item — so the
   *  loop recognises an already-decided friction instead of re-proposing it
   *  (self-learning P-003). Populated from payload.decidedReason when present. */
  decidedReason?: string;
  /** Known implementation paths, when available — supplied at capture
   *  (`improvements:capture { paths }`) or post-scoping. Feeds the
   *  protected-path gate (close-the-self-improvement-loop D-002). */
  paths?: string[];
  /** How many times the auto-implement loop has dispatched this item
   *  (payload.implementAttempts — the anti-re-dispatch counter, D-001). */
  attempts?: number;
  /** Explicitly routed to a human (improvements:resolve outcome 'needs-human',
   *  or auto-set when implement retries exhaust). Forces the human tier. */
  needsHuman?: boolean;
  /** Source role that filed this improvement (P-010 source-tag): Queen, bee, system, or human.
   *  Tracked for per-Hive analytics and topic lens. */
  sourceRole?: 'Queen' | 'bee' | 'system' | 'Scout' | 'human';
  /** The idea-lifecycle journey (payload.ideaLifecycle — self-learning P-030/P-031):
   *  open → triaged(place/gate/gym/reject) → applied → verified/recurred. Initialized
   *  at capture; written by triage-core, resolve-core, and the decay sweep. Items
   *  captured before the lifecycle landed have none (treated as 'open'). */
  ideaLifecycle?: import('./lifecycle').IdeaLifecyclePayload;
  /** Stable watchdog signal identity (payload.watchdogKey, '<source>:<key>' —
   *  watchdog-audit P-004). DIFFERENT keys = DIFFERENT signals even when the
   *  template titles token-collide (nested-path red-tests, per-tool errors) —
   *  dedup/hygiene must never merge across distinct keys. */
  watchdogKey?: string;
  /** Learning-signal provenance (frontier P-002/D-002): organic | drill | replay
   *  | shadow. Absent = organic (legacy rows / pre-column fakes). Candidates are
   *  already origin-filtered at the read seam (read-items.ts); this rides along
   *  for display + downstream decisions. */
  origin?: import('./provenance').SignalOrigin;
  /** Machine-readable finding class (payload.findingClass — frontier P-044/D-008):
   *  a stable `<miner>:<shape>` slug from the filing edge (e.g.
   *  `negative-space:resolution-gap`). The graduation tracker counts clean
   *  passes per class; absent on interactive/legacy captures. */
  findingClass?: string;
}

export type Tier = 'auto' | 'human';

export interface RiskTierPolicy {
  /**
   * Kinds eligible for AUTO-implementation (no human approval). **Graduation
   * (Phase 4) edits THIS** — bug → change → feature as trust is earned. Empty =
   * everything human-gated (a valid "pause auto" config).
   */
  autoKinds: WorkItemKind[];
  /**
   * Glob-ish repo-relative path patterns that force HUMAN even for an auto kind
   * — the safety/deploy/bootstrapping surfaces. `*` matches within a segment,
   * `**` matches across segments. Applied only when a candidate carries `paths`.
   */
  protectedPathPatterns: string[];
  /**
   * Title/body keywords (case-insensitive substring) that force HUMAN even for an
   * auto kind — the cheap pre-paths backstop for items whose blast radius is the
   * safety/deploy/security machinery. The release-manager at deploy is the real
   * guarantee (D-005); this just keeps obvious hazards out of the auto lane early.
   */
  protectedKeywords: string[];
}

/**
 * v1 policy (D-004): bug = auto, everything else = human; the safety/deploy/loop
 * machinery is human-gated regardless of kind (bootstrapping — D-006/D-008).
 */
export const DEFAULT_RISK_TIER_POLICY: RiskTierPolicy = {
  autoKinds: ['bug'],
  protectedPathPatterns: [
    // The deploy machinery (release gate) — never auto-touch what ships the fleet.
    'packages/operator-core/lib/release/**',
    'apps/operator/lib/release/**',
    // The scheduler / durable-workflow engine that runs the loop itself.
    'packages/operator-core/lib/dbos/**',
    'packages/operator-core/lib/harness/routines/**',
    // git-sync (commits + pushes the whole tree) + the lock authority.
    'packages/operator-core/lib/git-sync/**',
    'libs/papercusp/packages/locks/**',
    // Schema migrations — destructive/irreversible blast radius.
    'libs/papercusp/libs/db/sql/**',
    // The flag system (this loop's master switch lives here) + the loop's own code.
    'libs/flags/**',
    'packages/operator-core/lib/harness/improvements/**',
    'packages/operator-core/lib/agent-tools/improvements/**',
    // Auth / security surfaces.
    '**/auth/**',
    '**/credentials/**',
  ],
  protectedKeywords: [
    'migration',
    'deploy',
    'release gate',
    'release-gate',
    'git-sync',
    'operator-core safety',
    'auth',
    'credential',
    'rls',
    'security',
    'feature flag',
    // Autoloop safety-gate inventory (P-041 trust graduation): never auto-apply
    'dont-deploy-on-red',
    'budget cap',
    'quota cap',
    'auth perimeter',
    'double-allocate',
  ],
};

export interface TierDecision {
  tier: Tier;
  /** Human-readable trail of why this tier was chosen (for the digest + audit). */
  reasons: string[];
  /** The protected path-pattern or keyword that forced HUMAN, if any. */
  protectedHit?: string;
}

/** Minimal glob matcher: `**` → any (incl. `/`), `*` → any non-`/` run. */
export function matchGlob(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials (NOT * which we handle)
        .replace(/\*\*/g, ' ') // placeholder for **
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '.*') +
      '$',
  );
  return re.test(value);
}

/**
 * Classify a single candidate into its risk tier. The order is deliberate:
 *   0. explicit needs-human routing (improvements:resolve back-edge) → HUMAN.
 *   1. kind gate — not an auto kind → HUMAN immediately (the common case).
 *   2. protected paths (when known) → HUMAN (the safety surfaces).
 *   3. protected keywords (title+body) → HUMAN (the pre-paths proxy).
 *   4. otherwise → AUTO (still runs blueprint + tests + release-manager, D-005).
 */
export function classifyImprovement(
  c: ImprovementCandidate,
  policy: RiskTierPolicy = DEFAULT_RISK_TIER_POLICY,
): TierDecision {
  const reasons: string[] = [];

  if (c.needsHuman) {
    reasons.push('explicitly routed to a human (needs-human — set via improvements:resolve) → human');
    return { tier: 'human', reasons };
  }

  if (!policy.autoKinds.includes(c.kind)) {
    reasons.push(
      `kind=${c.kind} is not auto-eligible (autoKinds: [${policy.autoKinds.join(', ') || '∅'}]) → human`,
    );
    return { tier: 'human', reasons };
  }
  reasons.push(`kind=${c.kind} is auto-eligible`);

  for (const p of c.paths ?? []) {
    const hit = policy.protectedPathPatterns.find((pat) => matchGlob(pat, p));
    if (hit) {
      reasons.push(`touches protected path "${p}" (pattern ${hit}) → human`);
      return { tier: 'human', reasons, protectedHit: hit };
    }
  }

  const hay = `${c.title} ${c.body ?? ''}`.toLowerCase();
  const kw = policy.protectedKeywords.find((k) => hay.includes(k.toLowerCase()));
  if (kw) {
    reasons.push(`mentions protected keyword "${kw}" → human (the deploy gate is the real backstop)`);
    return { tier: 'human', reasons, protectedHit: kw };
  }

  reasons.push('no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)');
  return { tier: 'auto', reasons };
}

export interface TierPartition {
  auto: ImprovementCandidate[];
  human: ImprovementCandidate[];
  decisions: Record<string, TierDecision>;
}

/** Split a set of candidates into the auto lane vs the human queue. */
export function partitionByTier(
  candidates: ImprovementCandidate[],
  policy: RiskTierPolicy = DEFAULT_RISK_TIER_POLICY,
): TierPartition {
  const auto: ImprovementCandidate[] = [];
  const human: ImprovementCandidate[] = [];
  const decisions: Record<string, TierDecision> = {};
  for (const c of candidates) {
    const d = classifyImprovement(c, policy);
    decisions[c.id] = d;
    (d.tier === 'auto' ? auto : human).push(c);
  }
  return { auto, human, decisions };
}
