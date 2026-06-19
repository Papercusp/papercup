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
 * D-001 calls for ("the watcher must not live in what it watches"). Read-only +
 * debounced; env-killable (PAPERCUSP_SINGLE_PRIMARY_GUARD=0).
 */
import { getOrgPg } from '@papercusp/db-org';
import { openEscalation, type EscalationSeverity } from '../agent-tools/coordination/escalations';
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

// ── check + debounce + starter ─────────────────────────────────────────────────

const lastAlertedAt = new Map<string, number>();

export interface PrimaryGuardDeps {
  count?: () => Promise<number>;
  escalate?: (input: { severity: EscalationSeverity; summary: string; body?: string }) => Promise<unknown>;
  now?: () => number;
  debounceMs?: number;
}

/** One guard tick: count primaries, and on a non-1 verdict escalate (debounced). */
export async function runSinglePrimaryCheck(
  workspaceId?: string,
  deps: PrimaryGuardDeps = {},
): Promise<{ fired: boolean; verdict: PrimaryVerdict }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const escalate = deps.escalate ?? ((input) => openEscalation(SINGLE_PRIMARY_IDENTITY, input));
  const count = deps.count ? await deps.count() : await countBackgroundPrimaries(getOrgPg().sql as SqlLike);
  const verdict = evaluatePrimaryCount(count);
  if (verdict.ok || !verdict.key) return { fired: false, verdict };

  const prev = lastAlertedAt.get(verdict.key);
  if (prev !== undefined && now - prev < debounceMs) return { fired: false, verdict };
  lastAlertedAt.set(verdict.key, now);
  try {
    await escalate({
      severity: verdict.severity ?? 'blocker',
      summary: `[single-primary] ${verdict.summary}`,
      body: `Detected by the request-path single-primary guard (R4-2). Live DBOS background primaries: ${count} (expected exactly 1). Workspace: ${ws}.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  return { fired: true, verdict };
}

/** Start the guard on a request-worker loop. Env-killable; timer is `unref`'d. */
export function startSinglePrimaryGuard(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = setInterval(() => {
    void runSinglePrimaryCheck().catch(() => {});
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Test-only — clear the per-key debounce. */
export function _resetSinglePrimaryDebounce(): void {
  lastAlertedAt.clear();
}
