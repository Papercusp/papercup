/**
 * sentinel:converse — the Sentinel-as-Herald brain alias.
 *
 * The sentinel watcher is re-homed onto the always-on, voice-first **Herald**:
 * the SAME converse brain as `operator:converse`, only loaded with the sentinel
 * persona set (sentinel.persona[.<mode>-mode].md / .converse.md / .tools.md under
 * apps/operator/prompts/). Rather than fork the ~500-line converse handler, this
 * alias registers a thin tool under the `sentinel:converse` name that delegates
 * to the operator converse handler with `role` defaulted to 'sentinel'.
 *
 * The route (`/agent-mcp/operator-converse`) resolves `${role}:converse`, so a
 * body with `role:'sentinel'` lands here; the handler then forces the persona to
 * 'sentinel' (the wire arg can still override, but the default IS the point).
 *
 * Registered the same way `operator:converse` is — imported by agent-tools/index
 * so its `defineTool` runs at module load and `lookupByMcpName('sentinel:converse')`
 * resolves it. The capability + allowlist gates are the sentinel's
 * (operator:converse cap on the BLUEPRINT_ROLE_CAPS.sentinel grant; the role is
 * already allowlisted on the underlying tool).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import operatorConverse from './converse';

// The operator converse handler — reused verbatim. It reads `input.role` to pick
// the persona; this alias defaults that to 'sentinel' when the caller omits it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharedHandler = (operatorConverse as any).handler as (
  input: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
) => unknown;

export default defineTool({
  name: 'sentinel:converse',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Sentinel/Herald brain conversation turn. The operator:converse brain loaded with the always-on, voice-first Herald persona (role=sentinel). Same lifecycle (prompt build, budget gate, LLM stream, spend, mem0); only the persona differs.',
  capability: 'operator:converse',
  requirePrincipal: false,
  agentRoles: ['operator', 'sentinel'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  replayBufferSize: 5000,
  modality: ['text', 'voice'],
  // Mirror the operator converse arg surface, but default `role` to 'sentinel'
  // (the whole point of the alias). z.passthrough so any field the operator
  // schema accepts flows through to the shared handler unchanged.
  args: z
    .object({
      role: z.string().optional().default('sentinel'),
    })
    .passthrough(),
  events: {
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
  },
  handler: async (input, ctx) => {
    const merged = { ...(input as Record<string, unknown>) };
    if (merged.role == null || merged.role === '') merged.role = 'sentinel';
    return sharedHandler(merged, ctx);
  },
});
