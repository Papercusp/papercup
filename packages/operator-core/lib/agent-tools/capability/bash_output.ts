/**
 * capability:bash_output — read incremental output from a background shell job
 * started by `capability:bash` (run_in_background). Mirrors the native
 * BashOutput tool: each call returns the output produced SINCE the last read
 * (use `peek` to read without advancing the cursor) plus the job's status.
 * Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getJob, readJobOutput } from './bash-jobs';

export default defineTool({
  name: 'capability:bash_output',
  description:
    'Read new output from a background shell job (started by capability:bash run_in_background:true). Returns output since the last read plus status (running/completed/failed/…) and exit code.',
  guidance: {
    when: 'Poll a background job started by capability:bash. Call repeatedly to drain output as it runs; the final call after status leaves "running" gives the tail + exit code.',
    notWhen: 'For a foreground command — its output is in the capability:bash result directly.',
    chaining: 'capability:bash { run_in_background:true } → capability:bash_output { bash_id } (repeat) → capability:bash_kill to stop early.',
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    bash_id: z.string().min(1).describe('The id returned by capability:bash (run_in_background).'),
    peek: z.boolean().optional().describe('Read without advancing the read cursor (default false).'),
  }),
  async handler(args, ctx) {
    const job = getJob(args.bash_id);
    if (!job) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'unknown_bash_id',
              advice: 'No such background job (it may have been pruned, or the id is wrong). Re-run with capability:bash.',
            }),
          },
        ],
        isError: true,
      };
    }
    void ctx;
    const output = readJobOutput(job, args.peek ?? false);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            status: job.status,
            exit_code: job.exitCode,
            running: job.status === 'running',
            total_bytes: job.totalBytes,
            log_path: job.logPath,
            output,
          }),
        },
      ],
    };
  },
});
