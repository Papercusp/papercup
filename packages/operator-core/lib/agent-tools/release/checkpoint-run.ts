/**
 * release:checkpoint-run — fire the green-checkpoint GATE SUITE once, on demand (WI-1320 follow-up).
 *
 * Closes the last "no manual lever" gap in the release pipeline. The three moving parts each
 * now have a fire-now:
 *   - COMMIT  (staging ← agents' work) → git-sync:run
 *   - VERDICT (green pin ← full suite)  → THIS verb           ← was the missing one
 *   - DEPLOY  (:3070 ← green pin)       → release:deploy op:trigger/force
 *
 * The green-checkpoint is the VERDICT producer: it runs the full test battery under 8-fork load
 * and, if green, fast-forwards the green pin so release:deploy can ship it. It otherwise runs
 * ONLY on its hourly cron (or routines:set pause/retune) — so after fixing/quarantining reds you
 * had to WAIT up to an hour for a fresh verdict. This fires the SAME suite the cron tick runs.
 *
 * Detached (the suite runs up to ~55 min, bounded by RuntimeMaxSec) + OOM-safe: green-checkpoint.ts
 * self-locks, so firing this while a cron tick is mid-run no-ops rather than spawning a second
 * concurrent suite. Verdict lands on /admin/git, not this reply.
 *
 * WI-1562: a second manual fire while one was already in flight used to come back with only a
 * bare "may already be running" string — unclear enough that a concurrent caller could read it
 * as a transient failure and retry (or manually intervene), which starved the gate of a verdict.
 * Now the pre-launch check returns a STRUCTURED `already_running` reply (unit/candidate/
 * started_at/eta_sec) so a caller can tell "wait for it" from "try again" — pass `force:true` to
 * launch anyway.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { launchDetachedCheckpoint } from '../../release-checkpoint-launch';

export default defineTool({
  name: 'release:checkpoint-run',
  profile: 'engineer',
  description:
    "FIRE the green-checkpoint NOW — run the full gate suite against current staging on demand (instead of waiting for the hourly cron tick), and if it's green, advance the green pin so release:deploy can ship it. The gate's VERDICT producer had no manual lever (only routines:set cron/pause) — the same gap git-sync:run closed for the commit routine. Use it after you've fixed or quarantined the reds to force a fresh verdict instead of waiting up to an hour. Detached (the suite runs up to ~55 min) + self-locked against a concurrent tick (won't OOM). Watch /admin/git for the verdict, then release:deploy { op:status } → op:trigger.",
  capability: 'operator:write',
  guidance: {
    when:
      "You've fixed or quarantined the reds and want a FRESH green verdict now rather than waiting for the next hourly green-checkpoint. Or the gate looks stale and you want to re-run the suite on demand.",
    notWhen:
      'To retune/pause the checkpoint cadence use routines:set. To SHIP an already-green pin use release:deploy op:trigger (checkpoint-run produces green; it does not deploy). To force an UN-green deploy use release:deploy op:force.',
    chaining:
      'fix/quarantine reds → release:checkpoint-run → (watch /admin/git for advanced/green) → release:deploy { op:status } → op:trigger { confirm:true }.',
    seeAlso: [
      'release:deploy (deploy the now-green pin — op:status then op:trigger)',
      'release:checkpoint-config (tune the checkpoint gate)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 5 } },
  args: z.object({
    force: z
      .boolean()
      .optional()
      .describe(
        'Skip the already-running refusal (WI-1562) and attempt the launch anyway. systemd itself still refuses a truly concurrent same-unit run — force only bypasses OUR proactive check.',
      ),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('release:checkpoint-run requires operator, architect, or queen role');
    }
    const result = await launchDetachedCheckpoint({ force: args.force });
    if (!result.launched && result.reason === 'already_running' && result.alreadyRunning) {
      const a = result.alreadyRunning;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              already_running: true,
              unit: a.unit,
              candidate: a.candidate ?? null,
              started_at: a.started_at ?? null,
              eta_sec: a.eta_sec ?? null,
              note:
                'A checkpoint run for this root is already in flight; its quiet-cut auto-judges the newest tip anyway once it finishes, so a re-fire is usually unnecessary — wait for it, or pass force:true to launch a second one anyway.',
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: result.launched,
            ...result,
            note: result.launched
              ? 'green-checkpoint suite launched (detached, up to ~55 min). Watch /admin/git or the log for the verdict; if green it advances the pin. Then release:deploy { op:status } → op:trigger.'
              : `not launched: ${result.reason ?? 'unknown'} — a manual checkpoint may already be running (see the log), or a cron tick is mid-run (which is fine — it will produce the verdict).`,
          }),
        },
      ],
    };
  },
});
