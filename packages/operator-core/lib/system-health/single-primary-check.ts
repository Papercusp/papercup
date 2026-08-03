/**
 * single-primary-check — the "exactly one background primary" guard
 * (infra-self-healing-supervision-2026-06-19, R4-2).
 *
 * The background machinery (DBOS routines / git-sync / substrate / the Queen
 * wake-loop) must run on EXACTLY ONE process. Two opposite failures both stem from
 * there being no enforcement:
 *   • 0 primaries — the silent routine-engine death (the BACKGROUND_WORKERS=0
 *     regression / bg-host down: routines, git-sync, Queen all stop, no alarm); and
 *   • >1 primaries — the documented catastrophe (bg-workers on two hosts vs one DB
 *     → DBOS appVersion war, a 102 GB substrate_outbox, plans rewritten 100k×).
 *
 * Each live DBOS executor holds PG connections tagged `dbos_transact_<vmid>_<appver>`
 * (observed in pg_stat_activity); a dead executor's connections are gone. So the
 * count of DISTINCT such application_names = the live background-primary count. This
 * guard runs on a :3070 REQUEST worker (independent of the primary it counts) and on
 * a sustained !=1 escalates to the owner — the request-path enforcement the plan's
 * D-001 calls for ("the watcher must not live in what it watches").
 *
 * HYSTERESIS + SELF-CLEAR (hive-loop-supervision, 2026-06-21): the guard escalates
 * only after a non-1 count PERSISTS `sustainTicks` consecutive checks — so a transient
 * 0 (a bg-host restart / journal-silence-watchdog bounce, or an idle/reconnect gap where
 * the DBOS executor briefly holds no PG connection) never fires a `blocker`. And when
 * the count returns to 1 it AUTO-RESOLVES its own open escalation (a sibling
 * `escalation_resolved`) instead of leaving a stale blocker in the owner's queue. Two
 * such false-positive blockers (09:26Z + 11:14Z 2026-06-21) reached the human while the
 * engine was demonstrably healthy (routines firing, bg-host-ticker alive) — the exact
 * watchdog-determinism drift ("alarms do not self-clear against live state") this guard
 * is supposed to embody, not commit. Read-only otherwise + debounced; env-killable
 * (PAPERCUSP_SINGLE_PRIMARY_GUARD=0).
 *
 * VERIFY THE CONSEQUENCE, DON'T ASSERT IT (EI-19388269294151851, 2026-08-03): a count of
 * 0 used to hardcode the summary "DBOS routines, git-sync, and the Mug wake-loop are all
 * down". That inference held when bg-host was the only process that could run them — and
 * is now false. Measured on 2026-08-03: this guard broadcast that blocker fleet-wide and
 * urgent-paged the owner "SUSTAINED over 72 consecutive checks" (~3.6h) while git-sync
 * committed 66 times in the same window (`git log --since='4 hours ago' | grep -c
 * git-sync`) and every active routine stayed current. Both readings were correct: bg-host
 * genuinely was absent (it restarted at ~00:02:30Z), AND a routines-enabled non-primary
 * host (PAPERCUSP_DBOS_ROUTINES=1, connecting through the ordinary `pcusp:org-*` pool,
 * which carries no `dbos_transact_%` application_name) kept serving the work.
 *
 * So the count alone can no longer name the consequence. The count-0 case is now split on
 * LIVE EVIDENCE — the most recent active-routine fire:
 *   • routines STALE   → the real `no-primary` blocker (unchanged text, unchanged paging);
 *   • routines FIRING  → `no-dedicated-primary`, an ADVISORY: redundancy is degraded and
 *     bg-host needs restoring, but background work is demonstrably not stopped.
 * A false blocker is not a harmless over-report: it trains every agent to discount this
 * alarm, which is exactly what a genuine routine-engine death cannot afford.
 */
import { getOrgPg } from '@papercusp/db-org';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  openEscalation,
  resolveEscalation,
  type EscalationSeverity,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';
import { notifyAttention } from '../attention-notify';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';

export const SINGLE_PRIMARY_IDENTITY: AgentIdentity = {
  ownerId: 'system:single-primary-guard',
  ownerLabel: 'system · single-primary-guard',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

const DEFAULT_INTERVAL_MS = 3 * 60_000;
const DEFAULT_DEBOUNCE_MS = 30 * 60_000;
/** Consecutive non-1 checks required before escalating — the hysteresis that
 *  separates a real sustained outage from a transient idle/reconnect/bg-host-restart
 *  blip. At the default 3-min interval, 2 ⇒ the condition must hold ≥~3–6 min. A
 *  genuine routine-engine death persists; a reconnect gap does not. */
const DEFAULT_SUSTAIN_TICKS = 2;

/** How recently an active routine must have fired for background work to count as
 *  demonstrably ALIVE. Several system routines fire every ~30–60s and the slowest
 *  git-sync tier every ~10min, so this is deliberately generous: it must never call a
 *  genuinely dead engine "firing", which is the only direction that loses a real outage. */
const ROUTINE_FRESH_SEC = 10 * 60;

/**
 * Live evidence about whether background work is ACTUALLY running, gathered independently
 * of the primary count so a count-0 verdict can be checked rather than assumed.
 * `lastRoutineFireAgeSec: null` = not gathered / unknown — the guard then falls back to
 * the historical count-only behaviour rather than inventing a healthier reading.
 */
export interface BackgroundActivityEvidence {
  lastRoutineFireAgeSec: number | null;
}

/** PURE: is background work demonstrably alive on this evidence? Unknown ⇒ false. */
export function routinesDemonstrablyFiring(evidence?: BackgroundActivityEvidence): boolean {
  const age = evidence?.lastRoutineFireAgeSec;
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age <= ROUTINE_FRESH_SEC;
}

export interface PrimaryVerdict {
  count: number;
  ok: boolean;
  severity: EscalationSeverity | null;
  key: string | null;
  summary: string;
}

/**
 * PURE: classify the live background-primary count against live activity evidence.
 * `evidence` is optional so no existing call site is stranded; omitting it preserves the
 * original count-only verdicts exactly.
 */
export function evaluatePrimaryCount(
  count: number,
  evidence?: BackgroundActivityEvidence,
): PrimaryVerdict {
  if (count === 1) {
    return { count, ok: true, severity: null, key: null, summary: 'exactly one background primary (healthy)' };
  }
  if (count === 0) {
    // The consequence is CHECKED, not asserted — see the header note. Routines still
    // firing means redundancy is degraded, not that background work has stopped.
    if (routinesDemonstrablyFiring(evidence)) {
      const age = Math.round(evidence?.lastRoutineFireAgeSec ?? 0);
      return {
        count,
        ok: false,
        severity: 'advisory',
        key: 'no-dedicated-primary',
        summary:
          `no dedicated background primary (bg-host) — but background work is NOT stopped: an active routine fired ${age}s ago, so a routines-enabled non-primary host is serving them. Degraded redundancy (bg-host down or restarting), NOT the routine-engine-death class. Restore the bg-host.`,
      };
    }
    return {
      count,
      ok: false,
      severity: 'blocker',
      key: 'no-primary',
      summary:
        'NO background primary running — DBOS routines, git-sync, and the Mug wake-loop are all down (the silent routine-engine-death class). Start the bg-host / restore a background worker.',
    };
  }
  return {
    count,
    ok: false,
    severity: 'blocker',
    key: 'split-brain-primary',
    summary:
      `${count} background primaries on one DB — split-brain DBOS (appVersion war / 102GB-outbox / plans-rewritten-100k× class). Stop all but one immediately.`,
  };
}

type SqlLike = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** Count DISTINCT live DBOS executors via their pg_stat_activity application_name. */
export async function countBackgroundPrimaries(sql: SqlLike): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(DISTINCT application_name)::int AS n
      FROM pg_stat_activity
     WHERE application_name LIKE 'dbos_transact_%'`;
  return rows[0]?.n ?? 0;
}

/**
 * Age in seconds of the most recent ACTIVE routine fire — the independent liveness signal
 * for "is background work actually happening", used to check a count-0 verdict instead of
 * asserting its consequence. Returns null when nothing has ever fired (a fresh install),
 * which reads as "unknown" and preserves the count-only blocker.
 */
export async function lastRoutineFireAgeSec(sql: SqlLike): Promise<number | null> {
  const rows = await sql<Array<{ age_sec: number | null }>>`
    SELECT EXTRACT(EPOCH FROM (now() - max(last_fired_at)))::float8 AS age_sec
      FROM harness_shared.routines
     WHERE active = true AND last_fired_at IS NOT NULL`;
  const age = rows[0]?.age_sec;
  return typeof age === 'number' && Number.isFinite(age) ? age : null;
}

// ── check + hysteresis + debounce + self-clear + starter ─────────────────────────

const lastAlertedAt = new Map<string, number>();
// Consecutive non-1 streak per verdict key — the hysteresis input.
const consecutiveNon1 = new Map<string, number>();
// key → msg_id of the last fired-but-unresolved escalation, so a recovery
// (count back to 1) can SELF-CLEAR it rather than leave a stale blocker. This is
// per-process state (like the debounce): it self-clears the dominant case — a
// bg-host bounce while THIS :3070 worker stays up. If the worker itself restarts
// mid-alarm the msg_id is lost (the open row is then drained by the 14-day
// escalation GC / attention-reconcile sweep, not here).
const openAlarms = new Map<string, string>();

export interface PrimaryGuardDeps {
  count?: () => Promise<number>;
  /** Age in seconds of the most recent active-routine fire (null = unknown). The evidence
   *  that turns a count-0 blocker into an advisory when background work is demonstrably
   *  still running — see the header note. */
  routineFireAgeSec?: () => Promise<number | null>;
  escalate?: (input: { severity: EscalationSeverity; summary: string; body?: string }) => Promise<unknown>;
  /** Resolve a previously-opened escalation by msg_id (self-clear on recovery). */
  resolve?: (input: { msg_id: string; choice: string; note?: string }) => Promise<unknown>;
  now?: () => number;
  debounceMs?: number;
  /** Consecutive non-1 checks required before escalating (default 2). */
  sustainTicks?: number;
  /** WI-4023: active paging for a sustained non-1 verdict (default: real notifyAttention +
   *  broadcastSevereEvent). Inject a no-op in tests — the default hits the REAL owner push
   *  + fleet broadcast, which a test exercising this path must never do. */
  page?: (verdict: PrimaryVerdict, streak: number, count: number, ws: string) => Promise<void>;
  /** WI-4023: the fleet all-clear when the guard self-clears (default: real
   *  broadcastSevereEventResolvedMany). Inject a no-op in tests for the same reason. */
  pageResolved?: (keys: string[]) => Promise<void>;
}

async function defaultPage(verdict: PrimaryVerdict, streak: number, count: number, ws: string): Promise<void> {
  try {
    await notifyAttention({
      kind: 'intervention',
      title: 'Single-primary guard BLOCKER',
      body: verdict.summary,
      importance: 'urgent',
      workspaceId: ws,
      data: { key: verdict.key ?? '', count },
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  try {
    await broadcastSevereEvent({
      summary: `[single-primary] ${verdict.summary}`,
      body: `Detected by the request-path single-primary guard (R4-2), SUSTAINED over ${streak} consecutive checks. Live DBOS background primaries: ${count} (expected exactly 1). Workspace: ${ws}. See harness_escalations for the durable record.`,
      category: 'severe-event',
      conditionKey: `single-primary:${verdict.key}`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

async function defaultPageResolved(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await broadcastSevereEventResolvedMany({
      conditionKeys: keys.map((k) => `single-primary:${k}`),
      summary: `single-primary RECOVERED (${keys.join(', ')}) — exactly one background primary again.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

/**
 * One guard tick: count primaries; escalate on a SUSTAINED non-1 verdict (debounced),
 * and SELF-CLEAR an open escalation when the count recovers to 1.
 */
export async function runSinglePrimaryCheck(
  workspaceId?: string,
  deps: PrimaryGuardDeps = {},
): Promise<{ fired: boolean; verdict: PrimaryVerdict; selfCleared: boolean }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const sustainTicks = Math.max(1, deps.sustainTicks ?? DEFAULT_SUSTAIN_TICKS);
  const escalate = deps.escalate ?? ((input) => openEscalation(SINGLE_PRIMARY_IDENTITY, input));
  const resolve =
    deps.resolve ??
    ((input) => resolveEscalation({ ...input, resolver: SINGLE_PRIMARY_IDENTITY.ownerId }));
  // WI-4023: paging defaults to a NO-OP here — see the liveness-alarm.ts sibling fix's
  // comment for why (a bare tick call, i.e. every unit test, must never page for real;
  // the live scheduled loop below wires the real default explicitly).
  const page = deps.page ?? (async () => {});
  const pageResolved = deps.pageResolved ?? (async () => {});
  const count = deps.count ? await deps.count() : await countBackgroundPrimaries(getOrgPg().sql as SqlLike);
  // Gather the activity evidence ONLY when the count is non-1 — the healthy path stays a
  // single query. A failure here degrades to `null` (unknown), which preserves the
  // historical count-only verdict rather than silently softening a real outage.
  let evidence: BackgroundActivityEvidence | undefined;
  if (count !== 1) {
    try {
      const age = deps.routineFireAgeSec
        ? await deps.routineFireAgeSec()
        : await lastRoutineFireAgeSec(getOrgPg().sql as SqlLike);
      evidence = { lastRoutineFireAgeSec: age };
    } catch {
      evidence = { lastRoutineFireAgeSec: null };
    }
  }
  const verdict = evaluatePrimaryCount(count, evidence);

  // ── Healthy (exactly one primary): reset hysteresis + self-clear open alarms ──
  if (verdict.ok || !verdict.key) {
    consecutiveNon1.clear();
    let selfCleared = false;
    if (openAlarms.size > 0) {
      const clearedKeys: string[] = [];
      for (const [key, msgId] of [...openAlarms]) {
        try {
          await resolve({
            msg_id: msgId,
            choice: 'auto-resolved-recovered',
            note: `single-primary count returned to 1 (healthy) — the ${key} alarm self-cleared against live state.`,
          });
          selfCleared = true;
          clearedKeys.push(key);
        } catch {
          /* best-effort: never crash the request worker */
        }
      }
      openAlarms.clear();
      // WI-4023: pair the self-clear above with a fleet-facing all-clear — see the
      // paging note below for why an escalation row alone isn't enough.
      await pageResolved(clearedKeys);
    }
    return { fired: false, verdict, selfCleared };
  }

  // ── Non-1 verdict: count a streak; a class change (no-primary↔split-brain) resets ──
  for (const k of [...consecutiveNon1.keys()]) if (k !== verdict.key) consecutiveNon1.delete(k);
  const streak = (consecutiveNon1.get(verdict.key) ?? 0) + 1;
  consecutiveNon1.set(verdict.key, streak);
  // Hysteresis: require the condition to PERSIST before alarming. A single transient
  // sample (idle/reconnect/bg-host bounce) never reaches the owner.
  if (streak < sustainTicks) return { fired: false, verdict, selfCleared: false };

  // Debounce repeated escalations of the same sustained condition.
  const prev = lastAlertedAt.get(verdict.key);
  if (prev !== undefined && now - prev < debounceMs) return { fired: false, verdict, selfCleared: false };
  lastAlertedAt.set(verdict.key, now);
  try {
    const rec = await escalate({
      severity: verdict.severity ?? 'blocker',
      summary: `[single-primary] ${verdict.summary}`,
      body: `Detected by the request-path single-primary guard (R4-2), SUSTAINED over ${streak} consecutive checks. Live DBOS background primaries: ${count} (expected exactly 1). Workspace: ${ws}.`,
    });
    // Remember the open escalation's msg_id so a later recovery can self-clear it.
    const msgId = (rec as { msg_id?: string } | undefined)?.msg_id;
    if (typeof msgId === 'string') openAlarms.set(verdict.key, msgId);
  } catch {
    /* best-effort: never crash the request worker */
  }
  // WI-4023 (root-cause fix, 2026-07-11): verified live that this guard already
  // detects a no-primary outage almost immediately (fired at 20:39:15, ~1min after
  // the 20:38 incident) — but until now that only reached `openEscalation`, a
  // durable PG row with no active push. Nobody noticed for ~40min because nothing
  // paged. Mirror git-sync-stall-watchdog.ts's active paging so a sustained
  // no-primary/split-brain verdict reaches the owner + fleet immediately, not just
  // the escalation log.
  // Page ONLY for a blocker. An advisory (`no-dedicated-primary`) is recorded durably as
  // an escalation row but must never urgent-page the owner or fire an "everything is
  // down" fleet broadcast — that false urgency is the whole defect this split fixes.
  if (verdict.severity === 'blocker') await page(verdict, streak, count, ws);
  return { fired: true, verdict, selfCleared: false };
}

/** Start the guard on a request-worker loop. Env-killable; timer is `unref`'d. */
export function startSinglePrimaryGuard(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'single-primary-check',
    intervalMs,
    () => {
      // managedSetInterval's callback is `() => void | Promise<void>` — runSinglePrimaryCheck()
      // resolves a richer { fired, verdict, selfCleared } shape, so discard it via a block body
      // (no return) rather than an expression-bodied arrow, which would leak the resolved type.
      void runSinglePrimaryCheck(undefined, { page: defaultPage, pageResolved: defaultPageResolved }).catch(() => {});
    },
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-key debounce, streak, and open-alarm state. */
export function _resetSinglePrimaryDebounce(): void {
  lastAlertedAt.clear();
  consecutiveNon1.clear();
  openAlarms.clear();
}
