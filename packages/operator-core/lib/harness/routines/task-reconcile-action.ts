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
import { reconcileTick } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { gcTerminalTasks } from '../../task-manager/store';

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
let tickCount = 0;

registerSystemAction('task-reconcile', async (ctx: SystemActionCtx) => {
  await reconcileTick({
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
});
