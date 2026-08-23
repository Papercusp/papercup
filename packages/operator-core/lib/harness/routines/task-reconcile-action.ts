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
import { statSync } from 'node:fs';

import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { REPO_ROOT } from '../../agent-tools/docs/_repo-paths';
import { isTaskManagerEnabled } from '../../task-manager/enabled';
import { reconcileTick } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { gcTerminalTasks, listLiveTasks } from '../../task-manager/store';
import {
  censusAgentSessionProgress,
  evaluateAgentSessionResidue,
} from '../../task-manager/agent-session-progress-census';
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
/** Cap on the per-sample `unclaimedScopes` detail written into the routine row. */
const MAX_REPORTED_UNCLAIMED_SCOPES = 20;
/** The headless-agent progress census rides the same hourly cadence as the window one. */
const PROGRESS_INTERVAL_MS = 60 * 60_000;
const PROGRESS_RENOTIFY_MS = 6 * 60 * 60_000;
/**
 * How many quiet agent-sessions before this reports (EI-21268871278252116).
 *
 * NOT zero, deliberately. A single session can be legitimately quiet for hours —
 * one parked on a long `events:await` writes nothing — and an indicator that
 * fires on every straggler gets muted within a day, which is the exact failure
 * D-016 recorded for the window census. What distinguishes residue is
 * ACCUMULATION: the 2026-08-23 incident was 33 scopes / 118 processes, and the
 * measured post-reap baseline was 0 quiet of 90 live. A floor of 5 therefore sits
 * far above observed noise while still catching that incident six times over.
 */
const AGENT_SESSION_QUIET_THRESHOLD = 5;

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
/** Own watermark, so a fault in either census can never suppress the other. */
let lastProgressAtMs: number | null = null;
let lastProgressNotifyAtMs = 0;

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

  if (isMaintDue({ lastAtMs: lastProgressAtMs, nowMs, intervalMs: PROGRESS_INTERVAL_MS })) {
    lastProgressAtMs = nowMs;
    await reportAgentSessionProgress(ctx);
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
      // EI-20369673282334981 asks for the new bucket's POPULATION to be measured
      // for a few days before anyone proposes acting on it, so persist the members
      // and not just the count — a count cannot tell you afterwards whether the 3
      // it saw were the same 3 every hour (accumulating residue) or 3 different
      // ones (ordinary churn), which is the whole question. Bounded so a pathological
      // host cannot bloat the routine row.
      unclaimedScopes: census.dead
        .filter((d) => d.disposition === 'live-service-unclaimed')
        .slice(0, MAX_REPORTED_UNCLAIMED_SCOPES)
        .map((d) => ({
          scope: d.scope,
          pidCount: d.pidCount,
          oldestPidAgeMs: d.oldestPidAgeMs,
          // Empty means "no PAPERCUSP_SID readable", NOT "no owner" — the majority
          // case on this box. Never render it as unowned.
          owningSessionIds: d.owningSessionIds,
        })),
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
        `service or tracked tenant (do not reap), ${census.deadIndeterminate} undecidable` +
        // EI-20369673282334981: the bucket that used to be invisible. Named
        // separately because "listening, old, and claimed by no tracked tenant" is
        // the shape a leaked server has — and also the shape the :3170 staging
        // operator has, which is why the wording asks for a LOOK, never a reap.
        (census.deadLiveServiceUnclaimed > 0
          ? `, and ${census.deadLiveServiceUnclaimed} hold a LISTENING socket that no tracked ` +
            `tenant claims and are past the staleness threshold — worth a look (this is where a ` +
            `leaked server hides), but NOT reapable: shared infra whose launching window closed ` +
            `looks identical from here.`
          : '.'),
      category: 'task-manager',
      kind: 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the leading indicator must never break the reconcile it observes */
  }
}

/**
 * The HEADLESS-agent residue indicator (EI-21268871278252116) — the blind spot
 * `sampleResidue` above cannot cover.
 *
 * That census walks the TERMINAL slice and decides liveness with the window
 * probe, which `scan.ts:218` gates behind `isTerminalWindowScope`. A headless
 * agent session has no window at all, so for this population the probe returns
 * `not-a-window` and the scope can never be observed dead. That is how 118
 * processes across 33 scopes accumulated over ~71h while every liveness surface
 * reported healthy.
 *
 * The discriminator here is log-mtime — direct progress evidence — chosen after
 * three plausible instruments gave confident WRONG answers (cmdline-tail match,
 * window-title token match, and a `coord_presence.pid` join that false-positived
 * on a live fleet member holding 97 processes). It needs no cmdline match, no
 * window, and no presence row, which matters because both root causes
 * (booted-but-never-woken, and the unbounded `psu-pty-host` CR resubmit loop,
 * WI-41044) never reach a first turn and so never declare `coord_presence`.
 *
 * REPORT-ONLY, same as its sibling and for the same reason (D-006 / D-010). A
 * quiet log is strong evidence of a stalled session, not proof of abandonment.
 * The one reap this evidence has authorised was run by hand with every log tail
 * preserved first.
 *
 * Fail-soft: an indicator must never break the reconcile it rides alongside.
 */
async function reportAgentSessionProgress(ctx: SystemActionCtx): Promise<void> {
  try {
    const rows = await listLiveTasks(ctx.workspaceId ?? undefined);
    const census = censusAgentSessionProgress(rows, {
      // MUST return null (never 0) when unreadable — `censusAgentSessionProgress`
      // counts that as `unreadable`, never as quiet. Collapsing the two is the
      // false-absence trap this whole module exists to avoid.
      statMtimeMs: (path) => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return null;
        }
      },
    });

    const verdict = evaluateAgentSessionResidue(census, AGENT_SESSION_QUIET_THRESHOLD);
    if (verdict.verdict === 'ok') return;

    const nowMs = Date.now();
    if (nowMs - lastProgressNotifyAtMs < PROGRESS_RENOTIFY_MS) return;
    lastProgressNotifyAtMs = nowMs;

    await sendMessage(TASK_MANAGER_IDENTITY, {
      to: ['*'],
      summary:
        `[task-manager] headless agent-session residue: ${verdict.summary} ` +
        `(${census.active} active, ${census.quiet} quiet, ${census.tooYoung} too young, ` +
        `${census.noLog} no-log, ${census.unreadable} unreadable of ${census.measured} live). ` +
        `These sessions hold a full agent process subtree and, if they never took a first ` +
        `turn, declare no coord_presence — so they are invisible to fleet/presence/reaper. ` +
        `REPORT ONLY: preserve each log tail before any reap, and never kill by pattern ` +
        `(processes:kill { taskId }).`,
      // 'unknown' means the instrument failed, which is an escalation: a census
      // that cannot measure must not read as a quiet, healthy box.
      category: verdict.verdict === 'unknown' ? undefined : 'task-manager',
      kind: verdict.verdict === 'unknown' ? 'escalation' : 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the indicator must never break the reconcile it observes */
  }
}
