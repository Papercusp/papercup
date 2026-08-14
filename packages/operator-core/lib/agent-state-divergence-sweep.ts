/**
 * agent-state-divergence-sweep.ts — P-010's DELIVERY half
 * (unified-agent-state-plane-2026-07-27 P-010, per D-016 and D-046).
 *
 * The verdict itself is computed by the pure detector in
 * `agent-state-divergence.ts`; this module is the PG read, the debounce, and the
 * notification ordering. Same chassis as the sibling watchdogs
 * (`wall-lapse-watchdog.ts`, rubric-staleness, release-deploy-staleness): a pure
 * formatter unit-tested with no DB, a thin sweep wired into the shared
 * `routinesTick` as one durable step, fail-soft throughout, and the shared
 * fires-ledger debounce so a still-flailing agent is paged once per window
 * rather than once per tick.
 *
 * ── WHY A SWEEP AND NOT A TOOL ──────────────────────────────────────────────
 *
 * D-046 refuses a pull read over `tool_invocations` — three already exist and
 * all three are dead. D-016 puts P-010 in the STRUCTURAL tier and D-047 row 15
 * records its enforcement as "they run on their own". So the finding must come
 * to the agent; the agent must never have to remember to go and look for it.
 *
 * ── NOTIFY THE AGENT ITSELF FIRST, THEN THE LEADER ──────────────────────────
 *
 * P-010 is explicit about the ordering, and the ordering is the point: an agent
 * that is told "you have failed `work_items:claim` 5× in 4 minutes" can fix
 * itself on its next turn, which is both the cheapest repair available and the
 * only one that does not spend a second agent's attention. The escalation to the
 * leader is the BACKSTOP for when self-correction did not happen — so it fires
 * only on a REPEAT finding for the same (owner, tool), never on first sight.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  detectIntentActionDivergence,
  deliverableKinds,
  explainZero,
  isStructuralZero,
  RETRY_THRASH_THRESHOLD,
  THRASH_WINDOW_MS,
  type Divergence,
  type DivergenceCall,
  type DivergenceReport,
} from './agent-state-divergence';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { claimWatchdogFire, recentWatchdogFires } from './pot/watchdog';
import { openEscalation } from './agent-tools/coordination/escalations';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** How far back each sweep looks. Comfortably wider than THRASH_WINDOW_MS so a
 *  run straddling the tick boundary is still seen whole. */
export const SWEEP_LOOKBACK_MS = 30 * 60_000;

/** Re-notify the same (owner, tool) at most once per this many hours. */
export const DIVERGENCE_DEBOUNCE_HOURS = 6;

/**
 * How far back to look for a PRIOR notification when deciding whether this is a
 * repeat. A finding inside this window that is NOT inside the debounce window
 * means: we already told the agent, the debounce has since expired, and it is
 * flailing the same way again — i.e. self-correction did not happen, which is
 * exactly when the leader is worth spending.
 */
export const DIVERGENCE_REPEAT_LOOKBACK_HOURS = 24;

/** Row cap per sweep — a bound on work, never on the counts a verdict reports. */
export const SWEEP_ROW_CAP = 20_000;

const DEFAULT_INSTALL_SLUG = 'papercusp';

/** Synthetic identity for the background notification (mirrors the siblings). */
const DIVERGENCE_IDENTITY: AgentIdentity = {
  ownerId: 'intent-divergence-detector',
  ownerLabel: 'system · intent-divergence-detector',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// ── pure formatter (unit-tested without DB) ─────────────────────────────────

/**
 * PURE: the message an agent receives about its own divergence.
 *
 * Written in the second person and leading with the concrete evidence, because
 * the recipient is the agent that can fix it. It deliberately does NOT tell the
 * agent what to do instead — the detector knows that a run did not converge, not
 * why, and inventing a remedy would be exactly the prose inference this item's
 * sibling (P-011) forbids.
 */
export function formatDivergenceAlert(d: Divergence): { summary: string; body: string } {
  if (d.kind === 'unconverged-retry-loop') {
    const r = d.retryLoop;
    const attempts = r?.attempts ?? RETRY_THRASH_THRESHOLD;
    const mins = Math.round(THRASH_WINDOW_MS / 60_000);
    const evidence: string[] = [];
    if (r?.identicalRetries) {
      evidence.push(
        `${r.identicalRetries} of those retries re-sent BYTE-IDENTICAL arguments — a deterministic refusal cannot change its answer, so those attempts could not have succeeded`,
      );
    }
    if (r?.argsChangedTransitions) {
      evidence.push(`${r.argsChangedTransitions} attempt(s) varied the arguments without converging`);
    }
    if (r?.fallbackObserved) {
      evidence.push('you also fell back to another verb in the same namespace mid-run');
    }
    return {
      summary: `You called ${d.a.toolName} ${attempts}× in ${mins}min and every attempt failed`,
      body:
        `${d.detail}\n\n` +
        `First attempt: call ${d.a.callId} at ${d.a.invokedAt} (${d.a.status}).\n` +
        `Last attempt: call ${d.b.callId} at ${d.b.invokedAt} (${d.b.status}).\n` +
        (evidence.length ? `\n${evidence.map((e) => `• ${e}`).join('\n')}\n` : '') +
        `\nThis is a REASONING-ACTION MISMATCH signal (MAST FM-2.6): the action kept repeating while ` +
        `whatever made it fail did not change. It is not an accusation — a single failure you then fixed is ` +
        `never reported, and the threshold (${RETRY_THRASH_THRESHOLD} in ${mins}min) was set from measured ` +
        `fleet data precisely so self-correction is not flagged. Re-read the error text before the next ` +
        `attempt, or take a different route.`,
    };
  }
  return {
    summary: `Your declared intent spans two goals (${d.a.goalRef} and ${d.b.goalRef}) without a re-declaration`,
    body:
      `${d.detail}\n\n` +
      `Intent event ${d.intentEventId} was declared once, but calls made under it carry different goal refs ` +
      `(call ${d.a.callId} → ${d.a.goalRef}, call ${d.b.callId} → ${d.b.goalRef}).\n\n` +
      `Peers read your declared intent to decide what NOT to pick up. When the goal moves and the ` +
      `declaration does not, that read is wrong for everyone but you. Re-declare via coord:orient { intent } ` +
      `when you change goals — or, if this is a mis-stamp rather than real drift, say so.`,
  };
}

/** Debounce key — per (owner, tool), so two genuinely different flails page
 *  independently rather than one masking the other. */
export function divergenceFireKey(d: Divergence): string {
  return `${d.ownerId}:${d.kind === 'unconverged-retry-loop' ? d.a.toolName : `intent-${d.intentEventId}`}`;
}

/**
 * The `reason` a fire is recorded under — and the reason the debounce WORKS.
 *
 * `recentWatchdogFires`/`claimWatchdogFire` match a `scopeKey` as
 * `reason LIKE '%scopeKey%'`, so the caller MUST embed the key verbatim in the
 * reason it records. This sweep previously recorded the bare summary, which
 * never contains the `<ownerId>:<toolName>` key — so the lookup could not match,
 * `priorFires` was structurally always 0, and the debounce silently never fired.
 * Measured cost: 113 fires across only 2 distinct conditions in 37 minutes
 * (~one per 20s, forever), and ~91% of one agent's inbox left as coalesced
 * duplicates. The same dead lookup also pinned `isRepeat` to false, so the
 * leader-escalation backstop had never once fired either (EI-18824142520274965).
 */
export function divergenceFireReason(key: string, summary: string): string {
  return `[${key}] ${summary}`;
}

// ── the PG read ──────────────────────────────────────────────────────────────

interface CallRow {
  id: string | number;
  owner: string;
  tool_name: string;
  status: string | null;
  invoked_at: string | Date;
  intent_event_id: string | number | null;
  goal_ref: string | null;
  args_json: unknown;
  call_origin: string | null;
}

/**
 * Recent calls for the sweep window.
 *
 * ⚠ `id` and `intent_event_id` are BIGINT, and postgres-js returns bigint as a
 * STRING. Coercing here (rather than trusting the driver) is the same trap
 * P-024 hit on `assumption_set_id` — a string watermark silently fails every
 * numeric comparison downstream without ever throwing.
 */
export async function loadRecentCalls(opts: {
  workspaceId: string;
  sinceMs: number;
  sql?: Sql;
  limit?: number;
}): Promise<DivergenceCall[]> {
  const sql = opts.sql ?? getOrgPg().sql;
  const since = new Date(opts.sinceMs).toISOString();
  const rows = await sql<CallRow[]>`
    SELECT id, coord_owner_id AS owner, tool_name, status, invoked_at,
           intent_event_id, goal_ref, args_json, call_origin
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND invoked_at > ${since}
       AND coord_owner_id IS NOT NULL
       -- coord:emit is the canonical MACHINE lifecycle fire-target. It is
       -- telemetry about a declaration/claim/completion that just happened,
       -- never the agent-authored action this detector judges. In particular,
       -- an intent declaration mutates the live goal before its reaction emits:
       -- the emit can therefore carry the OLD goal under the NEW intent event
       -- id. Comparing it with the first post-declaration call manufactures a
       -- goal drift on every legitimate goal transition (WI-38670).
       --
       -- Exclude the whole surface, not only category='intent': emit.ts defines
       -- every call as system-authored lifecycle. Contextual agent traffic uses
       -- coord:send and remains eligible evidence.
       AND tool_name <> 'coord:emit'
       -- Platform reaction rows are telemetry about the wake mechanism, not
       -- agent-authored actions. Keep the predicate deliberately narrow: an
       -- unattributed pot:wake with the event source and its stamped reason.
       AND NOT (
         tool_name = 'pot:wake'
         AND call_origin IS NULL
         AND args_json->>'source' = 'event'
         AND args_json->>'reason' LIKE 'subscribed event (%'
       )
     ORDER BY invoked_at
     LIMIT ${opts.limit ?? SWEEP_ROW_CAP}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    ownerId: r.owner,
    toolName: r.tool_name,
    status: r.status,
    invokedAt: r.invoked_at instanceof Date ? r.invoked_at.toISOString() : String(r.invoked_at),
    intentEventId: r.intent_event_id == null ? null : Number(r.intent_event_id),
    goalRef: r.goal_ref,
    args: r.args_json ?? undefined,
  }));
}

/**
 * Which of these goal refs are already FINISHED (P-010, EI-18830083673617307).
 *
 * ⚠ DERIVED FROM `ANY_FAMILY_TERMINAL_STATES`, NEVER RE-LISTED. A goal ref can be
 * either kind-family (EI-/WI- issue, F- feature) and the two spell their terminals
 * differently, so the union is the only correct set here. That constant's own
 * docstring records what re-listing costs: placement-watchdog hand-copied the union,
 * missed the `done`/`dropped` added by work-item-status-full-unify, and reported
 * ~88% phantoms because every consumer reads "not in the set ⇒ still active" — which
 * is exactly how THIS function is read too.
 *
 * Returns only the terminal subset; a ref absent from `work_items` entirely is NOT
 * treated as terminal, because "I could not find it" is not "it is finished".
 */
export async function loadTerminalGoalRefs(opts: {
  workspaceId: string;
  goalRefs: readonly string[];
  sql?: Sql;
}): Promise<Set<string>> {
  const refs = [...new Set(opts.goalRefs.filter((r) => r != null && r !== ''))];
  if (refs.length === 0) return new Set();
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${opts.workspaceId}
       AND feature_id = ANY(${refs as string[]}::text[])
       AND status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
  `;
  return new Set(rows.map((r) => r.feature_id));
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface DivergenceSweepOutcome {
  key: string;
  outcome: 'notified' | 'escalated' | 'debounced' | 'suppressed' | 'error';
  reason: string;
}

export interface DivergenceSweepResult {
  outcomes: DivergenceSweepOutcome[];
  /** The verdict's own coverage — carried out so a caller can log the fill rate
   *  without re-running anything. Null when the read itself failed. */
  report: DivergenceReport | null;
}

export interface DivergenceSweepDeps {
  loadRecentCalls?: typeof loadRecentCalls;
  loadTerminalGoalRefs?: typeof loadTerminalGoalRefs;
  recentWatchdogFires?: typeof recentWatchdogFires;
  claimWatchdogFire?: typeof claimWatchdogFire;
  openEscalation?: typeof openEscalation;
  sendMessage?: typeof sendMessage;
  workspaceId?: string;
  installSlug?: string;
  now?: number;
  sql?: Sql;
}

/**
 * One sweep: read the window, detect, then notify each affected agent once per
 * debounce window — escalating to the leader ONLY on a repeat.
 *
 * Fail-soft per finding AND overall: a detector that throws guards nothing.
 */
export async function divergenceSweep(deps: DivergenceSweepDeps = {}): Promise<DivergenceSweepResult> {
  const now = deps.now ?? Date.now();
  const workspaceId = deps.workspaceId ?? 'papercusp-workspace';
  const installSlug = deps.installSlug ?? DEFAULT_INSTALL_SLUG;
  const outcomes: DivergenceSweepOutcome[] = [];

  let calls: DivergenceCall[];
  try {
    calls = await (deps.loadRecentCalls ?? loadRecentCalls)({
      workspaceId,
      sinceMs: now - SWEEP_LOOKBACK_MS,
      sql: deps.sql,
    });
  } catch (e) {
    return {
      outcomes: [{ key: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) }],
      report: null,
    };
  }

  // P-010: resolve which cited goals are already finished, so the stamped leg
  // cannot page about drift between two CLOSED work-items — a finding no
  // re-declaration could ever reconcile, and the half of
  // EI-18830083673617307 that made the alert unactionable rather than merely loud.
  //
  // ⚠ FAIL CLOSED, not open. If this read fails we do NOT fall back to the
  // unfiltered behaviour: that is precisely the bug, and a silent fallback would
  // reinstate it exactly when the DB is least healthy. The goal leg is withheld
  // for this sweep instead; the sampling leg, which needs no goal state, is
  // unaffected.
  let terminalGoalRefs: Set<string> | undefined;
  let terminalLoadError: string | null = null;
  try {
    terminalGoalRefs = await (deps.loadTerminalGoalRefs ?? loadTerminalGoalRefs)({
      workspaceId,
      goalRefs: calls.map((c) => c.goalRef).filter((g): g is string => g != null && g !== ''),
      sql: deps.sql,
    });
  } catch (e) {
    terminalLoadError = e instanceof Error ? e.message : String(e);
  }

  // `now` is threaded in so the detector can apply CONVERGENCE_SETTLE_MS — a run
  // whose fix may simply not have happened yet is deferred to a later sweep
  // instead of being reported as un-converged.
  const report = detectIntentActionDivergence(calls, { now, terminalGoalRefs });

  // The per-leg delivery gate (P-011's ordering rule, applied per leg because
  // the stamped leg is structurally empty until P-009 deploys while the sampling
  // leg has live input today). A finding from a leg that could not really run is
  // not deliverable, however it looks.
  const allowed = new Set(deliverableKinds(report.coverage));
  if (terminalLoadError) allowed.delete('goal-drift-within-intent');

  if (report.divergences.length === 0) {
    const z = report.structuralZero;
    return {
      outcomes: [
        {
          key: '*',
          outcome: 'suppressed',
          reason: z ? `${isStructuralZero(z) ? 'STRUCTURAL ZERO' : 'clean'}: ${explainZero(z)}` : 'no findings',
        },
      ],
      report,
    };
  }

  for (const d of report.divergences) {
    const key = divergenceFireKey(d);
    try {
      if (!allowed.has(d.kind)) {
        outcomes.push({
          key,
          outcome: 'suppressed',
          reason: terminalLoadError && d.kind === 'goal-drift-within-intent'
            ? `goal state unresolvable, so terminal goals could not be excluded — withheld rather than risk paging about closed work: ${terminalLoadError}`
            : `leg '${d.kind}' did not have enough coverage to deliver from`,
        });
        continue;
      }

      // Already told this agent about this exact flail inside the repeat window?
      // Then the cheap self-correction path was tried and did not take.
      //
      // Read BEFORE the claim below, which inserts a row of its own — reading it
      // after would count this very fire and pin `isRepeat` to true forever.
      const isRepeat =
        (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
          workspaceId,
          installSlug,
          DIVERGENCE_REPEAT_LOOKBACK_HOURS,
          'intent-action-divergence',
          key,
        )) > 0;

      const { summary, body } = formatDivergenceAlert(d);

      // Claim the debounce slot ATOMICALLY, and only notify if we won it.
      // `claimWatchdogFire` replaces the old check-then-act pair
      // (`recentWatchdogFires(...) > 0` … later … `recordFire(...)`), which
      // races every concurrent tick into duplicate pages (EI-6777) — the very
      // shape this sweep was firing in. The claim still precedes the notify, so
      // a crash mid-delivery cannot re-page forever.
      const claimed = await (deps.claimWatchdogFire ?? claimWatchdogFire)({
        workspaceId,
        installSlug,
        source: 'intent-action-divergence',
        reason: divergenceFireReason(key, summary),
        wakeAt: null,
        windowHours: DIVERGENCE_DEBOUNCE_HOURS,
        scopeKey: key,
      });
      if (!claimed) {
        outcomes.push({ key, outcome: 'debounced', reason: 'fires-ledger debounce' });
        continue;
      }

      // THE AGENT ITSELF, FIRST — always, and on its own the first time.
      await (deps.sendMessage ?? sendMessage)(DIVERGENCE_IDENTITY, {
        to: [d.ownerId],
        summary,
        body,
        category: 'self-correction',
      });

      if (!isRepeat) {
        outcomes.push({ key, outcome: 'notified', reason: summary });
        continue;
      }

      // THEN THE LEADER — only on a repeat. Escalating on first sight would
      // spend a second agent's attention on something the first agent was about
      // to fix itself, which is how a detector becomes a thing people mute.
      await (deps.openEscalation ?? openEscalation)(DIVERGENCE_IDENTITY, {
        // EscalationSeverity is 'blocker' | 'question' | 'advisory' — there is no
        // 'warning'. 'advisory' is the correct member, not merely the compiling one:
        // a repeat divergence draws a leader's attention but blocks nothing and asks
        // no decision, which is exactly what separates advisory from blocker/question.
        severity: 'advisory',
        summary: `REPEAT: ${summary}`,
        body:
          `${body}\n\n` +
          `This agent was already notified about the same (owner, tool) within the last ` +
          `${DIVERGENCE_REPEAT_LOOKBACK_HOURS}h and is flailing the same way again, so self-correction ` +
          `did not take. Escalated per P-010's "notify the agent itself first, then the leader".`,
      });
      outcomes.push({ key, outcome: 'escalated', reason: `repeat — ${summary}` });
    } catch (e) {
      outcomes.push({ key, outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { outcomes, report };
}
