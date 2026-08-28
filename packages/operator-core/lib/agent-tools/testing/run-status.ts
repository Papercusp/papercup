/**
 * testing:run-status — poll a detached recovery started by testing:run.
 *
 * A foreground testing:run timeout starts an independent store-backed run and
 * returns its id. This read surface exposes the same bounded snapshot that the
 * admin testing route can read, so the timeout response points to a callable
 * agent tool rather than an operator-only HTTP route or an undefined "poll".
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getRunAsync, type RunSnapshot } from '../../testing-run-store';

export type TestingRunStatusResult =
  | { ok: true; snapshot: RunSnapshot }
  | { ok: false; error: 'unknown_run'; runId: string; message: string };

const argsSchema = z.object({
  runId: z
    .string()
    .min(1)
    .max(120)
    .describe('Detached run id returned by testing:run after a foreground timeout.'),
});

export default defineTool({
  name: 'testing:run-status',
  // @not-a-cell live state, but a SINGLE DOOR keyed by an ephemeral run id: getRunAsync()
  // is the one local-first/durable snapshot oracle and the admin route consumes that same
  // function rather than re-deriving it. A scalar registry cell would require one entry per
  // detached run and add a read door without removing one.
  description:
    'Read the local-first durable snapshot for a detached testing:run recovery with testing:run-status { runId }. Returns running/pass/fail/cancelled/error status, bounded output, and exit metadata; unknown or expired ids return an explicit unknown_run result.',
  guidance: {
    when: 'Poll the detachedRunId returned by testing:run after a foreground timeout until its snapshot reaches a terminal status.',
    notWhen:
      'Start a test run (use testing:run), read persisted test history (use testing:runs), or poll a capability:bash job (use capability:bash_output). An unknown_run means the in-memory snapshot is missing or has expired; it is not evidence that the test passed.',
    chaining: 'testing:run → timeout with detachedRunId → testing:run-status { runId } until status is pass, fail, cancelled, or error.',
    seeAlso: ['testing:run (start an exact-file run)', 'testing:runs (read persisted test-run history)'],
  },
  capability: 'operator:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: argsSchema,
  async handler(args): Promise<{ data: TestingRunStatusResult }> {
    const snapshot = await getRunAsync(args.runId);
    if (!snapshot) {
      return {
        data: {
          ok: false,
          error: 'unknown_run',
          runId: args.runId,
          message:
            'No detached test-run snapshot is available for this runId; it may be unknown or evicted after the one-hour retention window. This is not evidence that the test passed.',
        },
      };
    }
    return { data: { ok: true, snapshot } };
  },
});
