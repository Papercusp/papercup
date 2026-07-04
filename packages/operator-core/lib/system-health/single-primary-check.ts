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

export interface PrimaryVerdict {
  count: number;
  ok: boolean;
  severity: EscalationSeverity | null;
  key: string | null;
  summary: string;
}

/** PURE: classify the live background-primary count. */
export function evaluatePrimaryCount(count: number): PrimaryVerdict {
  if (count === 1) {
    return { count, ok: true, severity: null, key: null, summary: 'exactly one background primary (healthy)' };
  }
  if (count === 0) {
    return {
      count,
      ok: false,
      severity: 'blocker',
      key: 'no-primary',
      summary:
        'NO background primary running — DBOS routines, git-sync, and the Queen wake-loop are all down (the silent routine-engine-death class). Start the bg-host / restore a background worker.',
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
  escalate?: (input: { severity: EscalationSeverity; summary: string; body?: string }) => Promise<unknown>;
  /** Resolve a previously-opened escalation by msg_id (self-clear on recovery). */
  resolve?: (input: { msg_id: string; choice: string; note?: string }) => Promise<unknown>;
  now?: () => number;
  debounceMs?: number;
  /** Consecutive non-1 checks required before escalating (default 2). */
  sustainTicks?: number;
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
  const count = deps.count ? await deps.count() : await countBackgroundPrimaries(getOrgPg().sql as SqlLike);
  const verdict = evaluatePrimaryCount(count);

  // ── Healthy (exactly one primary): reset hysteresis + self-clear open alarms ──
  if (verdict.ok || !verdict.key) {
    consecutiveNon1.clear();
    let selfCleared = false;
    if (openAlarms.size > 0) {
      for (const [key, msgId] of [...openAlarms]) {
        try {
          await resolve({
            msg_id: msgId,
            choice: 'auto-resolved-recovered',
            note: `single-primary count returned to 1 (healthy) — the ${key} alarm self-cleared against live state.`,
          });
          selfCleared = true;
        } catch {
          /* best-effort: never crash the request worker */
        }
      }
      openAlarms.clear();
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
      void runSinglePrimaryCheck().catch(() => {});
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
