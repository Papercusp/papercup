/**
 * `system:task-reconcile` — the task-manager reconciler's routine-engine
 * registration (task-manager-no-escape-2026-07-27, P-011).
 *
 * Thin adapter, matching `supervision-reconcile-action.ts`: all the parse/decide
 * logic lives in `../../task-manager/{scan,reconcile,reconcile-tick}.ts` (pure or
 * dependency-injected, no PG/DBOS coupling), and this module only wires
 * production deps — the real /sys + /proc reader, the repo-root foreign
 * signature, and the coord broadcast.
 *
 * REPORT-ONLY by construction (plan D-010). There is no auto-kill and no
 * auto-freeze path in this action, and that is not a flag: the code to do it does
 * not exist yet. Residue classification has to be right for a sustained window
 * before anything acts on it, because a reaper firing on a false `unaccounted`
 * takes out real work — strictly worse than the bypass it polices.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';
import { isTaskManagerEnabled } from '../../task-manager/enabled';
import { reconcileTick } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { gcTerminalTasks } from '../../task-manager/store';
import { nodeCgroupFs } from '../../task-manager/cgroup-read';
import { nodeResidueLivenessProbe } from '../../task-manager/residue-liveness-probe';
import {
  appendResidueSample,
  censusTerminalResidue,
  evaluateResidueTrend,
  isMaintDue,
  resolveTerminalSliceAbs,
} from '../../task-manager/terminal-residue-census';
import {
  readLastCensusAtMs,
  readResidueSamples,
  writeResidueSamples,
} from '../../task-manager/terminal-residue-store';

/** Coord identity for the reconciler's own broadcasts (mirrors SUPERVISION_IDENTITY). */
const TASK_MANAGER_IDENTITY: AgentIdentity = {
  ownerId: 'task-manager',
  ownerLabel: 'task-manager',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Terminal rows are the "what ran overnight and what did it cost" record. A week
 *  is long enough to answer that and short enough to keep the live index hot. */
const TERMINAL_RETENTION_HOURS = 168;
/** GC is cheap but pointless every 30s — hourly is ample. */
const GC_INTERVAL_MS = 60 * 60_000;
/** The residue census is a trend over DAYS; hourly is ample and keeps the ring small. */
const RESIDUE_INTERVAL_MS = 60 * 60_000;
/** Don't re-broadcast an accumulation report more than once every few hours. */
const RESIDUE_RENOTIFY_MS = 6 * 60 * 60_000;

/**
 * EI-19407950136194410 — WALL-CLOCK watermarks, never tick counts.
 *
 * These two jobs used to be gated on `tickCount % 120` against a module-scoped
 * counter. A counter inside the process resets when the process does, so a host
 * restarting more often than hourly never reached 120 and ran NEITHER job, silently
 * and forever. See `isMaintDue` for the full account; the short version is that the
 * census is the leading indicator for residue that host CHURN creates, so the old
 * gate went blind exactly when it was needed and a restart meant to activate it
 * pushed it out another hour instead.
 *
 * The two jobs need DIFFERENT strategies because they differ in idempotence:
 *
 *  - GC is an idempotent, cheap DELETE with a time predicate. It needs no persisted
 *    watermark at all: `null` means "first tick of this process", which answers DUE,
 *    so a restart makes the GC run SOONER rather than never. Re-running it costs one
 *    near-no-op DELETE.
 *  - The CENSUS is NOT idempotent — every run appends a sample to a multi-week trend
 *    ring, and the trend is a floor comparison across that ring. Sampling on every
 *    restart would let a churning host inflate the ring and skew the very floor the
 *    indicator is built on. So it hydrates the watermark the store ALREADY persists
 *    (`lastCensusAtMs`) once per process, and gates on that.
 */
let lastGcAtMs: number | null = null;
let lastResidueAtMs: number | null = null;
let residueWatermarkHydrated = false;
let lastResidueNotifyAtMs = 0;

registerSystemAction('task-reconcile', async (ctx: SystemActionCtx) => {
  // WI-6499: the routine stays REGISTERED but no-ops while the task manager is
  // flag-OFF. Gating here rather than at seed time means a flip takes effect on
  // the next 30s tick instead of requiring an operator restart to re-seed.
  if (!(await isTaskManagerEnabled('routine:task-reconcile'))) return;

  const tick = await reconcileTick({
    scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
    notify: async ({ summary, kind }) =>
      void (await sendMessage(TASK_MANAGER_IDENTITY, {
        to: ['*'],
        summary,
        category: kind === 'escalation' ? undefined : 'task-manager',
        kind: kind === 'escalation' ? 'escalation' : 'message',
        harnessSlug: ctx.installSlug,
      })),
  });

  const nowMs = Date.now();

  if (isMaintDue({ lastAtMs: lastGcAtMs, nowMs, intervalMs: GC_INTERVAL_MS })) {
    // Stamp BEFORE awaiting: a failed GC must not re-fire every 30s, and the stamp
    // also keeps two overlapping ticks from both entering.
    lastGcAtMs = nowMs;
    await gcTerminalTasks(TERMINAL_RETENTION_HOURS).catch(() => 0);
  }

  const target = { installSlug: ctx.installSlug, workspaceId: ctx.workspaceId };
  if (!residueWatermarkHydrated) {
    // Once per process. A read failure yields null, which reads as DUE — the census
    // erring toward one extra sample beats it going quiet on an unreadable store.
    residueWatermarkHydrated = true;
    lastResidueAtMs = await readLastCensusAtMs(target);
  }
  if (isMaintDue({ lastAtMs: lastResidueAtMs, nowMs, intervalMs: RESIDUE_INTERVAL_MS })) {
    lastResidueAtMs = nowMs;
    // EI-20369673282334981: hand the census the pids this very tick just CONFIRMED
    // alive against the task ledger. `nodeResidueLivenessProbe`'s own contract asks
    // for exactly this ("a caller that already holds the enrolled-task pids (the
    // reconcile tick does) should pass them"), and until now the sole production
    // call site passed nothing — so `knownLive` was `undefined` and listening
    // sockets were the only liveness evidence the census ever had.
    await sampleResidue(ctx, tick.scan.userManagerRoot, aliveEnrolledPids(tick));
  }
});

/**
 * P-013 / D-017 — the LEADING indicator, sampled alongside the reconcile it cannot
 * be derived from.
 *
 * This deliberately does NOT read `tick.summary.unaccounted`. That number is
 * pinned near 0 for this residue class: the window-liveness probe sits downstream
 * of the scan's repo-root cmdline filter, so most dead-window scopes are never
 * classified at all (measured: 14 dead-window scopes / 59 processes live, while
 * the same reconcile reported `unaccounted: 0` with `degraded: false`). The census
 * walks the scopes itself, which needs no cmdline match.
 *
 * REPORT-ONLY (D-006 / D-010 / D-016). It broadcasts a message; nothing here
 * terminates anything, and 14 of 15 such scopes hold live agent sessions or shared
 * infra, so the wording must stay "a window closed but these kept running".
 *
 * Fail-soft end to end: a census or store failure must never break the reconcile
 * tick it rides alongside.
 */
/**
 * The pids this tick positively matched to a LIVE task-ledger row.
 *
 * Only `result.alive` — never `scannedProcesses`. The scan sees every process in
 * the user manager, so feeding it here would mark essentially the whole box "known
 * live" and turn the census's one remaining discriminator into a constant. What
 * makes this set meaningful is precisely that it is small and earned: a row the
 * reconciler just confirmed against a real process.
 *
 * A pid of 0/NaN is dropped rather than added — pid 0 is not a process, and a set
 * containing it would silently match nothing while looking populated.
 */
function aliveEnrolledPids(tick: { result: { alive: readonly { pid: number | null }[] } }): Set<number> {
  const out = new Set<number>();
  for (const a of tick.result.alive) {
    if (typeof a.pid === 'number' && Number.isFinite(a.pid) && a.pid > 0) out.add(a.pid);
  }
  return out;
}

async function sampleResidue(
  ctx: SystemActionCtx,
  userManagerRoot: string | null,
  knownLivePids: ReadonlySet<number>,
): Promise<void> {
  try {
    const sliceAbs = resolveTerminalSliceAbs(userManagerRoot);
    if (!sliceAbs || !nodeCgroupFs.isDir(sliceAbs)) return;

    // EI-19418147529720290: probe the dead scopes, so what we store and broadcast
    // distinguishes abandoned residue from a live service whose window was closed.
    // Un-probed, "15 dead scopes" reads as 15 things to clean up; measured, it was
    // 1 stale and 13 holding live tenants — and the largest was the staging
    // operator still serving :3170.
    const census = censusTerminalResidue(sliceAbs, nodeCgroupFs, {
      probe: nodeResidueLivenessProbe(knownLivePids),
    });
    const target = { installSlug: ctx.installSlug, workspaceId: ctx.workspaceId };
    const nowMs = Date.now();

    const ring = appendResidueSample(await readResidueSamples(target), {
      atMs: nowMs,
      scopesDead: census.scopesDead,
    });
    const verdict = evaluateResidueTrend(ring, { nowMs });

    await writeResidueSamples(target, ring, {
      lastCensusAtMs: nowMs,
      scopesTotal: census.scopesTotal,
      scopesDead: census.scopesDead,
      deadPids: census.deadPids,
      unprobeable: census.unprobeable,
      deadStale: census.deadStale,
      deadLiveServiceHeld: census.deadLiveServiceHeld,
      deadLiveServiceUnclaimed: census.deadLiveServiceUnclaimed,
      deadIndeterminate: census.deadIndeterminate,
      trend: verdict.trend,
      floorDelta: verdict.floorDelta,
    });

    if (!verdict.alarm) return;
    if (nowMs - lastResidueNotifyAtMs < RESIDUE_RENOTIFY_MS) return;
    lastResidueNotifyAtMs = nowMs;

    await sendMessage(TASK_MANAGER_IDENTITY, {
      to: ['*'],
      summary:
        `[task-manager] ${verdict.summary} ` +
        `Now ${census.scopesDead} dead-window scope(s) holding ${census.deadPids} process(es), ` +
        `of ${census.scopesTotal} terminal scope(s). ` +
        // The split, not just the total: a reader who acts on `scopesDead` will go
        // looking for things to kill, and most of them are live tenants.
        `Of those, ${census.deadStale} look STALE, ${census.deadLiveServiceHeld} hold a live ` +
        `service or tracked tenant (do not reap), ${census.deadIndeterminate} undecidable.`,
      category: 'task-manager',
      kind: 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the leading indicator must never break the reconcile it observes */
  }
}
