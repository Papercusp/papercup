/**
 * await-event primitive — shared types (await-event-primitive-2026-06-05).
 *
 * The layering (plan D-001): SOURCES resolve who an event concerns and call
 * `emitAwaitedEvent`; the DELIVERY layer here is dumb and uniform — deliver
 * event E to its addressed recipients, honoring each recipient's declared
 * policy (`wake` = re-invoke me, `notify` = put it in my coord inbox). No
 * cardinality lives in the primitive: a lock grants to ONE waiter by emitting
 * a targeted `lock:grant:<ticket>` key; CI-green broadcasts; both are plain
 * emits here.
 */

/** How a fired event reaches a subscriber (plan D-002). `announce` (EI-9270) is
 *  NOT a delivery policy: it marks an emitter-side DECLARATION row ("this gate
 *  key WILL fire — await it") that never wakes anyone itself; every delivery
 *  path excludes it, and the real emit stamps its `fired_at` as the LATCH. */
export type AwaitPolicy = 'wake' | 'notify' | 'announce';

/** What happens when an await's deadline passes without the event (D-009):
 *  `wake` = synthesize a timeout wake (the agent learns the event did NOT
 *  happen — as actionable as the event itself for a blocked agent);
 *  `expire` = lapse silently (visible in events:status, no turn spent). */
export type TimeoutBehavior = 'expire' | 'wake';

/**
 * The fallback timeout-wake window: the default deadline for a one-shot wake
 * await when the caller names none (await-timeout-fallback-defaults-2026-07-03).
 *
 * The fallback exists so an agent BLOCKED on an event that never fires is
 * auto-woken (a `timeout` wake, `fired_reason='timeout'`) to re-orient, instead
 * of hanging until a human notices. It was 4h — far below the owner's actual
 * check-in cadence, so blocked agents sat dead for hours. 30min matches "a human
 * would have looked by now". This is the ONE source of truth: events:await,
 * watch:create, and the events sugar verbs all import it (it replaced three
 * duplicated `DEFAULT_TIMEOUT_SEC = 4 * 60 * 60` copies).
 */
export const AWAIT_DEFAULT_TIMEOUT_SEC = 30 * 60; // 30min

/** Hard cap on a caller-supplied await deadline — shared by every await surface. */
export const AWAIT_MAX_TIMEOUT_SEC = 7 * 24 * 60 * 60; // 7d

/** The session wake-handle stamped onto an await at registration (D-003 —
 *  it cannot be fetched at fire time; the agent is asleep). */
export type WakeHandle =
  | {
      kind: 'adv-session';
      /** harness_shared.adv_sessions.id — re-read at fire time for fresh pid/ended. */
      advSessionId: number;
      /** Which agent CLI backs the session ('claude' | 'codex' | 'omp'). */
      agent: string | null;
      /** The agent's NATIVE session id (claude UUID) — required for an exact
       *  claude resume. NEVER fall back to `--continue` on the shared tree:
       *  most sessions share one cwd, so most-recent-in-cwd resumes the WRONG
       *  agent's conversation. */
      sessionId: string | null;
      ompThreadId: string | null;
      cwd: string | null;
      pid: number | null;
    }
  | {
      kind: 'plan-run';
      /** harness_shared.plan_runs.id — woken via the plans:resume path. */
      runId: number;
    };

export interface AwaitRow {
  id: number;
  workspaceId: string;
  subscriberId: string;
  eventKey: string;
  policy: AwaitPolicy;
  note: string | null;
  wakeHandle: WakeHandle | null;
  timeoutBehavior: TimeoutBehavior;
  expiresTs: string | null;
  createdAt: string;
  firedAt: string | null;
  firedReason: string | null;
  cancelledAt: string | null;
  /** Cardinality (unify-watch-primitive D-001): true = one-shot (fires once,
   *  auto-consumes via fired_at — today's await); false = standing watch (a fire
   *  queues a delivery WITHOUT consuming the row — the pot-style recurring wake). */
  once: boolean;
  /** Per-subscriber wake floor for this watch's wakes, in seconds. null/0 = no floor
   *  (one-shot grants wake promptly); >0 throttles a recurring wake:true watch. */
  minSleepSec: number | null;
  /** A watch whose wakes ALWAYS bypass the floor (a human-message / escalation watch).
   *  OR'd with the emit-time urgent flag onto each delivery. */
  urgency: boolean;
  /** EI-8998: optional predicate evaluated against the emitted PAYLOAD (a
   *  @papercusp/rules DataCondition — the same MatchMap vocabulary as an ECA
   *  rule's `when`), in ADDITION to the key/pattern match. null = no payload
   *  predicate (today's behavior, unchanged fast path). */
  payloadFilter: unknown | null;
  /** EI-9270 (announced gate events): DISCOVERY scope of a policy='announce' row —
   *  who sees the declaration in events:catalog / coord:orient ('fleet'|'plan'|
   *  'harness'|'global'). null on ordinary awaits. The rendezvous plane itself
   *  stays flat (WI-3575); this scopes visibility only. */
  scopeKind: string | null;
  /** The fleet/plan/harness slug for scopeKind; null for 'global' / ordinary rows. */
  scopeRef: string | null;
}

export type DeliveryStatus = 'pending' | 'parked' | 'delivering' | 'delivered' | 'dropped' | 'dead';

/** The wake channel that (eventually) carried a delivery — also the meter's
 *  per-wake attribution dimension (D-007). `coalesced` = this delivery folded into
 *  another wake for the same subscriber (no turn spent — unify-watch-primitive P-005). */
export type WakeChannel =
  | 'pty-inject'
  | 'psu-socket-inject'
  // su-cold-auto-mode-2026-07-03 Phase 2: a COLD loop wake injects a fresh-context
  // RESET-CONTEXT (`/clear` in place, keep the MCP warm) or a periodic RECYCLE
  // (kill+respawn the psu host) carrying the carry-note, instead of a warm
  // `mode:'turn'` inject. Both re-invoke the agent (it re-derives from the note), so
  // both join WAKE_TURN_CHANNELS below. Dormant until a caller wires coldAutoEnabled.
  | 'psu-socket-reset'
  | 'psu-socket-recycle'
  | 'resume'
  | 'resume-headless'
  // The Hive Queen is never resumed — her ended-session wake fires a FRESH hive
  // launch (queen-brief-cache-assembly B-01 / P-012). Burns a turn like a resume.
  | 'hive-fresh-wake'
  // A drained bee warm-injected a NEW work-item is re-routed to a FRESH spawn instead
  // of `--resume`-ing its grown transcript (bee-context-efficiency P-005 / D-018/D-021).
  // Like hive-fresh-wake, it burns a turn (a fresh bee runs the task).
  | 'fresh-context-warm-inject'
  | 'plan-run-resume'
  | 'inbox'
  | 'coalesced';

/** The wake channels that actually burn a turn (re-invoke the agent) — used to derive a
 *  subscriber's `last_woken_at` for the floor. 'inbox'/'coalesced' do NOT burn a turn. */
export const WAKE_TURN_CHANNELS: readonly WakeChannel[] = [
  'pty-inject',
  'psu-socket-inject',
  'psu-socket-reset',
  'psu-socket-recycle',
  'resume',
  'resume-headless',
  'hive-fresh-wake',
  'plan-run-resume',
];

export interface DeliveryRow {
  id: number;
  workspaceId: string;
  awaitId: number;
  subscriberId: string;
  eventKey: string;
  payload: unknown;
  summary: string | null;
  status: DeliveryStatus;
  channel: WakeChannel | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
  /** Bypass the per-subscriber wake floor for this delivery (unify-watch-primitive P-005). */
  urgent: boolean;
  /** The floor (seconds) denormalized from the await, so the pump decides without a join.
   *  null/0 = no floor. */
  minSleepSec: number | null;
  /** How many fires folded into this wake (1 = not coalesced). */
  coalescedCount: number;
  /** Emit-time attribution (migration 387) — e.g. a loop fire's `loop:<routineId>`. Persisted
   *  so the async resume-turn-exit handler can attribute a turn DEATH to its source (the
   *  loop-wake-rate-limit-robustness fix). null = unattributed. */
  source: string | null;
}

/** A delivery row joined with its await's wake handle + note (the pump's unit). */
export interface DeliveryWork extends DeliveryRow {
  wakeHandle: WakeHandle | null;
  note: string | null;
}

/** The wake executor's verdict for one delivery attempt. */
export type WakeOutcome =
  | { kind: 'delivered'; channel: WakeChannel }
  /** Recipient alive but uninjectable (detached terminal) — re-check later;
   *  converts to a resume when the process exits. */
  | { kind: 'park'; reason: string }
  /** Dead waiter (D-004 net #2) — no liveness, nothing resumable. Visible. */
  | { kind: 'drop'; reason: string }
  | { kind: 'error'; error: string };
