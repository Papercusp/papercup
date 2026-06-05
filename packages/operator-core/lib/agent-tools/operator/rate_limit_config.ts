/**
 * operator:rate_limit_config — read / edit the live fleet rate-limit knobs
 * (rate-limit-layer-v2 D-004): `maxSimultaneousAgents` (the fleet-wide cap on
 * concurrently-running agent spawns) and `concurrencyFloor` (the AIMD floor, D-005).
 *
 * A `set` persists to PG (`operator_rate_limit_config`, migration 161) and propagates
 * LIVE through the in-process bus — the governor's global gate, the orchestrator
 * dispatch ceiling, and pty-bridge honor the new value on their next check, no restart.
 * Mirrors `operator:preferences` (read open, write operator/architect-gated).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  RATE_LIMIT_MAX_CEILING,
  readRateLimitConfig,
  writeRateLimitConfig,
} from '../../rate-limit-config';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'operator:rate_limit_config',
  profile: 'engineer',
  description:
    'Read or edit the live fleet rate-limit config: maxSimultaneousAgents (fleet-wide concurrent-agent cap, honored live by the governor + dispatcher) and concurrencyFloor (the AIMD floor). Edits persist + propagate with zero restart.',
  capability: 'operator:write',
  guidance: {
    when: 'The user wants to throttle or open up the fleet ("drop to 2 agents while I use Claude", "back to 16"), or you need the persisted cap/floor values.',
    notWhen: 'READ the live pacing/pause/usage state — dev:rate_governor_status (this tool reads the persisted CONFIG, not the live bucket state).',
    chaining: 'After a set, dev:rate_governor_status shows the new cap take effect (fleet.cap / fleet.effective).',
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      maxSimultaneousAgents: z.number().int().min(1).max(RATE_LIMIT_MAX_CEILING).optional(),
      concurrencyFloor: z.number().int().min(1).max(RATE_LIMIT_MAX_CEILING).optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return { content: [{ type: 'text', text: JSON.stringify({ config: await readRateLimitConfig() }) }] };
    }
    if (ctx.role !== 'operator' && ctx.role !== 'architect') {
      throw new Error('operator:rate_limit_config set requires operator or architect role');
    }
    if (args.maxSimultaneousAgents === undefined && args.concurrencyFloor === undefined) {
      throw new Error('set requires maxSimultaneousAgents and/or concurrencyFloor');
    }
    const current = await readRateLimitConfig();
    const config = await writeRateLimitConfig({
      maxSimultaneousAgents: args.maxSimultaneousAgents ?? current.maxSimultaneousAgents,
      concurrencyFloor: args.concurrencyFloor ?? current.concurrencyFloor,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config }) }] };
  },
});
