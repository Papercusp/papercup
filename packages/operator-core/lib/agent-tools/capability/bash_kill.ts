/**
 * capability:bash_kill — stop a background shell job started by `capability:bash`
 * (run_in_background). Mirrors the native KillShell tool: SIGTERM, then SIGKILL
 * after a short grace period. Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getJob, killJob, readJobOutput } from './bash-jobs';

export default defineTool({
  name: 'capability:bash_kill',
  description:
    'Stop a background shell job (started by capability:bash run_in_background:true). Sends SIGTERM then SIGKILL. Returns the final tail of output.',
  guidance: {
    when: 'Stop a background job you no longer need (a dev server, a runaway build).',
    notWhen: 'A job that already finished — capability:bash_output already shows its terminal status.',
    chaining: 'capability:bash { run_in_background:true } → … → capability:bash_kill { bash_id }.',
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    bash_id: z.string().min(1).describe('The id returned by capability:bash (run_in_background).'),
  }),
  async handler(args, ctx) {
    const job = getJob(args.bash_id);
    if (!job) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'unknown_bash_id' }) },
        ],
        isError: true,
      };
    }
    void ctx;
    const r = killJob(job);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            already_done: r.alreadyDone,
            status: job.status,
            exit_code: job.exitCode,
            tail: readJobOutput(job, true).slice(-2000),
          }),
        },
      ],
    };
  },
});
