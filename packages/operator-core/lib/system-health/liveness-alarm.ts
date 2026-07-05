/**
 * liveness-alarm — the REQUEST-PATH supervision alarm
 * (infra-self-healing-supervision-2026-06-19, R4-3 + R4-8).
 *
 * `computeSystemHealth` (compute.ts) already aggregates 15 panels — dead routines,
 * queen/overwatch liveness, git-sync staleness, PG, the LLM account pool — and
 * `runSystemHealthTick` keeps a per-workspace cache warm. EI-1622 moved that
 * tick out of DBOS and into the in-process periodic scheduler, so it no longer
 * writes workflow_status rows; this request-path alarm remains as the independent
 * watcher for bg-host down / BACKGROUND_WORKERS=0 regressions and stale snapshots.
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
 *
 * EI-2146 — dedup + auto-resolve (detector-failure fix). The per-signal
 * `lastAlertedAt` debounce is in-memory, so it is per-WORKER and per-PROCESS: in
 * cluster mode (N request workers) and across restarts it does NOT dedup, so one
 * ~4h incident left dozens of identical never-closing `blocker` escalations that
 * drowned real signal and grew coord_event_log unbounded. The durable fix keys
 * off the escalation LOG itself (a stable per-signal signature):
 *   1. DEDUP — never open a second escalation while one with the same signature
 *      is still open (collapse repeats into one row; re-fire only after recovery).
 *   2. AUTO-RESOLVE-ON-RECOVERY — each tick, resolve every open infra-liveness
 *      escalation whose condition is no longer firing. On the first post-deploy
 *      tick this is the one-time backlog sweep of the recovered cohort.
 *   3. FALSE-POSITIVE SUPPRESSION — "no bees running" is NOT a fault when the
 *      placement frontier is genuinely empty (an idle fleet is correct).
 */
import { PANEL_LABELS, type SystemHealth, type PanelKey } from './types';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { computeSystemHealth, lastSystemHealth } from './compute';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationSeverity,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
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
/** 6h since the last wake before an enabled-but-STOPPED overwatch fires
 *  `rubric-emission-dark` — generous vs any deliberate short pause. */
const RUBRIC_EMISSION_DARK_GRACE_MS = 6 * 60 * 60_000;

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
  // EI-1695: a stale snapshot means the bg routine engine is frozen — the SAME
  // condition that blinds the in-engine account-state read into a false
  // all-paused 'accounts-starved'. Compute it once so that derived signal can be
  // folded into the one root-cause (health-tick-stale) blocker below instead of
  // firing N separate rate-starvation blockers for one incident.
  const tickStale = snapshotAgeMs !== null && snapshotAgeMs > staleMs;
  const signals: AlarmSignal[] = [];

  // 1. The bg health-tick itself stalled → the routine engine (and the watchdog
  //    that lives in it) is likely frozen. The request-path catch for the
  //    BACKGROUND_WORKERS=0 / bg-host-down class.
  if (tickStale) {
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

  // 4b. Overwatch ALIVE but SKIPPING its mandated scorecard (monitor-the-monitor,
  //     hive-loop-supervision 2026-06-21). overwatch-dark catches a NON-waking
  //     supervisor; this catches the OTHER failure — it wakes (autoloop 'ok') yet
  //     silently omits the Owner-#1 every-wake hive-coordination-health scorecard, so
  //     the health-trend goes blind while everything LOOKS alive. The settled-wake grace
  //     lives in compute.ts (the `scorecardSkipped` flag) so this stays pure.
  const ow = health.panels.overwatch?.data;
  if (ow?.started && ow.scorecardSkipped) {
    const e = ow.scorecardEmission;
    signals.push({
      key: 'overwatch-scorecard-skipped',
      severity: 'advisory',
      summary:
        e?.status === 'partial-only'
          ? `Overwatch emitting only PARTIAL hive-coordination-health scorecards since its last wake (${e.missingCount} criteria unrated) — Owner #1 mandate (a COMPLETE scorecard EVERY wake) truncated.`
          : `Overwatch woke but emitted NO complete hive-coordination-health scorecard since its last wake — Owner #1 mandate (a scorecard EVERY wake) skipped; the health-trend is going blind.`,
    });
  }

  // 4c. Rubric emission dark — flag ON but the supervisor is STOPPED, long past a
  //     wake. 4/4b both gate on `started`, and the freshness interpreter reads
  //     'not-started' as benign — so a monitor stopped mid-flight went silent
  //     FOREVER (WI-2374: emission died with overwatch on 2026-07-02 and nothing
  //     noticed). Fires only when it HAS woken before (lastWakeAt != null — a
  //     never-started fresh install stays quiet) and after a 6h grace. Auto-resolves
  //     when overwatch restarts OR the flag is turned off (making the pause explicit).
  if (ow?.flagEnabled && !ow.started && ow.lastWakeAt != null) {
    const darkMs = health.evaluatedAt - ow.lastWakeAt;
    if (darkMs > RUBRIC_EMISSION_DARK_GRACE_MS) {
      signals.push({
        key: 'rubric-emission-dark',
        severity: 'advisory',
        summary:
          `hive-coordination-health AGENT emission dark ${Math.round(darkMs / 3_600_000)}h — overwatch is enabled but STOPPED ` +
          `(last wake ${new Date(ow.lastWakeAt).toISOString()}). The scheduled pulse keeps a deterministic floor, but the ` +
          `agent trend is blind. kettle:start to resume, or turn the papercusp-overwatch flag OFF to make the pause explicit.`,
      });
    }
  }

  // 5. LLM substrate starved — every pool account paused. ONLY trusted when the
  //    snapshot is FRESH: when the bg routine engine is frozen (tickStale →
  //    health-tick-stale already fires) the in-engine account-state read is
  //    blinded into a false all-paused reading (EI-1695: accounts:status showed
  //    7/8 available during the freeze). Suppressing it here folds the false
  //    rate-starvation blocker into the one health-tick-stale root cause.
  const tk = health.panels.tokens?.data;
  if (!tickStale && tk && tk.accountsTotal > 0 && tk.accountsAvailable === 0) {
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
    if (panel.status !== 'crit' || coveredKeys.has(panel.key)) continue;
    // EI-2146 #3: suppress the no-bees-while-idle FALSE POSITIVE. A fleet with
    // zero bees running is CORRECT when there is no placeable work — the
    // placement frontier is empty — so it is an idle fleet, not an infra fault.
    // Only the specific no-bees case is gated; a bees-crit for any OTHER reason
    // (e.g. a cursed placement, or real frontier work waiting) still surfaces.
    if (panel.key === 'bees') {
      const running = health.panels.bees?.data?.running;
      const frontier = health.panels.workFeed?.data?.frontier;
      if (running === 0 && frontier === 0) continue;
    }
    signals.push({ key: `panel:${panel.key}`, severity: 'blocker', summary: `${panel.label}: ${panel.summary}` });
  }

  return signals;
}

// ── durable per-signal signature (dedup + auto-resolve key) ────────────────────

/** The summary prefix every fired escalation carries. */
const SUMMARY_PREFIX = '[infra-liveness] ';

/** Reverse map a panel LABEL back to its key, for classifying legacy records. */
const PANEL_LABEL_TO_KEY: Record<string, PanelKey> = Object.fromEntries(
  (Object.entries(PANEL_LABELS) as Array<[PanelKey, string]>).map(([k, v]) => [v, k]),
);

/**
 * Derive a signal's stable signature from an escalation summary — the fallback
 * for LEGACY records written before EI-2146 (which carry no explicit signature),
 * so the one-time backlog sweep can classify and auto-resolve the existing pile.
 * Mirrors the summaries produced by `evaluateLivenessAlarm`. Returns null when
 * the summary is not a recognizable infra-liveness signal (left untouched).
 */
export function deriveSignatureFromSummary(summary: string): string | null {
  let s = summary ?? '';
  if (s.startsWith(SUMMARY_PREFIX)) s = s.slice(SUMMARY_PREFIX.length);
  s = s.trim();
  if (s.startsWith('system-health tick stale')) return 'health-tick-stale';
  if (/dead routine\(s\)/.test(s)) return 'dead-routines';
  if (s.startsWith('Queen loop dark')) return 'queen-dark';
  if (s.startsWith('Overwatch supervisor loop dark')) return 'overwatch-dark';
  if (/LLM pool account\(s\) paused/.test(s)) return 'accounts-starved';
  // Catch-all panel form: "<panel label>: <panel summary>".
  const idx = s.indexOf(': ');
  if (idx > 0) {
    const key = PANEL_LABEL_TO_KEY[s.slice(0, idx)];
    if (key) return `panel:${key}`;
  }
  return null;
}

/**
 * The stable signature of an open escalation: the explicit `livenessSignature`
 * stamped on records this alarm writes (EI-2146), else derived from the summary
 * (legacy). Null = not classifiable as an infra-liveness signal.
 */
export function livenessSignatureOf(rec: EscalationRecord): string | null {
  const explicit = (rec as Record<string, unknown>).livenessSignature;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return deriveSignatureFromSummary(rec.summary ?? '');
}

// ── tick + debounce + starter ─────────────────────────────────────────────────

const lastAlertedAt = new Map<string, number>();

export interface AlarmDeps {
  computeHealth?: (ws: string) => Promise<SystemHealth>;
  readLast?: (ws: string) => SystemHealth | null;
  escalate?: (input: {
    severity: EscalationSeverity;
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** The currently-OPEN infra-liveness escalations — the durable dedup +
   *  auto-resolve source. Default reads a bounded newest-first window of the
   *  escalation log and filters to this alarm's identity. */
  listOpen?: () => Promise<EscalationRecord[]>;
  /** Resolve one open escalation by msg_id (auto-resolve-on-recovery). */
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  snapshotStaleMs?: number;
  debounceMs?: number;
}

/** Bound the per-tick escalation-log read: large enough to cover the recently-
 *  open infra-liveness set (and the recovered cohort on the first sweep), small
 *  enough not to re-load the whole ~13k backlog every ~2min (cf. EI-1490). */
const OPEN_SCAN_WINDOW = 500;

/**
 * One alarm tick: prefer the warm cache (cheap when the bg tick is alive), else
 * compute fresh (and the staleness is itself a signal). Then, against the OPEN
 * infra-liveness escalations (EI-2146):
 *   - auto-resolve every open escalation whose condition no longer fires (the
 *     one-time backlog sweep on the first post-deploy tick), and
 *   - fire each NEW signal, durably deduped (one open row per signature, across
 *     workers + restarts) and in-memory cooldown-debounced.
 * Best-effort: never throws.
 */
export async function runLivenessAlarmTick(
  workspaceId?: string,
  deps: AlarmDeps = {},
): Promise<{ fired: AlarmSignal[]; signals: AlarmSignal[]; resolved: string[] }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const readLast = deps.readLast ?? lastSystemHealth;
  const compute = deps.computeHealth ?? computeSystemHealth;
  const escalate = deps.escalate ?? ((input) => openEscalation(INFRA_LIVENESS_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({ status: 'open', maxRecords: OPEN_SCAN_WINDOW });
      return escalations.filter((e) => e.from === INFRA_LIVENESS_IDENTITY.ownerId);
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: INFRA_LIVENESS_IDENTITY.ownerId }));
  const staleMs = deps.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const cached = readLast(ws);
  const snapshotAgeMs = cached ? now - cached.evaluatedAt : null;
  const stale = snapshotAgeMs === null || snapshotAgeMs > staleMs;
  const health = stale ? await compute(ws) : (cached as SystemHealth);

  const signals = evaluateLivenessAlarm(health, snapshotAgeMs, { snapshotStaleMs: staleMs });
  const currentSigs = new Set(signals.map((s) => s.key));

  // Read the open infra-liveness escalations ONCE, bucketed by signature. The
  // durable, cross-worker/cross-restart dedup the in-memory debounce cannot give.
  // Fail-soft: a log-read error degrades to the in-memory debounce only — it must
  // never crash the request worker nor block a genuine alarm.
  let openBySig = new Map<string, EscalationRecord[]>();
  try {
    for (const rec of await listOpen()) {
      const sig = livenessSignatureOf(rec);
      if (!sig) continue;
      const list = openBySig.get(sig);
      if (list) list.push(rec);
      else openBySig.set(sig, [rec]);
    }
  } catch {
    openBySig = new Map();
  }

  // 1. Auto-resolve-on-recovery: every open infra-liveness escalation whose
  //    signal is no longer firing. On the first post-deploy tick this drains the
  //    recovered backlog (gateway/accounts/no-bees-while-idle) so the pile clears.
  const resolved: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue; // still firing — keep the single open row
    for (const rec of recs) {
      try {
        await resolve(rec.msg_id, 'auto-resolved', `infra-liveness signal '${sig}' cleared (condition recovered)`);
        resolved.push(rec.msg_id);
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    // Drop the in-memory cooldown so a genuine re-occurrence after recovery
    // re-fires immediately ("re-fire only after auto-resolve").
    lastAlertedAt.delete(sig);
  }

  // 2. Fire each NEW signal — durably deduped (skip a signature that already has
  //    an open escalation) then in-memory cooldown-debounced.
  const fired: AlarmSignal[] = [];
  for (const s of signals) {
    if (openBySig.has(s.key)) continue; // an open escalation already covers this signature
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate({
        severity: s.severity,
        summary: `${SUMMARY_PREFIX}${s.summary}`,
        body:
          `Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, ` +
          `independent of the background routine engine, so it fires even when that engine is frozen ` +
          `(the failure that blinds the in-engine watchdog). Signal: ${s.key}. Workspace: ${ws}.`,
        // EI-2146: stamp the signature so dedup + auto-resolve match exactly
        // (no summary-parsing needed for records this alarm writes).
        meta: { livenessSignature: s.key },
      });
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
  }
  return { fired, signals, resolved };
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
  // .then(() => undefined) narrows to Promise<void> for the registry WITHOUT hiding the
  // promise — a tick that looked synchronous would release the re-entrancy guard early.
  const timer = managedSetInterval(
    'liveness-alarm',
    intervalMs,
    () => runLivenessAlarmTick().then(() => undefined, () => undefined),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signal debounce. */
export function _resetLivenessAlarmDebounce(): void {
  lastAlertedAt.clear();
}
