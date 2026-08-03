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
import {
  appendResidueSample,
  censusTerminalResidue,
  evaluateResidueTrend,
  resolveTerminalSliceAbs,
} from '../../task-manager/terminal-residue-census';
import { readResidueSamples, writeResidueSamples } from '../../task-manager/terminal-residue-store';

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
/** GC is cheap but pointless every 30s — roughly hourly at the 30s cadence. */
const GC_EVERY_N_TICKS = 120;
/** The residue census is a trend over DAYS; hourly is ample and keeps the ring small. */
const RESIDUE_EVERY_N_TICKS = 120;
/** Don't re-broadcast an accumulation report more than once every few hours. */
const RESIDUE_RENOTIFY_MS = 6 * 60 * 60_000;
let tickCount = 0;
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

  tickCount += 1;
  if (tickCount % GC_EVERY_N_TICKS === 0) {
    await gcTerminalTasks(TERMINAL_RETENTION_HOURS).catch(() => 0);
  }
  if (tickCount % RESIDUE_EVERY_N_TICKS === 0) {
    await sampleResidue(ctx, tick.scan.userManagerRoot);
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
async function sampleResidue(ctx: SystemActionCtx, userManagerRoot: string | null): Promise<void> {
  try {
    const sliceAbs = resolveTerminalSliceAbs(userManagerRoot);
    if (!sliceAbs || !nodeCgroupFs.isDir(sliceAbs)) return;

    const census = censusTerminalResidue(sliceAbs, nodeCgroupFs);
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
        `of ${census.scopesTotal} terminal scope(s).`,
      category: 'task-manager',
      kind: 'message',
      harnessSlug: ctx.installSlug,
    });
  } catch {
    /* the leading indicator must never break the reconcile it observes */
  }
}
