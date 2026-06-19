/**
 * liveness-alarm — the REQUEST-PATH supervision alarm
 * (infra-self-healing-supervision-2026-06-19, R4-3 + R4-8).
 *
 * `computeSystemHealth` (compute.ts) already aggregates 15 panels — dead routines,
 * queen/overwatch liveness, git-sync staleness, PG, the LLM account pool — and
 * `runSystemHealthTick` keeps a per-workspace cache warm. BUT that tick is a DBOS
 * periodic workflow on the BACKGROUND PRIMARY — exactly what dies in the freeze
 * class we guard against (bg-host down / BACKGROUND_WORKERS=0 regression): the
 * watcher dies with the watched, and the rollup only feeds the Health TAB
 * (passive — a human must be looking). Every freeze on 2026-06-19 was found by
 * hand, never surfaced.
 *
 * This alarm runs on a :3070 REQUEST worker loop (in cluster mode the workers are
 * request-only, structurally separate from the bg primary; single-process degrades
 * cleanly), and on a degraded TRANSITION fires an out-of-band owner escalation.
 * Two independent liveness sources:
 *   1. the rollup's own CRITICAL panels (dead routines, queen dark, accounts
 *      starved, any panel self-reporting `crit`); and
 *   2. a STALE health snapshot — if `runSystemHealthTick` has not refreshed
 *      `lastSystemHealth` within the freshness window, the bg tick itself has
 *      stalled, i.e. the routine engine is frozen. This is the signal that needs
 *      NO live engine to detect a dead engine.
 *
 * Transition-only + per-signal debounced so it never spams; env-killable
 * (PAPERCUSP_INFRA_LIVENESS_ALARM=0). The watcher does not live in what it watches.
 */
import type { SystemHealth } from './types';
import { computeSystemHealth, lastSystemHealth } from './compute';
import { openEscalation, type EscalationSeverity } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';

export const INFRA_LIVENESS_IDENTITY: AgentIdentity = {
  ownerId: 'system:infra-liveness-alarm',
  ownerLabel: 'system · infra-liveness-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** A live supervision problem worth an out-of-band owner alert. */
export interface AlarmSignal {
  key: string;
  severity: EscalationSeverity;
  summary: string;
}

const DEFAULT_SNAPSHOT_STALE_MS = 6 * 60_000;
const DEFAULT_DEBOUNCE_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;

/**
 * PURE: derive the critical supervision signals from a SystemHealth snapshot.
 * `snapshotAgeMs` is the age of `lastSystemHealth` at evaluation (null = the
 * snapshot was computed fresh this tick, so staleness is not a signal).
 */
export function evaluateLivenessAlarm(
  health: SystemHealth,
  snapshotAgeMs: number | null,
  opts: { snapshotStaleMs?: number } = {},
): AlarmSignal[] {
  const staleMs = opts.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const signals: AlarmSignal[] = [];

  // 1. The bg health-tick itself stalled → the routine engine (and the watchdog
  //    that lives in it) is likely frozen. The request-path catch for the
  //    BACKGROUND_WORKERS=0 / bg-host-down class.
  if (snapshotAgeMs !== null && snapshotAgeMs > staleMs) {
    signals.push({
      key: 'health-tick-stale',
      severity: 'blocker',
      summary: `system-health tick stale for ${Math.round(snapshotAgeMs / 60_000)}m — the background routine engine (DBOS) is likely frozen; routines / git-sync / Queen will be stalled and the in-engine watchdog is blind.`,
    });
  }

  // 2. Dead routines — active cron routines long overdue (the routine engine is
  //    starved/frozen). Sharper than the stale-snapshot signal when the tick lives.
  const wf = health.panels.workFeed?.data;
  if (wf && wf.deadRoutines > 0) {
    const names = wf.deadRoutineNames?.length ? `: ${wf.deadRoutineNames.slice(0, 4).join(', ')}` : '';
    signals.push({
      key: 'dead-routines',
      severity: 'blocker',
      summary: `${wf.deadRoutines} dead routine(s) overdue >10m${names} — the routine engine is starved.`,
    });
  }

  // 3. Queen loop dark — LIVENESS (started but no live wake), distinct from a
  //    chosen pause.
  if (health.crossMonitor?.queenAlive === false && health.panels.queen?.data?.started) {
    signals.push({
      key: 'queen-dark',
      severity: 'blocker',
      summary: `Queen loop dark (started, no live wake) — ${health.panels.queen?.summary ?? ''}`.trim(),
    });
  }

  // 4. Overwatch dark — only when it is supposed to be running.
  if (health.crossMonitor?.overwatchAlive === false && health.panels.overwatch?.data?.started) {
    signals.push({
      key: 'overwatch-dark',
      severity: 'advisory',
      summary: `Overwatch supervisor loop dark — ${health.panels.overwatch?.summary ?? ''}`.trim(),
    });
  }

  // 5. LLM substrate starved — every pool account paused.
  const tk = health.panels.tokens?.data;
  if (tk && tk.accountsTotal > 0 && tk.accountsAvailable === 0) {
    signals.push({
      key: 'accounts-starved',
      severity: 'blocker',
      summary: `all ${tk.accountsTotal} LLM pool account(s) paused — the fleet is rate-starved.`,
    });
  }

  // 6. Catch-all: any OTHER panel self-reporting `crit` (so a new critical signal
  //    is never silently missed). Sharper-keyed panels above are skipped.
  const coveredKeys = new Set(['workFeed', 'queen', 'tokens']);
  for (const panel of Object.values(health.panels)) {
    if (panel.status === 'crit' && !coveredKeys.has(panel.key)) {
      signals.push({ key: `panel:${panel.key}`, severity: 'blocker', summary: `${panel.label}: ${panel.summary}` });
    }
  }

  return signals;
}

// ── tick + debounce + starter ─────────────────────────────────────────────────

const lastAlertedAt = new Map<string, number>();

export interface AlarmDeps {
  computeHealth?: (ws: string) => Promise<SystemHealth>;
  readLast?: (ws: string) => SystemHealth | null;
  escalate?: (input: { severity: EscalationSeverity; summary: string; body?: string }) => Promise<unknown>;
  now?: () => number;
  snapshotStaleMs?: number;
  debounceMs?: number;
}

/**
 * One alarm tick: prefer the warm cache (cheap when the bg tick is alive), else
 * compute fresh (and the staleness is itself a signal). Evaluate, then escalate
 * each NEW critical signal — debounced per signal key so a sustained problem
 * wakes the owner once per window, not every tick. Best-effort: never throws.
 */
export async function runLivenessAlarmTick(
  workspaceId?: string,
  deps: AlarmDeps = {},
): Promise<{ fired: AlarmSignal[]; signals: AlarmSignal[] }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const readLast = deps.readLast ?? lastSystemHealth;
  const compute = deps.computeHealth ?? computeSystemHealth;
  const escalate = deps.escalate ?? ((input) => openEscalation(INFRA_LIVENESS_IDENTITY, input));
  const staleMs = deps.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const cached = readLast(ws);
  const snapshotAgeMs = cached ? now - cached.evaluatedAt : null;
  const stale = snapshotAgeMs === null || snapshotAgeMs > staleMs;
  const health = stale ? await compute(ws) : (cached as SystemHealth);

  const signals = evaluateLivenessAlarm(health, snapshotAgeMs, { snapshotStaleMs: staleMs });
  const fired: AlarmSignal[] = [];
  for (const s of signals) {
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate({
        severity: s.severity,
        summary: `[infra-liveness] ${s.summary}`,
        body:
          `Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, ` +
          `independent of the background routine engine, so it fires even when that engine is frozen ` +
          `(the failure that blinds the in-engine watchdog). Signal: ${s.key}. Workspace: ${ws}.`,
      });
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
  }
  return { fired, signals };
}

/**
 * Start the alarm on a request-worker loop. The timer is `unref`'d so it never
 * keeps the process alive. Env-killable (PAPERCUSP_INFRA_LIVENESS_ALARM=0);
 * interval overridable (PAPERCUSP_INFRA_LIVENESS_ALARM_MS).
 */
export function startInfraLivenessAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_INFRA_LIVENESS_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_INFRA_LIVENESS_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = setInterval(() => {
    void runLivenessAlarmTick().catch(() => {});
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Test-only — clear the per-signal debounce. */
export function _resetLivenessAlarmDebounce(): void {
  lastAlertedAt.clear();
}
