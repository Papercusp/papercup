/**
 * inbox-wake.ts — the deliver-and-wake key convention + the single-target
 * wake fan (local-hive-orchestration-2026-06-06 Phase 4: P-040/P-041/P-042,
 * D-005).
 *
 * `coord:send` is inbox-inject by default (unify-watch D-002 — inject is cheap,
 * wake is the deliberate opt-in). When a sender passes `{ wake:true }` the
 * message still lands in the inbox AND we fire each addressed recipient's OWN
 * inbox-wake key through the shipped await-event pump (the floor + coalesce +
 * liveness-ladder built in unify-watch). We do NOT build a second wake pump —
 * this just composes `emitAwaitedEvent`.
 *
 * The wake-key convention is the per-recipient pair to the standing watch an
 * idle bee registers (P-041): a bee that ends a turn idle registers
 * `watch:create { pattern: inboxWakeKey(self), wake:true, once:false }` and
 * sleeps; a later `coord:send {wake:true, to:[bee]}` re-invokes exactly it.
 *
 * SINGLE-TARGET, NEVER A BROADCAST (P-042 / unify-watch P-008/D-005, the
 * lock-grant-bridge pattern): each wake is one `emitAwaitedEvent` on
 * `coord:inbox-wake:<ownerId>` — a key only THAT owner ever watches. We fan one
 * emit per addressed ownerId; we never emit on a wildcard/shared key, so the
 * pump only resumes the addressee(s), never the whole fleet (a wildcard would
 * thunder-herd N sleeping agents into N billable turns).
 */

import { emitAwaitedEvent } from '../../events/await/engine';
import { listActiveAwaitsForKey } from '../../events/await/store';
// hive-agent-tabs P-007/D-005: the per-agent wake-mode gate (consumed below).
import { resolveWakeMode } from './wake-mode';
import { stagePendingWake } from './pending-wakes';
import { listPresence } from './presence';
import { resolveBestEffortAgainstRoster, isSelectorOrWildcard } from './recipient-resolve';

/** Prefix for the per-agent inbox-wake key. A bee watches `inboxWakeKey(self)`;
 *  a `{wake:true}` send to that bee fires exactly this key. */
export const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

/** The wake key for one recipient ownerId. The standing-watch pattern and the
 *  send-side fire MUST agree on this string — it is the rendezvous. */
export function inboxWakeKey(ownerId: string): string {
  return `${COORD_INBOX_WAKE_PREFIX}${ownerId}`;
}

/** Recover the ownerId from an inbox-wake key (null if it isn't one). */
export function ownerFromInboxWakeKey(key: string): string | null {
  return key.startsWith(COORD_INBOX_WAKE_PREFIX) ? key.slice(COORD_INBOX_WAKE_PREFIX.length) : null;
}

/** Addressees we never wake even when `wake:true`: the broadcast wildcard and
 *  the human inbox (the human is not a wake-resumable agent; '*' would be the
 *  exact thunder-herd P-042 forbids). Plain ownerIds pass through. The
 *  idle-recipient probe (coord-dispatch-reliability P-001) reuses this same set
 *  so the no-wake report and the wake fan skip exactly the same addressees. */
export const NON_WAKEABLE = new Set(['*', 'human', '']);

/** P-022 (cross-machine-coord-parity, fan-out governance): the MAX concrete
 *  agents ONE send's wake fan will re-invoke. Beyond it, the overflow is
 *  INJECTED (durable, seen next turn) but NOT woken — a `@fleet:`/`@topic:` that
 *  expands to thousands (256×10 = 2560 agents) must not turn one message into
 *  thousands of billable turns. A legitimate directed set is far under this;
 *  env-tunable. */
export const MAX_WAKE_FANOUT = Number(process.env.PAPERCUSP_MAX_WAKE_FANOUT) || 64;

/** A LOOP wake's source convention (loop-fire.ts: `loop:<routineId>`). */
export const LOOP_WAKE_SOURCE_PREFIX = 'loop:';

/**
 * Is this wake a LOOP's self-wake? A loop wake is the agent driving ITSELF (loop:arm), so it
 * must BYPASS the manual pause/edit gate below: there is no separate owner to release a staged
 * wake — the asleep agent waiting on `coord:inbox-wake:<self>` is the ONLY one who could release
 * it, so STAGING a self-wake DEADLOCKS the loop (fire → stage → nobody releases → never executes).
 * Observed live 2026-06-23: a self-loop fired ~10× into a manual-mode session (global default was
 * `manual` via hive:pause) and every wake staged → the loop did zero work. The manual gate exists
 * for an OWNER reviewing a SUBORDINATE's wakes; a self-loop has neither, so its wake always fires.
 * (loop:arm is su/interactive-only — never a fleet agent — so this never un-pauses a fleet bee.)
 */
export function isLoopWakeSource(source: string | undefined): boolean {
  return (source ?? '').startsWith(LOOP_WAKE_SOURCE_PREFIX);
}

export interface WakeRecipientsResult {
  /** Concrete recipient ownerIds we fired a wake key for (post-filter). */
  targets: string[];
  /** The keys fired (one per target) — for assertions / debugging. */
  keys: string[];
  /** Total wake awaits actually fired (sum over targets; 0 if none asleep). */
  woken: number;
  /** Recipients whose wake was STAGED (wake-mode `manual` — the hive Pause
   *  primitive) instead of fired — always 0 when everything resolves `auto`
   *  (the default). Graduated off the HIVE_AGENT_TABS flag (start-hive P-007). */
  staged: number;
  /** P-022: recipients BEYOND MAX_WAKE_FANOUT — injected (durable) but not woken.
   *  Non-empty only on an oversized audience fan (the cost-DoS shape). */
  fanoutCapped: string[];
}

/**
 * Fire the inbox-wake key for each addressed recipient — one targeted emit per
 * ownerId, never a broadcast (P-042). `recipients` is the POST-expansion `to[]`
 * (audience selectors already resolved to concrete ownerIds by sendMessage), so
 * `*`/`human`/empty are filtered here and never reach the pump.
 *
 * Fail-soft: the inbox write is the durable truth; a wake fan that errors must
 * not fail the send. Each recipient's emit is independent (one bad key never
 * starves the others).
 */
export async function wakeRecipients(
  recipients: readonly string[],
  opts: { summary?: string; payload?: unknown; source?: string; workspaceId?: string } = {},
): Promise<WakeRecipientsResult> {
  // owner-2026-06-17: resolve a short ownerId PREFIX to the full id before firing
  // the wake key — the key is exact (`coord:inbox-wake:<full-ownerId>`), so a short
  // prefix would fire a key nobody watches (woken:0). Best-effort + fail-soft.
  const resolved = await resolveBestEffortAgainstRoster(recipients, opts.workspaceId);
  const allTargets = [...new Set(resolved)].filter((r) => !NON_WAKEABLE.has(r));
  // P-022: cap the wake fan — beyond MAX_WAKE_FANOUT the overflow is injected but
  // NOT woken (the durable inbox row already landed at sendMessage), so an
  // oversized audience can't detonate thousands of billable turns from one send.
  const targets = allTargets.slice(0, MAX_WAKE_FANOUT);
  const fanoutCapped = allTargets.slice(MAX_WAKE_FANOUT);
  if (fanoutCapped.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[inbox-wake] wake fan-out capped at ${MAX_WAKE_FANOUT}: ${fanoutCapped.length} recipient(s) ` +
        'INJECTED but not woken (oversized audience — they see it on their next turn).',
    );
  }
  // The per-agent wake-MODE gate (hive-agent-tabs P-007/D-005), GRADUATED off
  // the HIVE_AGENT_TABS flag (start-hive-wake P-007 / OQ-2): the gate is the
  // hive's PAUSE primitive (hive:pause sets the global default to `manual`), so
  // it must hold regardless of a UI flag — a flipped-off flag silently unmaking
  // Pause would fire wakes into a frozen hive. Behavior-neutral otherwise:
  // everything resolves `auto` by default, and auto fires immediately as before.
  const keys: string[] = [];
  let woken = 0;
  let staged = 0;
  // A self-loop wake bypasses the manual gate entirely (staging it deadlocks — see
  // isLoopWakeSource). The source is per-CALL, so compute once. Everything else still honors
  // the per-agent manual pause/edit gate exactly as before (default-preserving).
  const bypassManualGate = isLoopWakeSource(opts.source);
  for (const ownerId of targets) {
    // Manual mode → STAGE instead of fire; the agent is not re-invoked (EXCEPT a self-loop wake).
    if (!bypassManualGate) {
      let manual = false;
      try {
        manual = (await resolveWakeMode(ownerId)) === 'manual';
      } catch {
        manual = false; // mode store unreadable → default auto (fire)
      }
      if (manual) {
        try {
          await stagePendingWake({
            ownerId,
            summary: opts.summary,
            payload: opts.payload,
            source: opts.source,
            workspaceId: opts.workspaceId,
          });
          staged += 1;
        } catch (e) {
          console.warn(
            `[inbox-wake] stage for ${ownerId} failed: ${e instanceof Error ? e.message : e}`,
          );
        }
        continue;
      }
    }
    const key = inboxWakeKey(ownerId);
    keys.push(key);
    try {
      const res = await emitAwaitedEvent({
        key,
        summary: opts.summary,
        payload: opts.payload,
        source: opts.source,
        workspaceId: opts.workspaceId,
      });
      woken += res.woken;
    } catch (e) {
      // Best-effort: the message already persisted to the inbox; a wake-fan
      // hiccup degrades to "seen on the recipient's next natural turn".
      console.warn(
        `[inbox-wake] wake fire for ${ownerId} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return { targets, keys, woken, staged, fanoutCapped };
}

// ── Idle-recipient REPORTING on the no-wake (default inject-only) path ──────────
// coord-dispatch-reliability-2026-06-21 P-001. A plain `coord:send` (no wake)
// lands in the recipient's inbox and is seen on their NEXT natural turn — it does
// NOT re-invoke a sleeping agent. So a hand-off injected to an idle agent silently
// stalls: the message is durable, but nobody picks it up until something else
// wakes them. This path REPORTS (never acts on) that risk: for each concrete
// addressee we NON-FIRINGLY probe whether anyone is watching its inbox-wake key,
// so the sender learns "this landed in an inbox no live session is watching".
//
// INVARIANTS (the load-bearing ones):
//  (a) REPORT-ONLY — we NEVER call emitAwaitedEvent / wake on this path. Auto-waking
//      would violate the wake=billable cost model (unify-watch D-002: inject is the
//      default, wake is the deliberate opt-in) and thunder-herd idle agents.
//  (b) We skip the SAME non-wakeable targets the wake fan skips ('*' / 'human' /
//      empty + audience selectors) — they are not single, wake-resumable agents.
//  (c) FEDERATION FAIL-SOFT — a recipient NOT in the local roster is federated /
//      remote, and its watchers live on its home instance, not in OUR await store.
//      We must NEVER falsely flag it idle: it is classified `unknown` (advisory).
//      And ANY roster / await-store read hiccup DEGRADES to "report nothing"
//      (the send already succeeded) — it must never throw or block. The send
//      succeeding is sacred.

/** Per-recipient liveness disposition on the no-wake path. */
export type RecipientLiveness =
  /** Concrete local recipient with ≥1 active watcher on its inbox-wake key — a
   *  live session will see the inject; NOT idle. */
  | 'live'
  /** Concrete local recipient with ZERO active watchers — the inject lands in an
   *  inbox no session is watching; the work silently stalls until something else
   *  wakes them. Flagged in `idleRecipients` / `notWoken`. */
  | 'idle'
  /** Not in the local roster (federated / remote, or a just-swept id): its
   *  watchers aren't in OUR await store, so we CANNOT know — advisory only,
   *  NEVER flagged idle (invariant c). */
  | 'unknown';

export interface IdleClassificationInput {
  /** A concrete, wakeable recipient ownerId (caller pre-filters selectors). */
  ownerId: string;
  /** Is this ownerId in the local presence roster? (false ⇒ federated/unknown) */
  inRoster: boolean;
  /** How many active (unfired, uncancelled) watchers are on its inbox-wake key.
   *  Only meaningful when inRoster — a federated recipient's watchers live
   *  elsewhere. */
  activeWatchers: number;
}

/**
 * PURE core (unit-tested): classify ONE concrete recipient's no-wake liveness.
 *  - not in the local roster → `unknown` (federated/remote — never falsely idle)
 *  - in roster, ≥1 active watcher → `live`
 *  - in roster, zero active watchers → `idle` (the report-worthy case)
 */
export function classifyRecipientLiveness(input: IdleClassificationInput): RecipientLiveness {
  if (!input.inRoster) return 'unknown';
  return input.activeWatchers > 0 ? 'live' : 'idle';
}

export interface IdleRecipientReport {
  /** Concrete local recipients whose inject lands in an inbox NO live session is
   *  watching — the work silently stalls. The reportable set (P-001). */
  idle: string[];
  /** Concrete local recipients with a live watcher — the inject will be seen. */
  live: string[];
  /** Recipients not in the local roster (federated/remote) — advisory, NEVER
   *  reported as idle (invariant c). */
  unknown: string[];
  /** True when a roster / await-store read failed and we degraded to report
   *  NOTHING (the send still succeeded — invariant c). `idle` is empty here. */
  degraded: boolean;
}

const EMPTY_IDLE_REPORT: IdleRecipientReport = { idle: [], live: [], unknown: [], degraded: true };

/**
 * Probe the no-wake liveness of `recipients` (the POST-expansion `to[]` — audience
 * selectors already resolved to concrete ownerIds). REPORT-ONLY: this NEVER fires
 * a wake (invariant a) — it reads the await store with the NON-FIRING
 * `listActiveAwaitsForKey` probe + the local presence roster, classifies each
 * concrete recipient, and returns who would silently stall.
 *
 * Fully fail-soft (invariant c): a roster or await-store read error degrades to
 * `EMPTY_IDLE_REPORT` (degraded:true, empty `idle`) — it can NEVER throw, so the
 * send always succeeds regardless. Federated recipients (not in our roster) are
 * `unknown`, never falsely idle.
 */
export async function reportIdleRecipients(
  recipients: readonly string[],
  opts: { workspaceId?: string } = {},
): Promise<IdleRecipientReport> {
  // (b) Skip the same non-wakeable targets the wake fan skips: '*'/'human'/empty
  // and audience selectors ('@…') are not single wake-resumable agents.
  const concrete = [...new Set(recipients)].filter(
    (r) => !isSelectorOrWildcard(r) && !NON_WAKEABLE.has(r),
  );
  if (concrete.length === 0) return { idle: [], live: [], unknown: [], degraded: false };

  // The local roster — the membership truth for "is this recipient federated?".
  // A read hiccup DEGRADES the whole probe (invariant c): we cannot tell idle
  // from federated without it, and a false idle flag is worse than no flag.
  let rosterIds: Set<string>;
  try {
    const presence = await listPresence({ workspaceId: opts.workspaceId });
    rosterIds = new Set(presence.map((p) => p.ownerId));
  } catch (e) {
    console.warn(
      `[inbox-wake] idle-probe roster read failed, reporting no idle recipients: ${e instanceof Error ? e.message : e}`,
    );
    return EMPTY_IDLE_REPORT;
  }

  const idle: string[] = [];
  const live: string[] = [];
  const unknown: string[] = [];
  for (const ownerId of concrete) {
    const inRoster = rosterIds.has(ownerId);
    let activeWatchers = 0;
    if (inRoster) {
      // NON-FIRING probe (invariant a): listActiveAwaitsForKey READS the active
      // watchers without firing/waking any of them — the deliberate report-only
      // peek the store documents for "is anyone waiting at all?".
      try {
        const watchers = await listActiveAwaitsForKey(inboxWakeKey(ownerId), opts.workspaceId);
        activeWatchers = watchers.length;
      } catch (e) {
        // A per-recipient await-store hiccup degrades the WHOLE report (invariant
        // c): a missing watcher count would otherwise mis-classify this concrete
        // local recipient as idle. Report nothing rather than a false idle.
        console.warn(
          `[inbox-wake] idle-probe await read for ${ownerId} failed, reporting no idle recipients: ${e instanceof Error ? e.message : e}`,
        );
        return EMPTY_IDLE_REPORT;
      }
    }
    switch (classifyRecipientLiveness({ ownerId, inRoster, activeWatchers })) {
      case 'idle':
        idle.push(ownerId);
        break;
      case 'live':
        live.push(ownerId);
        break;
      case 'unknown':
        unknown.push(ownerId);
        break;
    }
  }
  return { idle, live, unknown, degraded: false };
}
