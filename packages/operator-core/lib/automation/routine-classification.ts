/**
 * Routine classification — the four axes the owner-facing automation panes sort
 * on (agents-system-pane-split-2026-07-26 P-001).
 *
 * WHY THIS EXISTS (owner, 2026-07-26): "Is everything in the agents tab an LLM?"
 * No. Of the 140 non-loop schedules in this workspace, 55 spawn a model and 85 are
 * deterministic sweeps — git commits, GC, canary probes, outbox drains — sitting in
 * a tab called "Agents" with equal visual weight to the things spending the owner's
 * weekly limit. The panes now split on that line, so this module has to answer it
 * correctly.
 *
 * ⚠ CLASSIFY BY `target_role`, NEVER BY THE ROUTINE NAME (D-001). The predecessor
 * of this module was `AGENT_SPAWNING_PATTERNS` in catalog.ts — a list of regexes
 * matched against the routine's NAME. A name is a label; `target_role` is the
 * handler the routines engine actually dispatches to, so it is the only thing that
 * knows whether a model runs. The regex was wrong in both directions, and its
 * output was load-bearing (it drove the "tokens" flag the owner used to decide what
 * to pause). Two demonstrated failures, both fixed by this table:
 *
 *   • `wake-brain` was flagged as a token spender by `/(^|-)wake($|-)/` — and its
 *     handler is `async (ctx) => { void ctx; }`, a retired tombstone kept registered
 *     so old rows don't fail with "unknown action" (wake-brain-action.ts). It cannot
 *     spend anything. It is `none` here.
 *   • `/^improvement-(implement|triage|watchdog|human-digest|invalid-args-miner)$/`
 *     flagged FIVE routines. Exactly one — `improvement-implement` — returns
 *     `durableSpawns`. `-triage` explicitly "never dispatches — it only records
 *     routing metadata"; `-watchdog` and `-invalid-args-miner` are SQL passes;
 *     `-human-digest` ranks and sends. Four false positives.
 *
 * ⚠ KEEP THIS FILE RUNTIME-IMPORT-FREE. The left-rail tabs import these as VALUES,
 * and their bundle is a browser bundle — the same constraint that forced
 * pane-categories.ts out of catalog.ts (which top-level-imports a Postgres client).
 * Types are erased; values are not.
 *
 * ⚠ AND KEEP IT A STATIC TABLE, not a field read off the live system-action
 * registry (D-002). Reading `listSystemActions()` at request time would couple a
 * request-serving projection to whether the BACKGROUND registry happens to be
 * loaded in this process — exactly the class of bug where a request-only staging
 * host silently reports an empty projection. The table cannot drift instead because
 * `routine-classification.registry.test.ts` enumerates the live registry and fails
 * if the two disagree in either direction.
 */

/** Does a fire of this routine cause model turns to be billed? */
export type RoutineSpend = 'llm' | 'none';

/**
 * What FIRES the row — the mechanism, not the subject.
 *
 * `triggered` is the one that did not exist before and is why the panes used to
 * show a padlock with no explanation: `doc-freshness-sweep` and
 * `doc-steward-dispatch` are neither schedules nor timers. They are function calls
 * at the end of every git-sync (SYNC_TRIGGERED_SWEEPS in schedule-inventory.ts), so
 * "runs as an in-process schedule" — the tooltip they used to get — was simply
 * false. A triggered row names its trigger instead of faking a cadence.
 */
export type RoutineKind = 'scheduled' | 'triggered' | 'loop';

/**
 * Is it actually going to run again?
 *
 * `stalled` is the state `active` alone cannot express, and its absence is the
 * defect the owner spotted: 15 loop rows are `active = true` with
 * `next_fire_at = 'infinity'` — armed, never firing again because the owning
 * session is long gone. `loop-su-d93ac1bf-…` read as healthy in the pane while
 * having last fired five days earlier.
 */
export type RoutineLiveness = 'running' | 'stalled' | 'dormant';

/**
 * Where this row's on/off switch actually lives.
 *
 * Replaces the old `controllable: boolean`, whose false case rendered a padlock
 * that meant four different things at once ("it's a DBOS workflow" / "it's a
 * managed timer" / "it's a git-sync hook" / "its switch is a feature flag"). The
 * `flag` case is the one that was costing a real control: `doc-steward-dispatch`'s
 * armed state IS the `papercusp-doc-steward` flag, which the inventory already
 * resolves — the pane just had no way to say so.
 */
export type RoutineControl = 'routine' | 'flag' | 'none';

/** The subject grouping for the secondary browse-by-family view. */
export type RoutineFamily =
  | 'loops'
  | 'wake'
  | 'learning'
  | 'docs'
  | 'git-release'
  | 'cleanup'
  | 'health'
  | 'federation';

export interface SpendEntry {
  spend: RoutineSpend;
  /** One line, shown as the row's tooltip — why this is or isn't a spender. */
  why: string;
}

/**
 * `system:loop-wake` is a SENTINEL target_role, not a registered handler: the DBOS
 * fire recognises a loop by `reschedule_interval_sec IS NOT NULL` + `target_owner_id`
 * and delivers a `coord:send {wake}` to the owner rather than running an action
 * inline (loop.ts LOOP_WAKE_ACTION). It therefore never appears in
 * `listSystemActions()`, and the registry cross-check must exempt it.
 */
export const SENTINEL_TARGET_ROLES: readonly string[] = ['system:loop-wake'];

/**
 * `system:<action>` → does firing it bill a model?
 *
 * The rule for `llm`: a fire can DIRECTLY cause billed model turns — it spawns an
 * agent, launches a session, wakes one (a wake costs a turn), or queues work that
 * is immediately dispatched to the autonomous pipeline. Filing a work-item a human
 * or an already-running loop may later pick up is NOT `llm`; the question the pane
 * answers is "if I pause this, does spending stop?".
 */
export const TARGET_ROLE_SPEND: Readonly<Record<string, SpendEntry>> = {
  // ── spends ───────────────────────────────────────────────────────────────
  // ⚠ `system:scout-cycle` and `system:template-gym` are deliberately ABSENT.
  // Both are live `target_role` values in harness_shared.routines — template-gym on
  // an ACTIVE row — but neither is registered at boot: `registerScoutCycleAction()`
  // is exported and never called, and nothing registers template-gym at all, so the
  // tick logs "no handler registered … skipping" and the routine silently does
  // nothing while presenting as running. Classifying them here would launder that
  // bug into a normal row; leaving them out makes them `unknown`, which routes them
  // to Needs-you. Filed as EI-18741229858124453 (template-gym) and
  // EI-18741240128927188 (scout-cycle) — when either is wired, the registry
  // cross-check will demand its classification.
  'system:blueprint-run': { spend: 'llm', why: 'Launches a blueprint agent (the Mug/Cup hive launch path)' },
  'system:plan-run': { spend: 'llm', why: 'Mints a plan run and dispatches its items to agents' },
  'system:overwatch-launch': { spend: 'llm', why: 'Launches the overwatch (Kettle) session' },
  'system:gym-cycle': { spend: 'llm', why: 'Runs one bounded gym cycle' },
  'system:improvement-implement': { spend: 'llm', why: 'Returns durableSpawns — dispatches an implementer agent' },
  'system:hive-canary': { spend: 'llm', why: 'Queues a canary feature the autonomous pipeline carries end to end' },
  'system:unguarded-halt-rescue': { spend: 'llm', why: 'Wakes halted sessions, and a wake bills a turn' },
  'system:loop-wake': { spend: 'llm', why: "Delivers a wake to the loop's owning session" },

  // ── free system work ─────────────────────────────────────────────────────
  'system:git-sync': { spend: 'none', why: 'Commits and pushes the tree' },
  'system:foreign-git-sync': { spend: 'none', why: 'Syncs a foreign (member) clone' },
  'system:green-checkpoint': { spend: 'none', why: 'Runs the gate suite and fast-forwards main' },
  'system:release-trigger': { spend: 'none', why: 'Deploys the green commit' },
  'system:pr-poll': { spend: 'none', why: 'Polls GitHub for PR state' },
  'system:cargo-test': { spend: 'none', why: 'Runs the Rust test suite' },
  'system:gate-watcher-tick': { spend: 'none', why: 'Reads gate state' },
  'system:gate-canary-sweep': { spend: 'none', why: 'Sweeps stale gate canaries' },
  'system:autoloop-release-readiness-monitor': { spend: 'none', why: 'Reads release-readiness state' },
  'system:doc-anchor-reconcile': { spend: 'none', why: 'Reconciles doc anchors against HEAD (sha compare)' },
  'system:knowledge-pack-delivery': { spend: 'none', why: 'Copies pack items into pools — no authoring' },
  'system:knowledge-pack-hygiene': { spend: 'none', why: 'Rule-based stale/contradiction sweep over pack rows' },
  'system:hive-git-gc': { spend: 'none', why: 'Garbage-collects hive git objects' },
  'system:gc-plan-runs': { spend: 'none', why: 'Prunes finished plan-run rows' },
  'system:session-dir-gc': { spend: 'none', why: 'Deletes isolation dirs of ended sessions' },
  'system:telemetry-retention': { spend: 'none', why: 'Applies telemetry retention windows' },
  'system:idle-session-reaper': { spend: 'none', why: 'Reaps idle session rows' },
  'system:hetzner-orphan-frame-reaper': { spend: 'none', why: 'Reaps orphaned remote frames' },
  'system:test-webview-reaper': { spend: 'none', why: 'Reaps leaked test webviews' },
  'system:bee-transcript-cap': { spend: 'none', why: 'Truncates oversized transcripts' },
  'system:precompute-derived-reads': { spend: 'none', why: 'Refreshes derived read tables' },
  'system:interactive-usage-ingest': { spend: 'none', why: 'Tails local transcripts into usage samples (SQL/FS only)' },
  'system:token-weekly-report': { spend: 'none', why: 'Aggregates usage into a report (SQL/FS only)' },
  'system:unclaimed-work-digest': { spend: 'none', why: 'Read-only: lists unclaimed items and posts a digest' },
  'system:improvement-human-digest': { spend: 'none', why: 'Ranks the human queue and sends it — no model' },
  'system:improvement-triage': { spend: 'none', why: 'Records routing metadata; explicitly never dispatches' },
  'system:improvement-watchdog': { spend: 'none', why: 'SQL pass that files work items' },
  'system:improvement-invalid-args-miner': { spend: 'none', why: 'Mines tool_invocations for invalid args (SQL)' },
  'system:claim-integrity-sweep': { spend: 'none', why: 'Checks claim invariants in SQL' },
  'system:claim-discipline-watch': { spend: 'none', why: 'Injects a nudge into an existing turn — never wakes' },
  'system:coord-invariant-monitor': { spend: 'none', why: 'Checks coord substrate invariants in SQL' },
  'system:coord-probe-canary': { spend: 'none', why: 'Runs a verb-cycle probe pair' },
  'system:plan-item-orphan-reconcile': { spend: 'none', why: 'Reconciles orphaned plan items' },
  'system:supervision-reconcile': { spend: 'none', why: 'Reconciles supervision rows' },
  'system:fleet-headcount-governor': { spend: 'none', why: 'Caps fleet headcount — throttles spend, never causes it' },
  'system:autonomy-trust-scan': { spend: 'none', why: 'Scores autonomy trust from recorded dispositions' },
  'system:hive-canary-sla': { spend: 'none', why: 'Checks yesterday’s canaries against their deadline' },
  'system:cross-hive-outbox-drain': { spend: 'none', why: 'Drains durable cross-hive outboxes' },
  'system:p2p-work-intake': { spend: 'none', why: 'Ingests federated work items' },
  'system:p2p-foreign-supervision': { spend: 'none', why: 'Supervises foreign harness rows' },
  'system:sweep-orphaned-foreign-harnesses': { spend: 'none', why: 'Sweeps orphaned foreign harnesses' },
  'system:p2p-perf-tier1': { spend: 'none', why: 'Nightly p2p bench' },
  'system:p2p-perf-tier2': { spend: 'none', why: 'Weekly p2p bench' },
  'system:wake-brain': { spend: 'none', why: 'Retired tombstone — the handler is a no-op' },
};

/**
 * Spend for a `target_role`, or `unknown` when the role is not in the table.
 *
 * `unknown` is deliberately a THIRD value rather than a default to `none`. A new
 * system action nobody classified must not be able to present itself as free — the
 * pane surfaces `unknown` as its own state, and the registry cross-check test turns
 * it into a build failure.
 */
export function spendForTargetRole(targetRole: string | null | undefined): RoutineSpend | 'unknown' {
  if (!targetRole) return 'unknown';
  return TARGET_ROLE_SPEND[targetRole]?.spend ?? 'unknown';
}

/** The one-line reason behind a row's spend classification (the row tooltip). */
export function spendReasonForTargetRole(targetRole: string | null | undefined): string | null {
  if (!targetRole) return null;
  return TARGET_ROLE_SPEND[targetRole]?.why ?? null;
}

/** Loop routines are named `loop-<ownerId>` (loop.ts loopRoutineName). */
export function isLoopRoutine(name: string): boolean {
  return /^loop-/i.test(name);
}

export interface RoutineKindInput {
  name: string;
  /** True when the row came from SYNC_TRIGGERED_SWEEPS (fires on an event, not a clock). */
  syncTriggered?: boolean;
}

export function routineKind({ name, syncTriggered }: RoutineKindInput): RoutineKind {
  if (isLoopRoutine(name)) return 'loop';
  if (syncTriggered) return 'triggered';
  return 'scheduled';
}

export interface RoutineLivenessInput {
  active: boolean;
  /** ISO next fire, or null. Postgres `infinity` arrives here as null (the catalog's iso() drops non-finite dates) — which is precisely the armed-but-never-firing case. */
  nextFireAt: string | null;
  /**
   * Does a clock drive this row? A `triggered` row has no next fire BY DESIGN and
   * must never read as stalled; a cron row or a loop with no next fire is broken.
   */
  clockDriven: boolean;
  /** Injected for tests. */
  now?: number;
}

/**
 * How overdue a clock-driven row may be before it reads as stalled. One hour is
 * long enough that a slow tick or a coalesced restart never trips it, and short
 * enough that a genuinely wedged sweep surfaces the same day.
 */
export const STALLED_OVERDUE_MS = 60 * 60 * 1000;

export function routineLiveness({
  active,
  nextFireAt,
  clockDriven,
  now = Date.now(),
}: RoutineLivenessInput): RoutineLiveness {
  if (!active) return 'dormant';
  if (!clockDriven) return 'running';
  if (!nextFireAt) return 'stalled';
  const next = Date.parse(nextFireAt);
  if (!Number.isFinite(next)) return 'stalled';
  return next < now - STALLED_OVERDUE_MS ? 'stalled' : 'running';
}

/**
 * Does this row want the owner's attention?
 *
 * Deliberately NARROW. A stalled row is objectively broken, and a flag-gated row
 * that is off is a switch the owner alone can throw. Mass-paused families
 * (`hive-wake`, paused across 16 pots since June) are NOT included: nothing in the
 * row distinguishes "deliberately retired" from "accidentally off", and a false
 * "needs you" costs more trust than a missed one. They stay in Dormant with their
 * count visible.
 */
export function routineNeedsAttention(input: {
  liveness: RoutineLiveness;
  control: RoutineControl;
  active: boolean;
  spend: RoutineSpend | 'unknown';
}): boolean {
  if (input.liveness === 'stalled') return true;
  if (input.control === 'flag' && !input.active) return true;
  // An unclassified handler only matters if it can actually fire — an ACTIVE row
  // dispatching to an action nobody registered is a silent no-op the owner should
  // see (EI-18741229858124453). An inactive one is just dormant.
  if (input.spend === 'unknown' && input.active) return true;
  return false;
}

const DOCS_FAMILY = /doc|^knowledge-pack-/i;
const WAKE_FAMILY = /(^|-)wake($|-)/i;
const LEARNING_FAMILY = /^improvement-|^bp-singleton-|^gym|^template-gym$|^pot-eval-battery$|^scout|prospector|^oddsmith-|^scan$/i;
const GIT_RELEASE_FAMILY = /git-sync|checkpoint|release|deploy|^pr-poll$|^cargo-test$|^gate-/i;
const CLEANUP_FAMILY = /gc$|^gc-|reaper|retention|^bee-transcript-cap$|precompute|^knowledge-pack-/i;
const FEDERATION_FAMILY = /^p2p-|hive|foreign|outbox|federation/i;

/**
 * Subject grouping for the browse-by-family view. Order matters: docs and wake are
 * checked before learning so `doc-steward` and `hive-wake` land where the owner
 * looks for them rather than where their group_slug files them — the same
 * name-before-group rule the old classifyRoutine() used, and for the same reason.
 */
export function routineFamily(name: string, kind: RoutineKind): RoutineFamily {
  if (kind === 'loop') return 'loops';
  if (WAKE_FAMILY.test(name)) return 'wake';
  if (DOCS_FAMILY.test(name)) return 'docs';
  if (LEARNING_FAMILY.test(name)) return 'learning';
  if (GIT_RELEASE_FAMILY.test(name)) return 'git-release';
  if (CLEANUP_FAMILY.test(name)) return 'cleanup';
  if (FEDERATION_FAMILY.test(name)) return 'federation';
  return 'health';
}

/** Display label for a family header. */
export const FAMILY_LABEL: Readonly<Record<RoutineFamily, string>> = {
  loops: 'Loops',
  wake: 'Wake',
  learning: 'Learning',
  docs: 'Docs',
  'git-release': 'Git & release',
  cleanup: 'Cleanup',
  health: 'Health',
  federation: 'Federation',
};

/** Families that belong to the LLM (Agents) pane, in display order. */
export const AGENT_FAMILY_ORDER: readonly RoutineFamily[] = ['loops', 'wake', 'learning', 'docs'];

/** Families that belong to the deterministic (System) pane, in display order. */
export const SYSTEM_FAMILY_ORDER: readonly RoutineFamily[] = [
  'git-release',
  'cleanup',
  'health',
  'federation',
];
