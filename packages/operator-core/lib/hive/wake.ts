/**
 * The Hive's self-declared wake — autoloop-hive-operator-rebuild-2026-06-05 P0
 * (D-002/D-003).
 *
 * The hive's "loop" is the operator deciding its OWN next wake before ending a
 * turn — a time, an event-subscription, or nothing. No timer drives it:
 *
 *   - **Time wake** — a ONE-SHOT `hive-wake` routine row (`harness_shared.routines`,
 *     cron-kind with NO cron expr + an explicit `next_fire_at`). The shipped
 *     durable `routinesTick` claims it once (deactivating it — see
 *     `claimDueRoutine`) and fires `system:blueprint-run { blueprintId: 'coding' }`,
 *     which launches the hive blueprint's decider (the operator role) via the
 *     launch-blueprint primitive. Durable: a host restart never loses the wake.
 *
 *   - **Event wake** — persisted subscriptions (`operator-state key hive_wake`, one
 *     row per workspace) projected into LIVE event-reaction rules
 *     (`registerReactionRule`) that fire the `pot:wake` tool when the subscribed
 *     tool-event matches. Re-registered at boot (`registerHiveWakeRules`) since
 *     the rule registry is in-memory.
 *
 *   - **Nothing** — both cleared; the hive sleeps until the user (or a manual
 *     `pot:wake`) wakes it.
 *
 * A **wake floor** (D-002's clamp) stops a confused operator from spinning: a
 * declared time is clamped to ≥ now+floor, and `pot:wake` skips a fire that
 * lands within the floor of the previous one (the event-burst debounce).
 */
import type { Sql } from 'postgres';
import type { DataCondition } from '@papercusp/rules';
import { clampToFloor, withinFloor } from '@papercusp/debounce-coalesce';
import { getOrgPg, upsertRoutine, setRoutineActive, deleteRoutine } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { canonicalHarnessSlug } from '../harness/operator-home-harness';
import { registerReactionRule, unregisterReactionRule, listReactionRules } from '../events/registry';
import {
  isWorkspaceCoordinationOn,
  workspaceBrainScopeKey,
  workspaceBrainReadKeys,
} from '../workspace-brain-scope';
import { setCarryNote, getCarryNote, getCarryJournal, hiveScope } from '../carry-note';
// The Queen carry-journal converged onto the ONE shared carry-note substrate
// (su-cold-auto-mode-2026-07-03 P-001 / D-004). The journal ring primitives moved
// there; re-exported here for back-compat importers (hive/carry-journal.test.ts).
export {
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
  type CarryJournalEntry,
} from '../carry-note';

/** The hive launch blueprint id (blueprints/coding/blueprint.yaml — renamed from `hive`). */
export const HIVE_BLUEPRINT_ID = 'coding';
/** The one-shot wake routine's name (per-harness unique with install_slug). */
export const HIVE_WAKE_ROUTINE_NAME = 'hive-wake';

/** One persisted event-wake subscription. Serializable (PG JSONB) — so `when`
 *  is the declarative DataCondition form only, never a JS predicate. */
export interface HiveEventSubscription {
  /** Trigger tool name(s) — the event-reaction `on` key (e.g. 'coord:escalate'). */
  on: string | string[];
  /** Optional declarative condition over the tool event ({args,result,ctx}). */
  when?: DataCondition;
  /** Why the hive subscribed — surfaced in pot:status + the wake kickoff. */
  note?: string;
}

/** The per-workspace hive_wake state row payload. */
export interface HiveWakeState {
  subscriptions: HiveEventSubscription[];
  /** ms epoch of the last hive launch fire — the pot:wake floor-debounce input. */
  lastWakeAt?: number;
  /** ms epoch of the last declare-wake call (observability). */
  declaredAt?: number;
  /**
   * LEGACY single carry-note slot (P-015 / B-04) — superseded by
   * `carryJournal` (queen-memory-hybrid-2026-07-02 L1a) but kept as a
   * back-compat MIRROR of the newest journal entry so older readers keep
   * working. Do not write it directly; `setHiveCarryNote` maintains it.
   */
  carryNote?: string;
  /**
   * The Queen's carry-JOURNAL (queen-memory-hybrid-2026-07-02 L1a): an
   * APPEND-mode, size-bounded ring of her recent wake notes (newest last in
   * storage; rendered newest-first). Replaces the single REPLACE slot so she
   * sees her own recent reasoning TRAJECTORY each wake, not just the last
   * thought — the REPLACE semantics were why she re-derived the same
   * conclusions wake after wake. Subjective in-flight intention, NOT
   * world-state (durable conclusions belong in facts:assert).
   */
  carryJournal?: Array<{ at: number; note: string }>;
}

const EMPTY_STATE: HiveWakeState = { subscriptions: [] };

// The carry-journal ring bounds (CARRY_JOURNAL_*) + appendCarryJournal moved to
// the shared carry-note substrate (su-cold-auto-mode P-001) and are re-exported
// from the import block above.

/** The self-wake floor in seconds (D-002's clamp). Env-tunable, hard min 5s. */
export function hiveWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC ?? 60);
  return Number.isFinite(n) && n >= 5 ? n : 60;
}

/**
 * The effective wake floor in seconds: MAX(system floor, owner override). The owner
 * cadence-floor knob (queen-steering-panel P-006) can only RAISE the interval (slow
 * the loop) — never drop below the system minimum. `ownerFloorSec` undefined/≤0 ⇒
 * the system floor unchanged (today's behaviour). Pure; the async resolver below
 * reads the owner value and calls this.
 */
function effectiveWakeFloorSec(ownerFloorSec?: number): number {
  return Math.max(hiveWakeFloorSec(), ownerFloorSec && ownerFloorSec > 0 ? ownerFloorSec : 0);
}

/** Clamp a requested wake time to ≥ now + the floor. Delegates the floor math to the
 *  shared `@papercusp/debounce-coalesce` core (the hive is no longer a special case —
 *  unify-watch-primitive-2026-06-06 P-006/D-009). `ownerFloorSec` (queen-steering-panel
 *  P-006) RAISES the floor when the owner set a wake-cadence floor — MAX(system, owner). */
export function clampWakeAt(
  requested: Date,
  now: Date = new Date(),
  ownerFloorSec?: number,
): { at: Date; clamped: boolean } {
  const { at, clamped } = clampToFloor({
    requestedAt: requested.getTime(),
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now: now.getTime(),
  });
  return { at: new Date(at), clamped };
}

/**
 * Resolve the EFFECTIVE wake floor for a Hive — MAX(system floor, the owner's
 * `cadence-floor-sec` steering knob), fail-soft to the system floor (P-006, D-005).
 * The single async read the cadence-aware seams (declareHiveTimeWake, urgent-wake,
 * the pot:wake debounce) call once, then thread the number into the pure
 * clampWakeAt / withinWakeFloor below.
 */
export async function effectiveHiveWakeFloorSec(workspaceId: string, installSlug: string): Promise<number> {
  try {
    const { getOwnerSteering, effectiveCadenceFloorSec } = await import('../owner-steering');
    const s = await getOwnerSteering(workspaceId, installSlug);
    return effectiveCadenceFloorSec(s, hiveWakeFloorSec());
  } catch {
    return hiveWakeFloorSec();
  }
}

/**
 * Declare (or replace) the hive's one-shot TIME wake: upsert the `hive-wake`
 * routine with an explicit clamped `next_fire_at` and no cron (one-shot —
 * `claimDueRoutine` deactivates it on fire). Returns the effective time.
 */
export async function declareHiveTimeWake(
  sql: Sql,
  opts: {
    workspaceId: string;
    installSlug: string;
    at: Date;
    kickoff?: string;
    now?: Date;
    blueprintId?: string;
    /** Pre-resolved effective wake floor (seconds) — pass it when the caller
     *  already read owner-steering (urgent-wake) to avoid a second read; omitted ⇒
     *  resolved here via effectiveHiveWakeFloorSec (queen-steering-panel P-006). */
    floorSec?: number;
  },
): Promise<{ at: Date; clamped: boolean }> {
  // Owner cadence-floor (P-006): the Queen's self-declared wake is clamped up to the
  // owner's floor. Resolve it here (so every declare-wake path — incl. the pot:declare-wake
  // tool — is owner-aware with no call-site change) unless the caller pre-resolved it.
  const floorSec = opts.floorSec ?? (await effectiveHiveWakeFloorSec(opts.workspaceId, opts.installSlug));
  const { at, clamped } = clampWakeAt(opts.at, opts.now, floorSec);
  // K1 workspace-brain re-key (workspace-scoped-coordination P-003 / D-006): when
  // WORKSPACE_COORDINATION is ON, the one workspace Queen owns ONE hive-wake
  // routine, keyed under the workspace SENTINEL (install_slug = workspaceId)
  // instead of per-hive — collapsing N per-hive wake routines (the carry-note /
  // subscription clobber the plan names) to one. OFF (the dark default) ⇒ the
  // legacy per-hive install slug, byte-identical to today. (Event-state — the
  // hive_wake operator-state row — is already workspace-keyed; untouched.)
  const scopeSlug = workspaceBrainScopeKey(
    opts.workspaceId,
    opts.installSlug,
    await isWorkspaceCoordinationOn(),
  );
  // EI-1477 (sibling of EI-1472): the hive wake is a SINGLETON keyed by (install_slug,
  // name) — the global routines_install_slug_name_key enforces ONE row per install
  // regardless of workspace. With per-workspace ON CONFLICT (F-E1) on, upsertRoutine
  // conflicts on (workspace_id, install_slug, name); if the existing singleton lives
  // under a DIFFERENT workspace_id than the caller's ctx, that target misses and the
  // INSERT collides with the global constraint → duplicate-key throw, so the Queen
  // can't re-arm her wake. Pin the upsert to the EXISTING row's workspace (UPDATE in
  // place; harmless under the legacy (install_slug, name) conflict).
  const existing = await sql<Array<{ workspace_id: string }>>`
    SELECT workspace_id FROM harness_shared.routines
     WHERE install_slug = ${scopeSlug} AND name = ${HIVE_WAKE_ROUTINE_NAME}
     LIMIT 1
  `;
  await upsertRoutine(
    sql,
    {
      workspaceId: existing[0]?.workspace_id ?? opts.workspaceId,
      installSlug: scopeSlug,
      name: HIVE_WAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {}, // no cron expr ⇒ one-shot
      targetRole: 'system:blueprint-run',
      payloadTemplate: {
        blueprintId: opts.blueprintId ?? HIVE_BLUEPRINT_ID,
        // Workspace-coordination mode keys the routine under the workspace
        // sentinel (`install_slug = workspaceId`) so there is only one Queen
        // wake row. The launch itself still targets the concrete hive/harness.
        // Carry it explicitly; system:blueprint-run uses this for /invoke.
        launchInstallSlug: opts.installSlug,
        kickoff:
          opts.kickoff ??
          `Self-declared wake (declared ${new Date().toISOString()}). You are the operator in charge; survey the fleet and figure out what to do.`,
      },
      concurrency: 'skip',
      catchup: 'skip-old',
      active: true,
      nextFireAt: at,
    },
    computeNextFireAt,
  );
  return { at, clamped };
}

/** Clear the hive's time wake (mode 'none', or a declare with no time).
 *  EI-1477: DELETE the row (not just deactivate) to avoid duplicate-key conflicts
 *  under concurrency when a stale/orphaned row would collide with a new UPSERT.
 *
 *  K1 (workspace-scoped-coordination P-003): when WORKSPACE_COORDINATION is ON and
 *  a `workspaceId` is supplied, the wake routine lives under the workspace sentinel
 *  — clear BOTH the sentinel row and the legacy per-hive row (hygiene; a stop must
 *  leave nothing armed). OFF, or no workspaceId, ⇒ clear the per-hive row only,
 *  byte-identical to today. */
export async function clearHiveTimeWake(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string } = {},
): Promise<void> {
  const on = opts.workspaceId ? await isWorkspaceCoordinationOn() : false;
  const slugs = on
    ? workspaceBrainReadKeys(opts.workspaceId!, installSlug, true)
    : [installSlug];
  for (const slug of slugs) await deleteRoutine(sql, slug, HIVE_WAKE_ROUTINE_NAME);
}

/** timestamptz arrives as Date or ISO string depending on the pool's type
 *  parsers (EI-257: the boot-path pool returns strings — `.getTime()` on one
 *  threw in every watchdog liveness check and flooded the console). */
function toDateOrNull(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read the hive's time-wake routine state (null = never declared).
 *
 *  K1 (workspace-scoped-coordination P-003): when WORKSPACE_COORDINATION is ON and
 *  a `workspaceId` is supplied, prefer the workspace-sentinel routine row, falling
 *  back to the legacy per-hive row until the sentinel is first written (zero
 *  regression). OFF, or no workspaceId, ⇒ the per-hive row only, byte-identical
 *  to today. */
export async function getHiveTimeWake(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string } = {},
): Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null> {
  const on = opts.workspaceId ? await isWorkspaceCoordinationOn() : false;
  const slugs = on
    ? workspaceBrainReadKeys(opts.workspaceId!, installSlug, true)
    : [installSlug];
  for (const slug of slugs) {
    const rows = await sql<
      Array<{ active: boolean; next_fire_at: Date | string | null; last_fired_at: Date | string | null }>
    >`
      SELECT active, next_fire_at, last_fired_at
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND name = ${HIVE_WAKE_ROUTINE_NAME}
    `;
    if (rows.length > 0) {
      return {
        active: rows[0].active,
        nextFireAt: toDateOrNull(rows[0].next_fire_at),
        lastFiredAt: toDateOrNull(rows[0].last_fired_at),
      };
    }
  }
  return null;
}

// ── event-wake subscriptions ─────────────────────────────────────────────────

const RULE_PREFIX = 'hive-wake';
const ruleId = (workspaceId: string, i: number): string => `${RULE_PREFIX}:${workspaceId}#${i}`;

/** Read the persisted hive wake state for a workspace. */
export async function readHiveWakeState(workspaceId?: string): Promise<HiveWakeState> {
  return (await readOperatorState<HiveWakeState>('hive_wake', workspaceId)) ?? EMPTY_STATE;
}

/**
 * Project a workspace's persisted subscriptions into LIVE reaction rules.
 * Idempotent: removes every `hive-wake:<ws>#*` rule first, then registers the
 * current set. Each rule fires the `pot:wake` tool (the floor-debounce lives
 * there) with static args carrying the subscription's provenance.
 */
export function syncHiveWakeRules(workspaceId: string, subs: HiveEventSubscription[]): number {
  for (const r of listReactionRules()) {
    if (r.id.startsWith(`${RULE_PREFIX}:${workspaceId}#`)) unregisterReactionRule(r.id);
  }
  let n = 0;
  for (const [i, sub] of subs.entries()) {
    registerReactionRule({
      id: ruleId(workspaceId, i),
      on: sub.on,
      when: sub.when,
      fire: 'pot:wake',
      args: {
        reason: `subscribed event (${Array.isArray(sub.on) ? sub.on.join(', ') : sub.on})${sub.note ? ` — ${sub.note}` : ''}`,
        source: 'event',
      },
      // Durable would survive a restart, but a wake is cheap to lose and MUST
      // not retry-storm the hive — in-process fire-and-forget is right here.
      mode: 'sync',
      onlyOnSuccess: true,
      source: 'hive-wake',
    });
    n++;
  }
  return n;
}

/**
 * Replace the persisted event subscriptions (+ live rules) for a workspace.
 * REPLACE semantics, like coord:declare-intent: each declare describes the
 * whole wake; omitted ⇒ cleared.
 */
export async function setHiveEventSubscriptions(
  workspaceId: string,
  subs: HiveEventSubscription[],
): Promise<number> {
  await updateOperatorState<HiveWakeState>('hive_wake', EMPTY_STATE, (cur) => ({
    ...cur,
    subscriptions: subs,
    declaredAt: Date.now(),
  }), workspaceId);
  return syncHiveWakeRules(workspaceId, subs);
}

/**
 * Set (or clear) the Queen's self-authored carry-note for her next wake
 * (P-015 / B-04). REPLACE-semantics: a non-empty string replaces the stored note
 * and appends to her carry-JOURNAL ring; `null`/`undefined`/blank clears the note
 * (the journal — her recent-reasoning trajectory — persists; the next wake
 * re-derives the floor). As of su-cold-auto-mode-2026-07-03 P-001 this delegates
 * to the ONE shared carry-note substrate under {@link hiveScope} (the Queen
 * carry-journal, the bee checkpoint and the su loop carry-note are now the same
 * store + shape). Returns the stored note (trimmed) or null.
 */
export async function setHiveCarryNote(
  workspaceId: string,
  note: string | null | undefined,
): Promise<string | null> {
  return setCarryNote({ scope: hiveScope(), workspaceId }, note);
}

/**
 * Read the Queen's carry-journal, NEWEST FIRST (L1a) — the brief renderer's
 * input. Reads the shared carry-note substrate under {@link hiveScope}.
 */
export async function getHiveCarryJournal(
  workspaceId?: string,
): Promise<Array<{ at: number; note: string }>> {
  return getCarryJournal({ scope: hiveScope(), workspaceId });
}

/**
 * Read the Queen's carry-note stored for the current wake (P-015 / B-04) — the
 * additive second half of her brief. Null when she carried nothing. The brief
 * builder (B-05 / the wake-invocation seam) passes this to
 * `renderQueenBrief({ carryNote })`.
 */
export async function getHiveCarryNote(workspaceId?: string): Promise<string | null> {
  return getCarryNote({ scope: hiveScope(), workspaceId });
}

/**
 * Boot-time re-registration: the rule registry is in-memory, so persisted
 * subscriptions must be projected again on every host start. Fail-soft (a
 * missing table pre-migration must never block boot).
 */
export async function registerHiveWakeRules(workspaceId?: string): Promise<number> {
  const ws = workspaceId ?? activeWorkspaceId();
  try {
    const state = await readHiveWakeState(ws);
    return syncHiveWakeRules(ws, state.subscriptions);
  } catch (e) {
    console.warn(`[hive] wake-rule registration skipped: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

// ── the fire-side floor debounce ─────────────────────────────────────────────

/** Whether a hive fire at `now` falls inside the floor window of the last one. Delegates
 *  to the shared `@papercusp/debounce-coalesce` floor (P-006/D-009): the hive consumes the
 *  SAME core every other wake-subscription now uses, rather than a bespoke comparison. */
export function withinWakeFloor(state: HiveWakeState, now: number = Date.now(), ownerFloorSec?: number): boolean {
  return withinFloor({
    lastWokenAt: state.lastWakeAt ?? null,
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now,
  });
}

export interface HiveWakeAdmission {
  fired: boolean;
  skipped?: 'wake-floor';
  floorSec: number;
  nextAllowedAt?: string;
}

export function decideHiveWakeAdmission(
  state: HiveWakeState,
  opts: { now: number; floorSec: number; force?: boolean },
): HiveWakeAdmission {
  if (!opts.force && withinWakeFloor(state, opts.now, opts.floorSec)) {
    return {
      fired: false,
      skipped: 'wake-floor',
      floorSec: opts.floorSec,
      nextAllowedAt: new Date((state.lastWakeAt ?? 0) + opts.floorSec * 1_000).toISOString(),
    };
  }
  return { fired: true, floorSec: opts.floorSec };
}

/** Atomically claim the right to launch a Queen wake by recording `lastWakeAt`
 * before the expensive launch. The old fire path recorded after launch, leaving
 * a check-then-act window where event/manual/watchdog wakes could all see the
 * same stale state and launch overlapping Queens. */
export async function claimHiveWakeFire(
  workspaceId: string,
  opts: { floorSec: number; force?: boolean; now?: number },
): Promise<HiveWakeAdmission> {
  const now = opts.now ?? Date.now();
  let admission: HiveWakeAdmission = { fired: false, floorSec: opts.floorSec };
  await updateOperatorState<HiveWakeState>(
    'hive_wake',
    EMPTY_STATE,
    (cur) => {
      admission = decideHiveWakeAdmission(cur, { now, floorSec: opts.floorSec, force: opts.force });
      return admission.fired ? { ...cur, lastWakeAt: now } : cur;
    },
    workspaceId,
  );
  return admission;
}

/** Record a hive launch fire (the debounce input for the next one). */
export async function recordHiveWake(workspaceId?: string): Promise<void> {
  await updateOperatorState<HiveWakeState>(
    'hive_wake',
    EMPTY_STATE,
    (cur) => ({ ...cur, lastWakeAt: Date.now() }),
    workspaceId,
  );
  // Per-wake push for the QueenHeartbeat sidebar (data-sync-push-completion P-007):
  // hive.controlState surfaces lastWakeAt + the next-fire countdown + the placements
  // the Queen is driving. This is THE single ledger chokepoint every explicit wake
  // path funnels through (pot:wake, urgent-wake, the events/await wake-executor, hive
  // create), so invalidating here replaces the heartbeat's old 12s self-poll. Fire-and-
  // forget + non-throwing (mirrors pot:start/pause); name-only/{} matches the
  // no-arg consumer. (A wake path that bypasses recordHiveWake is still caught by the
  // @papercusp/sync 180s drift-repair tick.)
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hive.controlState', {}))
    .catch(() => {});
}

/** Resolve the harness slug the hive runs against: explicit arg → ctx harness →
 *  env default. The hive is workspace-level but the invoke route is
 *  harness-scoped, so a home slug must be named somewhere. */
export function resolveHiveHomeSlug(explicit?: string | null, ctxSlug?: string | null): string | null {
  // '*' (wildcard / all-harnesses scope) is NOT a concrete hive home — SKIP it at each level so the chain falls
  // through to a real slug (env home) or null, instead of firing the hive launch with installSlug '*', which the
  // invoke route's resolveProject can't find → HTTP 404 "unknown project" (2026-07-01: an operator-scoped
  // `pot:wake` with no explicit harness inherited ctx.harnessSlug='*' and 404'd instead of resolving/erroring).
  const concrete = (s?: string | null): string | undefined => {
    const t = s?.trim();
    return t && t !== '*' ? t : undefined;
  };
  const slug = concrete(explicit) ?? concrete(ctxSlug) ?? concrete(process.env.PAPERCUSP_HIVE_HOME_SLUG) ?? null;
  return slug ? canonicalHarnessSlug(slug) : null;
}
