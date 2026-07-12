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
import { notifyAttention } from '../attention-notify';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';

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
 * EI-9794 — Kettle silently stopped firing for ~11h while `last_status` stayed
 * 'ok' and `consecutive_errors` stayed 0 (both are only WRITTEN on a fire, so a
 * loop that stops firing entirely freezes them at their last-good values
 * forever — green status is not proof of life). The existing signals #4/#4b/#4c
 * above all gate on `overwatchAlive` / `panels.overwatch.data.started`, which
 * derive from the `overwatch-wake` ROUTINE row's `armed` bit (cross-monitor.ts
 * `isDark`) — but that routine is a self-deactivating ONE-SHOT whose NORMAL
 * resting state between fires is `active=false, next_fire_at=NULL`, identical
 * to a fire that failed to re-arm. `harness_shared.autoloop_state.last_fired_at`
 * (stamped by `recordFire` on every ACTUAL fire, independent of the routine's
 * own re-arm bookkeeping) is the one signal that can't be spoofed by a
 * mid-re-arm crash — this alarm keys on ITS recency instead.
 */
export interface AutoloopFireRow {
  role: string;
  harnessSlug: string;
  /** epoch ms of `autoloop_state.last_fired_at`, or null if it has never fired. */
  lastFiredAtMs: number | null;
  cadenceSec: number;
  /** Is this role SUPPOSED to be actively firing right now (flag on + started)?
   *  false ⇒ vacuously fine, never alarm (mirrors cross-monitor.ts's `isDark`
   *  philosophy — a role that isn't running has nothing to be stale about). */
  expected: boolean;
}

/** How many cadences of silence before a fire-staleness alarm fires (env-tunable,
 *  matches the item's own suggested "N=3" — generous vs one missed/backed-off
 *  tick, sharp enough to catch an hours-long stall fast). */
function autoloopFireStaleMultiplier(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_FIRE_STALE_MULTIPLIER ?? 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/**
 * PURE: derive the critical supervision signals from a SystemHealth snapshot.
 * `snapshotAgeMs` is the age of `lastSystemHealth` at evaluation (null = the
 * snapshot was computed fresh this tick, so staleness is not a signal).
 */
export function evaluateLivenessAlarm(
  health: SystemHealth,
  snapshotAgeMs: number | null,
  opts: {
    snapshotStaleMs?: number;
    prevPostmasterStartMs?: number | null;
    /** EI-9794: fresh `autoloop_state` fire-recency rows (see the type doc above).
     *  Optional — omitted/empty means "not evaluated this tick" (fail-open, never
     *  a false negative from a caller that hasn't wired the fetch). */
    autoloopFireRows?: AutoloopFireRow[];
  } = {},
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
  //     silently omits the Owner-#1 every-wake pot-coordination-health scorecard, so
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
          ? `Overwatch emitting only PARTIAL pot-coordination-health scorecards since its last wake (${e.missingCount} criteria unrated) — Owner #1 mandate (a COMPLETE scorecard EVERY wake) truncated.`
          : `Overwatch woke but emitted NO complete pot-coordination-health scorecard since its last wake — Owner #1 mandate (a scorecard EVERY wake) skipped; the health-trend is going blind.`,
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
          `pot-coordination-health AGENT emission dark ${Math.round(darkMs / 3_600_000)}h — overwatch is enabled but STOPPED ` +
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

  // 5b. PG RESTART (P-008, mcp-reliability-hardening). The postmaster boot time
  //     (infra panel) DRIFTED since the previous tick → Postgres was restarted, so
  //     every backend connection + prepared statement was dropped fleet-wide. This
  //     was a SILENT class: the 2026-07-10 21:04 EDT restart (an agent's
  //     `sudo apt-get install postgresql-server-dev-18 bison flex` triggered the
  //     postgresql-common maintainer scripts to restart the live cluster) went
  //     undetected until downstream errors surfaced. Fires only when a PRIOR
  //     baseline exists (prev != null — the first observation just seeds it, never
  //     alarms) and the current reading is present (cur != null — an unreadable PG
  //     tick is the pg panel's own concern, not a false "restart"). Transient by
  //     design: the tick updates its baseline to the new value, so this fires once
  //     then auto-resolves next tick — a "PG just restarted, connections blipped"
  //     page, not a stuck condition.
  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  const prevPostmasterStartMs = opts.prevPostmasterStartMs ?? null;
  if (
    prevPostmasterStartMs !== null &&
    curPostmasterStartMs !== null &&
    curPostmasterStartMs !== prevPostmasterStartMs
  ) {
    const at = new Date(curPostmasterStartMs).toISOString();
    signals.push({
      key: 'pg-restarted',
      severity: 'blocker',
      summary:
        `Postgres RESTARTED (postmaster start-time drifted to ${at}) — every backend connection + prepared ` +
        `statement was dropped; agents may have hit transient DB errors. If UNPLANNED, root-cause it (a ` +
        `\`sudo apt-get install postgresql-*\` / cluster op restarts the live server — do package work off-hours ` +
        `or against embedded-pg, never the shared :5432).`,
    });
  }

  // 5c. EI-9794: autoloop FIRE-RECENCY staleness — independent of `last_status` /
  //     `consecutive_errors` (frozen the instant a loop stops firing) and of the
  //     `armed` wake-routine bit (a self-deactivating one-shot's normal resting
  //     state is indistinguishable from a failed re-arm — see the type doc
  //     above). A role EXPECTED to be running whose `autoloop_state.last_fired_at`
  //     is stale by more than N cadences is silently dead — page it like any
  //     other dead routine.
  const staleMultiplier = autoloopFireStaleMultiplier();
  for (const row of opts.autoloopFireRows ?? []) {
    if (!row.expected || row.lastFiredAtMs === null) continue;
    const thresholdMs = row.cadenceSec * 1000 * staleMultiplier;
    const staleForMs = health.evaluatedAt - row.lastFiredAtMs;
    if (staleForMs > thresholdMs) {
      signals.push({
        key: `autoloop-fire-stale:${row.role}`,
        severity: 'blocker',
        summary:
          `${row.role}@${row.harnessSlug} has not fired in ${Math.round(staleForMs / 60_000)}m ` +
          `(expected every ${row.cadenceSec}s, alarm threshold ${staleMultiplier}x) — last_status may still ` +
          `read 'ok' since that field only updates on a fire. The supervisor is likely dead; kettle:start to resume.`,
      });
    }
  }

  // 6. Catch-all: any OTHER panel self-reporting `crit` (so a new critical signal
  //    is never silently missed). Sharper-keyed panels above are skipped.
  //    NOTE: the panel KEY for the Queen/Mug card is the STABLE identifier
  //    `'queen'` (types.ts PANEL_LABELS maps queen: 'Mug' — key-stable,
  //    label-renamed seam, cup-lexicon-full-rename-2026-07-09 KEEP-set). A
  //    2026-07-05 edit mis-renamed this entry to the display label `'mug'`,
  //    which never matches `panel.key` — so the queen-dark signal (#3 above)
  //    was silently duplicated by this catch-all whenever the queen panel
  //    went crit. Bug found + fixed 2026-07-10 (cup-lexicon-full-rename
  //    fleet read-only-prep pass, su-78d15).
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

/** Reverse map a panel LABEL back to its key, for classifying legacy records.
 * Includes the PRE-pot-rename display labels (WI-2932): escalation rows written
 * before the rename carry them in their summaries forever, and this map exists
 * precisely to classify those old rows — the aliases stay as long as any do. */
const PANEL_LABEL_TO_KEY: Record<string, PanelKey> = {
  ...Object.fromEntries(
    (Object.entries(PANEL_LABELS) as Array<[PanelKey, string]>).map(([k, v]) => [v, k]),
  ),
  Queen: 'queen',
  'Bees / fleet': 'bees',
  Overwatch: 'overwatch',
  'Scout / ideation': 'scout',
};

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
  if (s.startsWith('Postgres RESTARTED')) return 'pg-restarted';
  // EI-9794 fire-staleness form: "<role>@<harness> has not fired in ...".
  const fireStaleMatch = /^([^@\s]+)@\S+ has not fired in/.exec(s);
  if (fireStaleMatch) return `autoloop-fire-stale:${fireStaleMatch[1]}`;
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

/** P-008: the per-workspace baseline for the PG postmaster boot time (epoch ms).
 *  A change between ticks = a PG restart → the `pg-restarted` signal. In-memory +
 *  per-worker like `lastAlertedAt`; the durable openBySig dedup collapses the
 *  cross-worker fire into one escalation, and a fresh process re-seeds (prev=null)
 *  so a restart never false-fires on the first tick after a :3070 restart. */
const lastPostmasterStartMs = new Map<string, number>();

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
  /** Resolve one open escalation by msg_id (auto-resolve-on-recovery). The
   *  RESOLVED value matters (WI-4181): resolveEscalation's no-op sentinels
   *  ('not_found' | 'already_resolved' | 'requires_spawn_approve') mean nothing
   *  transitioned, so the tick suppresses the recovery broadcast; any other
   *  resolution (including undefined from a test double) counts as a real
   *  open→resolved transition. */
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  snapshotStaleMs?: number;
  debounceMs?: number;
  /** WI-4023: active paging for a NEW `blocker` signal (default: real notifyAttention +
   *  broadcastSevereEvent). Inject a no-op in tests — the default hits the REAL owner
   *  push + fleet broadcast, which a test exercising the blocker path must never do. */
  page?: (s: AlarmSignal, ws: string) => Promise<void>;
  /** WI-4023: the fleet all-clear for recovered `blocker` signatures (default: real
   *  broadcastSevereEventResolvedMany). Inject a no-op in tests for the same reason. */
  pageResolved?: (sigs: string[]) => Promise<void>;
  /** P-008: read/write the per-workspace PG postmaster-start baseline (epoch ms) the
   *  `pg-restarted` drift signal compares against. Default = the module-level map;
   *  tests inject a controlled store to exercise the seed→drift→auto-resolve sequence
   *  hermetically. */
  readPostmasterBaseline?: (ws: string) => number | null;
  writePostmasterBaseline?: (ws: string, ms: number) => void;
  /** EI-9794: fresh `autoloop_state` fire-recency rows for the fire-staleness
   *  signal (5c above). Default = `defaultReadAutoloopFireRows` (kettle/overwatch
   *  today — the proven incident; other supervisor roles with a known cadence +
   *  expected-predicate can extend the same reader). Fail-soft → []: a read
   *  failure must never crash the request worker nor synthesize a false alarm. */
  readAutoloopFireRows?: (ws: string) => Promise<AutoloopFireRow[]>;
}

/**
 * EI-9794 default `readAutoloopFireRows` — kettle/overwatch, the diagnosed
 * incident. Resolves the pot's home harness the same way `kettle:start` /
 * `isOverwatchAlive` do, reads its `autoloop_state` row (role = OVERWATCH_ROLE),
 * and reuses the EXACT `overwatchExpected` + `getOverwatchCadenceSec` predicates
 * the wake-liveness leg already trusts — so this alarm can never disagree with
 * "is kettle expected to be running" from a second, drifted implementation.
 */
async function defaultReadAutoloopFireRows(ws: string): Promise<AutoloopFireRow[]> {
  try {
    const [{ resolvePotHomeSlug }, { getOrgPg }, { overwatchExpected }, { getOverwatchCadenceSec }, { OVERWATCH_ROLE }] =
      await Promise.all([
        import('../pot/wake'),
        import('@papercusp/db-org'),
        import('../overwatch/cross-monitor'),
        import('../overwatch/control-state'),
        import('../overwatch/liveness'),
      ]);
    const installSlug = resolvePotHomeSlug(undefined, undefined);
    if (!installSlug) return [];
    const [expected, cadenceSec] = await Promise.all([
      overwatchExpected(ws, installSlug),
      getOverwatchCadenceSec(ws, installSlug),
    ]);
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ last_fired_at: Date | string | null }>>`
      SELECT last_fired_at FROM harness_shared.autoloop_state
       WHERE workspace_id = ${ws} AND harness_slug = ${installSlug} AND role = ${OVERWATCH_ROLE}
       LIMIT 1
    `;
    const raw = rows[0]?.last_fired_at ?? null;
    const lastFiredAtMs = raw == null ? null : new Date(raw).getTime();
    return [
      {
        role: OVERWATCH_ROLE,
        harnessSlug: installSlug,
        lastFiredAtMs: Number.isFinite(lastFiredAtMs) ? lastFiredAtMs : null,
        cadenceSec,
        expected,
      },
    ];
  } catch {
    return []; // fail-soft: never synthesize a false alarm from a broken read
  }
}

async function defaultPage(s: AlarmSignal, ws: string): Promise<void> {
  try {
    await notifyAttention({
      kind: 'intervention',
      title: 'Infra-liveness BLOCKER',
      body: s.summary,
      importance: 'urgent',
      workspaceId: ws,
      data: { signal: s.key },
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  try {
    await broadcastSevereEvent({
      summary: `${SUMMARY_PREFIX}${s.summary}`,
      body:
        `Detected by the request-path infra-liveness alarm (R4-3/R4-8), independent of the background ` +
        `routine engine. Signal: ${s.key}. Workspace: ${ws}. See harness_escalations for the durable record.`,
      category: 'severe-event',
      conditionKey: `infra-liveness:${s.key}`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

async function defaultPageResolved(sigs: string[]): Promise<void> {
  if (sigs.length === 0) return;
  try {
    await broadcastSevereEventResolvedMany({
      conditionKeys: sigs.map((sig) => `infra-liveness:${sig}`),
      summary: `infra-liveness RECOVERED (${sigs.join(', ')}) — condition(s) no longer firing.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
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
  // WI-4023: paging defaults to a NO-OP here — a bare call to this pure(ish) tick
  // function (every unit test) must NEVER fire a real owner push / fleet broadcast.
  // The live scheduled loop (startInfraLivenessAlarm below) explicitly wires the
  // real defaultPage/defaultPageResolved. Getting this backwards (real-by-default)
  // is exactly the bug that fired live false alarms during this fix's own first
  // test run — see the coord broadcast + apology, 2026-07-11 02:10Z.
  const page = deps.page ?? (async () => {});
  const pageResolved = deps.pageResolved ?? (async () => {});

  const cached = readLast(ws);
  const snapshotAgeMs = cached ? now - cached.evaluatedAt : null;
  const stale = snapshotAgeMs === null || snapshotAgeMs > staleMs;
  const health = stale ? await compute(ws) : (cached as SystemHealth);

  // P-008: the PG-restart drift baseline. Read the previous postmaster-start value,
  // evaluate against it, then advance it to the current reading — but ONLY when PG
  // was readable this tick (cur != null). An unreadable tick must not clobber the
  // baseline, else the next readable tick would false-fire a "restart".
  const readBaseline = deps.readPostmasterBaseline ?? ((w: string) => lastPostmasterStartMs.get(w) ?? null);
  const writeBaseline = deps.writePostmasterBaseline ?? ((w: string, ms: number) => void lastPostmasterStartMs.set(w, ms));
  const prevPostmasterStartMs = readBaseline(ws);

  // EI-9794: fetch fresh fire-recency rows every tick (cheap — one indexed PK
  // read + two already-cached control-state reads) rather than folding into the
  // cached SystemHealth snapshot, so this signal is NEVER blinded by a stale
  // cache the way tickStale-suppressed signals can be — it is the one check that
  // must keep evaluating even when everything else is frozen.
  const readAutoloopFireRows = deps.readAutoloopFireRows ?? defaultReadAutoloopFireRows;
  const autoloopFireRows = await readAutoloopFireRows(ws).catch(() => [] as AutoloopFireRow[]);

  const signals = evaluateLivenessAlarm(health, snapshotAgeMs, {
    snapshotStaleMs: staleMs,
    prevPostmasterStartMs,
    autoloopFireRows,
  });
  const currentSigs = new Set(signals.map((s) => s.key));

  const curPostmasterStartMs = health.panels.infra?.data?.pg?.postmasterStartMs ?? null;
  if (curPostmasterStartMs !== null) writeBaseline(ws, curPostmasterStartMs);

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
  const recoveredBlockerSigs: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue; // still firing — keep the single open row
    // WI-4181: only a resolve that actually TRANSITIONED the row (wrote the
    // sibling escalation_resolved event) counts. resolveEscalation is idempotent
    // and returns the sentinel strings 'not_found' / 'already_resolved' /
    // 'requires_spawn_approve' WITHOUT writing — and broadcasting recovery on
    // mere PRESENCE of an "open" row turned a fold-window zombie (an old open
    // whose resolution had been evicted from listEscalationsPaginated's bounded
    // resolves window) into a storm: resolve() returned 'already_resolved' every
    // tick, nothing ever re-entered the window, and 17 request workers re-emitted
    // "RECOVERED (health-tick-stale)" every ~2min for ~12h (6,000+ duplicates).
    // Gating on the transition also collapses the multi-worker race on a GENUINE
    // recovery: only the worker whose resolve actually landed announces it.
    let transitioned = false;
    for (const rec of recs) {
      try {
        const outcome = await resolve(rec.msg_id, 'auto-resolved', `infra-liveness signal '${sig}' cleared (condition recovered)`);
        if (outcome === 'not_found' || outcome === 'already_resolved' || outcome === 'requires_spawn_approve') continue;
        resolved.push(rec.msg_id);
        transitioned = true;
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    if (transitioned && recs.some((r) => r.severity === 'blocker')) recoveredBlockerSigs.push(sig);
    // Drop the in-memory cooldown so a genuine re-occurrence after recovery
    // re-fires immediately ("re-fire only after auto-resolve").
    lastAlertedAt.delete(sig);
  }
  // WI-4023: pair the fleet-facing all-clear with the auto-resolve above — see the
  // paging note on the fire loop for why this is needed (a durable escalation row
  // alone is not an active page, so its recovery deserves the same fleet visibility).
  await pageResolved(recoveredBlockerSigs);

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
    // WI-4023 (root-cause fix, 2026-07-11): a `blocker` signal used to reach ONLY
    // `openEscalation` — a durable PG row with no active push. Verified live
    // (2026-07-10 20:38-21:22 incident): this alarm fired `health-tick-stale` /
    // `dead-routines` blockers correctly within ~1-8min of the DBOS engine dying,
    // but NOBODY noticed for ~40min because nothing paged — the escalation just sat
    // in `harness_escalations` behind the ambient/no-default-surface coord:inbox
    // filter, alongside 292 OTHER escalations that had aged past the attention
    // threshold unread. git-sync-stall-watchdog.ts already pages on its own alarms
    // (notifyAttention + broadcastSevereEvent) — this brings the SAME active paging
    // to every `blocker`-severity infra-liveness signal, not just git-sync's.
    if (s.severity === 'blocker') await page(s, ws);
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
    () =>
      runLivenessAlarmTick(undefined, { page: defaultPage, pageResolved: defaultPageResolved }).then(
        () => undefined,
        () => undefined,
      ),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signal debounce AND the P-008 PG-restart baseline
 *  (both are module-level per-worker state a hermetic test must reset). */
export function _resetLivenessAlarmDebounce(): void {
  lastAlertedAt.clear();
  lastPostmasterStartMs.clear();
}
