/**
 * `system:supervision-reconcile` — the failed-unit reconciler's routine-engine registration
 * (critical-process-supervisor-2026-07-04 P-002). The actual parse/decide/act logic lives in
 * `../../supervision/unit-reconciler.ts` (pure + testable, no PG/DBOS dependency); this module
 * is just the thin adapter that wires it into the ephemeral-executor's dispatch (`system-actions.ts`)
 * with production deps (real `systemctl --user`, the coord broadcast, `FLAGS.SUPERVISOR_AUTO_RESTART`).
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine (60s cadence) by
 * `seed-supervision-reconcile-routine.ts` — see that file for why this is a bespoke seed rather
 * than a per-install blueprint `triggers.schedule` entry (an operator-HOME-level concern, not a
 * per-blueprint-install one — mirrors `hive-git-gc-routine.ts`'s documented deviation).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { reconcileTick, type ReconcilerDeps } from '../../supervision/unit-reconciler';

const execFileP = promisify(execFile);

/** Coord identity for the reconciler's own broadcasts (mirrors service-health.ts's HEALTH_IDENTITY
 *  + git-sync-action.ts's own static-client identity). */
const SUPERVISION_IDENTITY: AgentIdentity = {
  ownerId: 'supervision-reconciler',
  ownerLabel: 'supervision-reconciler',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Real `systemctl --user <args>` exec, 10s timeout (a hung systemctl must never wedge the
 *  60s-cadence tick indefinitely). Rejects on nonzero exit OR spawn failure — the caller
 *  (`reconcileTick`) treats any rejection uniformly as "systemctl unreachable this tick". */
async function execSystemctlUser(args: string[]): Promise<string> {
  const { stdout } = await execFileP('systemctl', ['--user', ...args], { timeout: 10_000 });
  return stdout;
}

function productionDeps(ctx: SystemActionCtx): ReconcilerDeps {
  return {
    execUser: execSystemctlUser,
    now: () => Date.now(),
    notify: async ({ summary, kind }) =>
      void (await sendMessage(SUPERVISION_IDENTITY, {
        to: ['*'],
        summary,
        category: kind === 'escalation' ? undefined : 'supervision',
        kind: kind === 'escalation' ? 'escalation' : 'message',
        harnessSlug: ctx.installSlug,
      })),
    autoRestartFlagOn: () => getFlag(FLAGS.SUPERVISOR_AUTO_RESTART, 'system').catch(() => false),
  };
}

registerSystemAction('supervision-reconcile', async (ctx: SystemActionCtx) => {
  await reconcileTick(productionDeps(ctx));
});
