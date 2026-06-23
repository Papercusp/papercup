/**
 * overwatch/brief-types — the OverwatchBrief contract (C-1) + its renderer.
 * (overwatch-role-2026-06-15 B-02: the KEYSTONE. Land first; B-03/B-05/B-08/B-09
 * stub-consume this.)
 *
 * Overwatch is an always-on autonomous role — a sibling to the Queen — that
 * watches the whole running system (the Queen, the bees, the work-feed, tokens,
 * plans, escalations, the observation lane), detects drift from the system's
 * short-term goals, and makes LIVE course-corrections by NUDGING the running
 * agents (`coord:send`) + recording OBSERVATIONS (never ideas).
 *
 * The `OverwatchBrief` is the system-health snapshot the brief-computer (B-03
 * `computeOverwatchBrief`) produces and the persona (B-05), the UI pane (B-08),
 * and the liveness/cross-monitor (B-09) consume. It is the ACTIONABLE SUBSET of
 * the shared `computeSystemHealth` model (D-006): the health panels + the
 * detected anomalies + the suggested nudges. THIS file pins the shape + the
 * render only — NO data-gathering (that's B-03).
 *
 * The renderer is PURE + deterministic: it reads only the brief (no `Date.now` /
 * `Math.random`), so the same brief always renders the same bytes and it
 * unit-tests with no DB. The rendered block is injected into the overwatch's
 * wake prompt via `--append-system-prompt` (B-04), mirroring `renderQueenBrief`.
 *
 * The role's WRITE-to-the-world verbs are exactly `coord:send` (nudge),
 * `coord:escalate`, and `improvements:capture` (observe). It acts on AGENTS,
 * never on WORK placement — that hard Queen-boundary (D-001) is encoded in the
 * `SuggestedAction` vocabulary: nudge / escalate / observe, never "re-place".
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Health panels — the objective floor (the actionable subset of SystemHealth).
 * Every panel is a small fixed-shape digest of counts/flags, never a raw dump.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The Queen's liveness + cadence, as overwatch sees it. */
export interface OverwatchQueenHealth {
  /** When the Queen last woke (ISO-8601), or null if unknown / never. */
  lastWakeAt: string | null;
  /** True when she has stalled — last wake older than her cadence threshold (the 2026-06-15 opus-pacing case). */
  stalled: boolean;
  /** True when she is waking on her expected cadence. */
  cadenceOk: boolean;
  /** Count of placements she is driving to terminal (her in-flight completion mandate). */
  workingTracked: number;
  /** Her next scheduled wake (ISO-8601), or null if none is declared. */
  nextFireAt: string | null;
  /** The Queen's resolvable coord owner id — `coord:send` a nudge here and it lands
   *  in her next wake brief's inbox (she folds `readInbox(resolveQueenOwner)` into
   *  every wake). null = no recent Queen session to address → escalate instead. */
  coordOwner: string | null;
  /** Most-recent CONSECUTIVE Queen wakes that ran 0 LLM tokens (the LLM never executed —
   *  infra/rate-limit loss). Feeds the queen-placement-stalled detector. */
  consecutiveZeroTokenWakes: number;
}

/** The worker fleet's health (`fleet:assignments` / `coord:presence`). */
export interface OverwatchBeeHealth {
  /** Bees currently running. */
  running: number;
  /** Bees that completed work in the current window. */
  completed: number;
  /** Bees churning — re-spawning / holding stale claims without forward progress. */
  churning: number;
  /** Dead claims: a live lease held by a dead holder = abandoned work to re-place. */
  deadClaims: number;
}

/** The work-feed (backlog) health — is work actually flowing to the bees? */
export interface OverwatchWorkFeedHealth {
  /** Ready-to-place work items (the frontier size). */
  frontier: number;
  /** Auto-eligible items stuck unplaced (`attempts:0`, not flowing — the EI-584 dead-feed signature). */
  autoEligibleStuck: number;
  /** Dead work-feed routines (EI-584: the feed stopped pumping). */
  deadRoutines: number;
  /** Items blocked on an already-resolved constraint (stranded — re-open candidates). */
  blockedStranded: number;
}

/** The shared token / gateway layer health (rate-governor + gateway telemetry). */
export interface OverwatchTokenHealth {
  /** Rate buckets currently paused (e.g. `['opus','sonnet']`) — the 2026-06-15 RPM-saturation case. */
  pausedBuckets: string[];
  /** Gateway 5h-exhaustion failovers between pool accounts (cumulative). */
  gatewayFailovers: number;
  /** Gateway 429s shed (admission backlog + fail-fast all-throttled). */
  gw429s: number;
  /** Accounts currently available (not exhausted / cooling). */
  accountsAvailable: number;
  /** Gateway WEDGED — every slot pinned + a growing queue + frozen totalRequests (B-GW-5). The
   *  watchdog auto-restarts it; overwatch makes it VISIBLE + escalates if it recurs. */
  gatewayWedged: boolean;
  /** Gateway sustained-throttling — AIMD cut concurrency / fail-fast shedding (capacity pressure). */
  gatewaySustainedThrottle: boolean;
}

/** Plans + escalations health (`plans:*`, `coord:escalations`). */
export interface OverwatchPlanHealth {
  /** Active (started, in-progress) plans. */
  active: number;
  /** Plan items stalled — `wip` with no recent progress. */
  stalledItems: number;
  /** Escalations aging past the attention threshold. */
  agingEscalations: number;
}

/** The observation lane — the system's pre-idea sensor (turn-end-reflection-observations). */
export interface OverwatchObservationHealth {
  /** Observations recorded in the current window. */
  laneCount: number;
  /** Recent observation counts keyed by author role (e.g. `{ queen: 3, worker: 5 }`). */
  recentByRole: Record<string, number>;
}

/** Who-watches-the-watcher cross-liveness (D-004): each role carries the other's heartbeat. */
export interface OverwatchCrossMonitor {
  /** Is the Queen alive (fresh liveness)? A dark Queen raises a `queen-dark` anomaly. */
  queenAlive: boolean;
  /** Is overwatch itself alive? This is the signal the Queen's brief consumes (the reverse leg). */
  overwatchAlive: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Anomalies — the detected drift + the action overwatch would take.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The canonical anomaly vocabulary. B-03's detector emits these; B-11's tests
 * assert against them. EXTEND this union (don't widen to `string`) when B-03
 * adds a detector — the closed set is what keeps the detector, the persona, the
 * UI, and the tests aligned.
 */
export type AnomalyKind =
  | 'queen-stalled' // Queen's lastWakeAt older than the cadence threshold
  | 'queen-placement-stalled' // Queen wakes on cadence but recent wakes ran 0 LLM tokens while a placeable frontier waits (infra/rate-limit stall the cadence signal misses)
  | 'queen-dark' // cross-monitor: the Queen's liveness has gone dark (D-004)
  | 'overwatch-dark' // cross-monitor: overwatch itself has gone dark (surfaced to the Queen)
  | 'token-paused' // a rate bucket (opus/sonnet) is paused — RPM saturation
  | 'work-feed-stuck' // auto-eligible work not flowing (attempts:0) / dead routine (EI-584)
  | 'bees-churning' // bees re-spawning / holding stale claims without progress
  | 'escalation-aging' // an escalation has aged past the attention threshold
  | 'gateway-wedge' // the inference gateway is WEDGED (slots pinned + frozen counter) — B-GW-5
  | 'gateway-throttle' // the gateway is sustained-throttling (AIMD cut concurrency / fail-fast shed)
  | 'observation-dark'; // the observation lane is flat while agents are running

/** Anomaly severity — drives ordering + the persona's urgency. */
export type AnomalySeverity = 'info' | 'warning' | 'critical';

/** The kind of action overwatch can take. NEVER "re-place" — that's the Queen (D-001). */
export type AnomalyActionType = 'nudge' | 'escalate' | 'observe';

/**
 * The action overwatch would take for an anomaly (D-001/D-002):
 *  - `nudge`    → `coord:send` the target agent (auto)
 *  - `observe`  → `improvements:capture { lane: 'observation' }` (auto)
 *  - `escalate` → `coord:escalate` a structural issue it must NOT auto-fix
 */
export interface SuggestedAction {
  type: AnomalyActionType;
  /** Who the action targets — a coord handle (`'queen'`, a bee id) for nudge/escalate. Omitted for observe. */
  target?: string;
  /** The nudge / escalation / observation text overwatch would send. */
  message?: string;
}

/** One detected drift from the system's short-term goals + its suggested action. */
export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** A short subject — what the anomaly is about (e.g. `'queen'`, `'opus bucket'`, `'F-FIX-021'`). */
  subject: string;
  /** Human-readable detail — the sensor reading that tripped it. */
  detail: string;
  /** The action overwatch would take. Nudge/observe are auto; escalate is for structural issues (D-002). */
  suggestedAction: SuggestedAction;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The brief.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The OverwatchBrief (C-1) — the system-health snapshot for one wake. v1 scopes
 * to ONE hive (D-005, per-hive first; the shape is workspace-extensible in v2).
 */
/** One coord message addressed to the overwatch, pre-folded into the brief (the
 *  `coord:inbox` digest — mirrors the Queen's BriefInboxItem). */
export interface OverwatchInboxItem {
  /** The envelope kind (message / handoff / escalation / ack / …). */
  kind: string;
  /** Sender handle, if any. */
  from?: string;
  /** One-line summary (or the body head), capped. */
  summary: string;
}

export interface OverwatchBrief {
  /** The hive this brief monitors (v1 = one hive; D-005 per-hive scope). */
  hiveSlug: string;
  /** What woke overwatch this turn (event key / `'timer'` / `'backstop'`), if known. */
  wokeBy?: string;
  queen: OverwatchQueenHealth;
  bees: OverwatchBeeHealth;
  workFeed: OverwatchWorkFeedHealth;
  tokens: OverwatchTokenHealth;
  plans: OverwatchPlanHealth;
  observations: OverwatchObservationHealth;
  crossMonitor: OverwatchCrossMonitor;
  /** The detected anomalies + each one's suggested action — the actionable payload. */
  anomalies: Anomaly[];
  /** Coord messages addressed to the overwatch since its last wake — pre-folded so
   *  it sees replies / owner directives without a separate `coord:inbox` call
   *  (mirrors the Queen's brief inbox). Omitted/empty when none. */
  inbox?: readonly OverwatchInboxItem[];
}

/** Per-section list caps so the brief stays a DIGEST, never a raw dump. */
export interface OverwatchBriefCaps {
  /** Max anomaly lines before a "+N more" overflow line. */
  anomalies: number;
}

export const DEFAULT_OVERWATCH_BRIEF_CAPS: OverwatchBriefCaps = {
  anomalies: 20,
};

/**
 * The neutral / fail-soft default brief: everything healthy + zeroed, no
 * anomalies. B-03 STARTS here and fills each field as its reads succeed, so a
 * single flaky read degrades that one field instead of killing the whole brief
 * (the B-03 fail-soft requirement). Also the construction seam for B-08/B-09
 * stubs + tests. NOT data-gathering — a static shape, no I/O.
 */
export function emptyOverwatchBrief(hiveSlug: string): OverwatchBrief {
  return {
    hiveSlug,
    queen: { lastWakeAt: null, stalled: false, cadenceOk: true, workingTracked: 0, nextFireAt: null, coordOwner: null, consecutiveZeroTokenWakes: 0 },
    bees: { running: 0, completed: 0, churning: 0, deadClaims: 0 },
    workFeed: { frontier: 0, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 0 },
    tokens: { pausedBuckets: [], gatewayFailovers: 0, gw429s: 0, accountsAvailable: 0, gatewayWedged: false, gatewaySustainedThrottle: false },
    plans: { active: 0, stalledItems: 0, agingEscalations: 0 },
    observations: { laneCount: 0, recentByRole: {} },
    crossMonitor: { queenAlive: true, overwatchAlive: true },
    anomalies: [],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The control-state view (B-08 UI pane).
 *
 * NOT part of the C-1 brief — a small PURE projection of the overwatch's
 * persisted control bit + cadence (B-07 control-state.ts) + its liveness (B-09
 * liveness.ts), read by the `overwatch.controlState` sync resolver and rendered
 * as the pane's header. Kept here (the pure contract module) so the operator-vite
 * SPA imports it WITHOUT pulling the DB-touching read surface (snapshot.ts) into
 * the client bundle — mirrors how `system-health/types.ts` is the client-safe
 * type home for the Health tab.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OverwatchControlState {
  /** The hive the overwatch supervises (D-005 per-hive); null when none resolvable. */
  hiveSlug: string | null;
  /** The persisted `overwatch_started` bit (B-07) — true = the loop should be running. */
  started: boolean;
  /** The configured wake cadence in seconds (B-07; default 600). */
  cadenceSec: number;
  /** The `papercusp-overwatch` activation flag (D-009). `started && !flagEnabled` = PRE-ARMED. */
  flagEnabled: boolean;
  /** A live `overwatch-wake` routine row with a next fire exists (B-09 liveness). */
  armed: boolean;
  /** The next armed wake (ISO-8601), or null if none. */
  nextWakeAt: string | null;
  /** The last wake fire (ISO-8601), or null if never fired. */
  lastWakeAt: string | null;
  /** ms since the last wake fire, or null (never fired). */
  staleForMs: number | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The liveness / heartbeat view (the "is-it-alive?" strip).
 *
 * The control-state's `armed` / `lastWakeAt` derive from the ONE-SHOT
 * `overwatch-wake` routine row, which is DEACTIVATED the instant it fires —
 * between cadence fires that row is `active=false, next_fire_at=NULL`, so the
 * pane couldn't distinguish a healthy-between-runs overwatch from a dead one
 * (a healthy running overwatch looked identical to a dead one — the whole point
 * of this strip). The AUTHORITATIVE proof-of-life is instead the
 * `harness_shared.autoloop_state` row (role='overwatch'): EVERY actual fire
 * stamps `last_fired_at` + `last_status` + `consecutive_errors` there, via the
 * loop's `recordFire(... 'overwatch' ...)`. This projection reads THAT row plus
 * the configured cadence, and derives the next-run estimate + the ALIVE/STALE
 * verdict. Pure shape (client-safe); the DB read lives in snapshot.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One recent overwatch run (from `autoloop_state`; v1 has only the latest row). */
export interface OverwatchRun {
  /** When the run fired (ISO-8601). */
  firedAt: string;
  /** The recorded status (`'ok'` | `'firing'` | `'no-session-now'` | `'error: …'`). */
  status: string;
  /** True when the status reads as a healthy fire (not an `error:` status). */
  ok: boolean;
}

export interface OverwatchLiveness {
  /** The hive the overwatch supervises (D-005 per-hive); null when none resolvable. */
  hiveSlug: string | null;
  /** The persisted `overwatch_started` bit — the loop is supposed to be running. */
  started: boolean;
  /** The `papercusp-overwatch` activation flag (D-009). started && !flagEnabled = PRE-ARMED. */
  flagEnabled: boolean;
  /** The configured wake cadence in seconds (default 600). */
  cadenceSec: number;
  /** The last ACTUAL overwatch fire (ISO-8601) from `autoloop_state`, or null if never. */
  lastRunAt: string | null;
  /** The status of the last fire (`'ok'` | `'firing'` | `'error: …'`), or null if never. */
  lastStatus: string | null;
  /** Consecutive fire-path errors (the autoloop circuit counter). */
  consecutiveErrors: number;
  /** ms since the last fire, or null (never fired). */
  ageMs: number | null;
  /** Derived next-run estimate (lastRunAt + cadence), ISO-8601, or null if never fired. */
  nextRunAt: string | null;
  /** ms until the next estimated run (negative when overdue), or null if never fired. */
  nextRunInMs: number | null;
  /** ALIVE verdict: started + flag on + a fire within 2× cadence. A never-fired-yet
   *  but just-started loop is treated as pending (alive=false, stale=false). */
  alive: boolean;
  /** STALE verdict: started + flag on but the last fire is older than 2× cadence
   *  (the loop should be firing on cadence but isn't) — the dead-overwatch signal. */
  stale: boolean;
  /** Up to ~5 recent runs, newest first (v1: the single latest `autoloop_state` row). */
  recentRuns: OverwatchRun[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * The renderer.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The action verb shown per anomaly line — uppercase for scan-ability. */
const ACTION_VERB: Record<AnomalyActionType, string> = {
  nudge: 'NUDGE',
  escalate: 'ESCALATE',
  observe: 'OBSERVE',
};

/** A stable severity rank so anomalies render most-urgent-first, deterministically. */
const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function renderAnomalyLine(a: Anomaly, i: number): string {
  const act = a.suggestedAction;
  const verb = ACTION_VERB[act.type];
  const target = act.target ? ` ${act.target}` : '';
  const message = act.message ? `: ${act.message}` : '';
  return `${i + 1}. [${a.severity}] ${a.kind} — ${a.subject}: ${a.detail} → ${verb}${target}${message}`;
}

/** Render `recentByRole` deterministically (role-sorted), or `none` when empty. */
function renderByRole(byRole: Record<string, number>): string {
  const entries = Object.entries(byRole).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([role, n]) => `${role} ${n}`).join(', ');
}

/**
 * Render the OverwatchBrief as a deterministic markdown block — the text
 * injected into the overwatch's wake prompt (mirrors `renderQueenBrief`). The
 * renderer does NOT add `<system-reminder>` tags; the prompt assembler does.
 *
 * The ANOMALIES section comes first because it is the actionable payload — the
 * persona acts on it. The health panels follow as supporting context. Anomalies
 * render most-severe-first (stable sort: severity, then input order), so the
 * critical drift is always at the top.
 */
export function renderOverwatchBrief(brief: OverwatchBrief, caps?: Partial<OverwatchBriefCaps>): string {
  const cap = { ...DEFAULT_OVERWATCH_BRIEF_CAPS, ...caps };
  const out: string[] = [];

  out.push(`## Overwatch wake brief — system-health snapshot for ${brief.hiveSlug}`);
  out.push(
    'This is the deterministic snapshot the watchdog computed for this wake — the state of ' +
      "the hive's Queen, bees, work-feed, tokens, plans, and observation lane, plus the " +
      'anomalies detected and the action suggested for each. Act on the anomalies: NUDGE the ' +
      'relevant agent (`coord:send`), record an OBSERVATION (`improvements:capture` ' +
      "lane:observation), or ESCALATE a structural issue you must NOT auto-fix (`coord:escalate`). " +
      'You NUDGE agents; you never re-place work — that is the Queen.',
  );

  if (brief.wokeBy && brief.wokeBy.trim()) {
    out.push('');
    out.push(`**Woke by:** ${brief.wokeBy.trim()}`);
  }

  // ANOMALIES — the actionable payload. Always present (heading even when empty,
  // so "system healthy" is an explicit, trustworthy signal, not an omission).
  out.push('');
  out.push('### Anomalies — detected this wake (act on these)');
  if (brief.anomalies.length === 0) {
    out.push('_no anomalies — system healthy._');
  } else {
    // Stable sort: most-severe first, ties keep input order (deterministic).
    const ordered = brief.anomalies
      .map((a, idx) => ({ a, idx }))
      .sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || x.idx - y.idx)
      .map(({ a }) => a);
    for (let i = 0; i < Math.min(ordered.length, cap.anomalies); i++) {
      out.push(renderAnomalyLine(ordered[i], i));
    }
    const overflow = ordered.length - cap.anomalies;
    if (overflow > 0) out.push(`…+${overflow} more (drill into the full brief)`);
  }

  // INBOX — coord messages addressed to the overwatch (pre-folded, like the Queen's
  // brief). Rendered only when present; `coord:inbox` pages deeper.
  if (brief.inbox && brief.inbox.length > 0) {
    out.push('');
    out.push('### Inbox — coord messages for you (act/ack as needed)');
    for (const m of brief.inbox) {
      out.push(`- [${m.kind}]${m.from ? ` ${m.from}:` : ''} ${m.summary}`);
    }
  }

  // HEALTH PANELS — supporting context (one line each).
  const q = brief.queen;
  out.push('');
  out.push('### Queen');
  out.push(
    `- last woke ${q.lastWakeAt ?? 'unknown'}${q.stalled ? ' [STALLED]' : ''} · cadence ${q.cadenceOk ? 'ok' : 'OFF'} · ` +
      `driving ${q.workingTracked} placement(s) · next ${q.nextFireAt ?? 'unscheduled'}`,
  );
  // The address for a Queen nudge: coord:send here lands in her next wake brief's
  // inbox (she reads it every wake). null ⇒ no recent Queen session → escalate.
  out.push(
    q.coordOwner
      ? `- nudge the Queen via \`coord:send { to: ['${q.coordOwner}'], wake: 'optimistic', summary, body }\` (lands in her next wake brief)`
      : `- nudge channel: no resolvable Queen coord owner right now — ESCALATE Queen-targeted drift instead of nudging`,
  );

  const b = brief.bees;
  out.push('');
  out.push('### Bees');
  out.push(
    `- running ${b.running} · completed ${b.completed} · churning ${b.churning} · dead claims ${b.deadClaims}`,
  );

  const wf = brief.workFeed;
  out.push('');
  out.push('### Work feed');
  out.push(
    `- frontier ${wf.frontier} ready · ${wf.autoEligibleStuck} auto-eligible stuck · ` +
      `${wf.deadRoutines} dead routine(s) · ${wf.blockedStranded} stranded (blocked on a resolved constraint)`,
  );

  const t = brief.tokens;
  out.push('');
  out.push('### Tokens / gateway');
  out.push(
    `- paused buckets: ${t.pausedBuckets.length ? t.pausedBuckets.join(', ') : 'none'} · ` +
      `${t.gatewayFailovers} failover(s) · ${t.gw429s} 429(s) · ${t.accountsAvailable} account(s) available` +
      `${t.gatewayWedged ? ' · ⚠ GATEWAY WEDGED' : t.gatewaySustainedThrottle ? ' · gateway throttling' : ''}`,
  );

  const p = brief.plans;
  out.push('');
  out.push('### Plans + escalations');
  out.push(`- ${p.active} active plan(s) · ${p.stalledItems} stalled item(s) · ${p.agingEscalations} aging escalation(s)`);

  const o = brief.observations;
  out.push('');
  out.push('### Observation lane');
  out.push(`- ${o.laneCount} observation(s) this window · by role: ${renderByRole(o.recentByRole)}`);

  const cm = brief.crossMonitor;
  out.push('');
  out.push('### Cross-monitor (who-watches-the-watcher)');
  out.push(`- queen ${cm.queenAlive ? 'alive' : 'DARK'} · overwatch ${cm.overwatchAlive ? 'alive' : 'DARK'}`);

  return out.join('\n');
}
