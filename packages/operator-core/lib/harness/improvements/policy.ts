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

import { DETERMINISTIC_EXECUTOR_TCB_PATTERNS } from '../../blueprint-steps/tcb';
import { CAPABILITY_DISPATCH_TCB_PATTERNS } from '../../capability-envelope/tcb';
import type { LifecycleState } from '@papercusp/coordination/capabilities';

/** Work-item kinds (forward-compatible with unify-work-items-2026-06-04 D-002). */
export type WorkItemKind = 'feature' | 'bug' | 'change' | 'chunk';

export type ImprovementSeverity = 'critical' | 'major' | 'minor' | 'nit';
// Canonical lifecycle vocabulary (P-007) — one definition across all ObjectRefs.
export type ImprovementState = LifecycleState;

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
  /** Who FILED this candidate (engineer_issues.created_by) — the filer's ownerId.
   *  The "distinct authors" axis for Scout's rubric-gap detection (plan-templates-
   *  and-rubric-v2 P-008): a recurring cluster spanning ≥N distinct authors is a
   *  stronger gap signal than one author repeating. Absent on legacy rows that
   *  predate created_by capture. */
  createdBy?: string | null;
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
  /** The structured-observation v2 view (rubric-driven-observations-2026-06-20
   *  P-001 / D-003), surfaced from payload.observation for observation-lane rows:
   *  { kind, scope, confidence, refs, sourceHive, targetHive, rubricRef, ratings }.
   *  Lets the Scout corpus-digest (P-006) group by rubricRef/sourceHive + surface
   *  rubric ratings WITHOUT re-reading the raw payload. Absent on non-observation /
   *  free-text rows. */
  observation?: import('./observation-types').StructuredObservation;
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
    // The loop's governance rails (frontier P-049): the learning-spend budget
    // machinery (D-004 — an auto-edit could un-make the refuse-unattended rule)
    // and the behavior-change ledger (D-003 — the one mutation-attribution rail).
    'packages/operator-core/lib/learning-governor/**',
    'packages/operator-core/lib/change-ledger/**',
    // Auth / security surfaces.
    '**/auth/**',
    '**/credentials/**',
    // The deterministic-blueprint executor TCB (deterministic-blueprints-migration
    // P-141 / agent-capability-confinement D-007): the spine executor + the
    // deterministic-step runner cannot graduate their own permissions — an
    // auto-edit to the dispatch/validation/runner code stays human-gated under any
    // graduation dial. Declared in blueprint-steps/tcb.ts; pinned by
    // tcb-invariants.test.ts. (The durable executor + spawn chokepoint are already
    // covered above by `dbos/**`; the routine cadence layer by `harness/routines/**`.)
    ...DETERMINISTIC_EXECUTOR_TCB_PATTERNS,
    // The capability dispatch GATE TCB (agent-capability-confinement P-030 / D-007):
    // once the fleet is confined, every capability flows through one chokepoint —
    // the envelope PDP, the decision-ledger, the host wiring, the dispatch stack,
    // and the gated capability tools. The gate cannot graduate its own permissions,
    // so an auto-edit to any of it stays human-gated under every graduation dial.
    // Declared in capability-envelope/tcb.ts; pinned by
    // capability-envelope/tcb-invariants.test.ts.
    ...CAPABILITY_DISPATCH_TCB_PATTERNS,
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

/** Per-call classification options (queen-autonomy-and-selffeed-fix Phase 2). */
export interface ClassifyOptions {
  /**
   * The OWNER FULL-AUTONOMY grant (`FLAGS.QUEEN_FULL_AUTONOMY`). When true, the
   * self-improvement loop's protected-path/keyword TCB bars are LIFTED — a kind=bug
   * touching the deploy gate / flags / capability dispatch / migrations / the loop's
   * own code becomes auto-eligible (the owner accepted the recursive-self-improvement
   * boundary). The needs-human routing, the kind gate (autoKinds — a SEPARATE Phase-4
   * dial, unchanged here), and the infra-environment gate (a worker cannot fix a down
   * service regardless) still apply. The auto lane STILL runs blueprint + tests + the
   * release-manager at deploy (D-005), and is STILL separately gated by
   * IMPROVEMENT_AUTO_IMPLEMENT (default OFF). REVERSIBLE: clearing the grant restores
   * the bars verbatim.
   */
  ownerFullAutonomy?: boolean;
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

// ── infra-environment detection (D-002/D-005: infra failures escalate, never auto) ──
//
// The SINGLE source of truth for "is this an environment problem a code-fix worker
// cannot touch?" — owned here (the safety layer) and re-used by the triage taxonomy
// (triage.ts re-exports these + classifyIdeaType keys its infra-environment leg off
// `infraEnvironmentHit`). Living here is what lets `classifyImprovement` consult it
// so an infra-classed kind=bug never reaches tier=auto (EI-408): the verdict chain
// stays policy-first (D-003) instead of the infra knowledge existing only at triage.

/**
 * Watchdog signal sources whose class is INFRA-ENVIRONMENT (D-002: escalate, never
 * auto). Shared vocabulary with the known-open aging escalation's infra-class
 * (D-004 — the shorter aging threshold keys off the same set). PROPOSED (P-004).
 */
export const INFRA_SIGNAL_SOURCES: readonly string[] = [
  'service-down',
  'fire-circuit-open',
  'migration-drift',
  // EI-5994: a dead-owner engine loop (loop:arm) parked with no completion signal is an
  // environment/session-liveness fact (the owner's process/wake-channel died), not a
  // product idea a worker can code-fix — misrouting it to ideaType:product/triageDecision:place
  // was the second half of the mis-triage this closes.
  'loop-stalled',
];

/** Paths that mean the fix lives in the ENVIRONMENT, not papercusp code. PROPOSED (P-004). */
export const INFRA_PATH_PATTERNS: readonly string[] = [
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*',
  '**/docker-compose*',
  '**/*.service',
  '**/systemd/**',
  '.env*',
  '**/.env*',
  'infra/**',
];

/** The signal class of a watchdogKey ('<source>:<key>') — '' when absent/malformed. */
export function watchdogSourceOf(watchdogKey: string | undefined): string {
  if (!watchdogKey) return '';
  const i = watchdogKey.indexOf(':');
  return i > 0 ? watchdogKey.slice(0, i) : '';
}

/**
 * Whether a candidate is an infra/environment problem — keyed off the watchdog
 * signal class (the strongest key: a service-down or circuit-open firing IS an
 * environment fact) with infra paths as the fallback. Returns a short human-readable
 * hit string (for the reason trail) or null. Pure — both `classifyImprovement`
 * (safety tier) and `classifyIdeaType` (routing taxonomy) consume it (D-003).
 */
export function infraEnvironmentHit(c: Pick<ImprovementCandidate, 'watchdogKey' | 'paths'>): string | null {
  const source = watchdogSourceOf(c.watchdogKey);
  if (INFRA_SIGNAL_SOURCES.includes(source)) return `watchdog signal class "${source}"`;
  // An EXTERNAL provider rate-limit (the `:rate-limit` tool-error class — OpenAI embed TPM
  // 429, etc.) is CAPACITY, not a code bug: route to infra-environment (owner-escalate,
  // never the auto-implement lane), since a worker cannot fix a provider quota
  // (watchdog-and-exposed-systems-improvement-2026-06-18 P-010). The class is the
  // watchdogKey SUFFIX, not its source segment, so INFRA_SIGNAL_SOURCES misses it.
  if (c.watchdogKey && /:rate-limit$/.test(c.watchdogKey)) return 'external provider rate-limit (capacity)';
  const infraPath = (c.paths ?? []).find((p) => INFRA_PATH_PATTERNS.some((pat) => matchGlob(pat, p)));
  if (infraPath) return `path "${infraPath}"`;
  return null;
}

/**
 * Classify a single candidate into its risk tier. The order is deliberate:
 *   0. explicit needs-human routing (improvements:resolve back-edge) → HUMAN.
 *   1. kind gate — not an auto kind → HUMAN immediately (the common case).
 *   2. infra-environment (D-002/D-005) → HUMAN (a worker cannot fix a port mapping).
 *   3. protected paths (when known) → HUMAN (the safety surfaces).
 *   4. protected keywords (title+body) → HUMAN (the pre-paths proxy).
 *   5. otherwise → AUTO (still runs blueprint + tests + release-manager, D-005).
 */
export function classifyImprovement(
  c: ImprovementCandidate,
  policy: RiskTierPolicy = DEFAULT_RISK_TIER_POLICY,
  opts: ClassifyOptions = {},
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

  // Infra-environment never auto (D-002/D-005): a code-fix worker cannot fix a
  // down service / port mapping / migration drift. The infra knowledge lives in
  // the signal class + paths (not the kind), so an infra kind=bug (EI-187
  // service-down) would otherwise slip into the auto lane and burn dispatch
  // attempts on something no worker can resolve (EI-408). NOT lifted by the
  // full-autonomy grant: it is a "wrong tool" bar (a worker literally cannot fix it),
  // not a safety bar — auto-dispatching it would just burn attempts.
  const infraHit = infraEnvironmentHit(c);
  if (infraHit) {
    reasons.push(`infra-environment (${infraHit}) — D-002/D-005: infra failures escalate, never auto → human`);
    return { tier: 'human', reasons, protectedHit: infraHit };
  }

  // The OWNER FULL-AUTONOMY grant (queen-autonomy-and-selffeed-fix Phase 2) LIFTS the
  // protected-path + protected-keyword TCB bars — the owner accepted the recursive-
  // self-improvement boundary (the auto-implement loop may edit + ship the deploy gate,
  // flags, capability dispatch, migrations, and its own code). REVERSIBLE: clearing the
  // grant restores the bars. The auto lane still runs blueprint + tests + the release-
  // manager at deploy (D-005), and is still separately gated by IMPROVEMENT_AUTO_IMPLEMENT.
  if (!opts.ownerFullAutonomy) {
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
  } else {
    reasons.push(
      'owner full-autonomy grant — protected-path/keyword TCB bars LIFTED (recursive-self-improvement boundary; still gated by blueprint + tests + release-manager)',
    );
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
  opts: ClassifyOptions = {},
): TierPartition {
  const auto: ImprovementCandidate[] = [];
  const human: ImprovementCandidate[] = [];
  const decisions: Record<string, TierDecision> = {};
  for (const c of candidates) {
    const d = classifyImprovement(c, policy, opts);
    decisions[c.id] = d;
    (d.tier === 'auto' ? auto : human).push(c);
  }
  return { auto, human, decisions };
}
