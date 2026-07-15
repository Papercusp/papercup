/** session:carry-drill — P-020's explicit, default-off cold-boot chaos surface. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  gradeColdBootDrill,
  reportColdBootDrills,
  startColdBootDrill,
  verifyColdBootDrill,
} from '../../cold-boot-drill-live';

const argsSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('start'),
    sessionClass: z.string().trim().min(1).max(120).optional(),
    effectiveWindowTokens: z.number().int().min(16_000).max(1_000_000).optional(),
  }),
  z.object({
    op: z.literal('grade'),
    drillId: z.string().trim().min(1).max(200),
  }),
  z.object({ op: z.literal('report') }),
  // EI-12655 fix (c): post-start lifecycle self-check — assert the drill left
  // every durable leg (ledger row, host respawn event, a TERMINAL outcome, a
  // live owner socket) instead of discovering a silent vanish at grade time.
  z.object({
    op: z.literal('verify'),
    drillId: z.string().trim().min(1).max(200).optional(),
    sessionClass: z.string().trim().min(1).max(120).optional(),
  }),
]);

export default defineTool({
  name: 'session:carry-drill',
  description:
    'Opt-in cold-boot chaos drill for THIS session: force a clean-boundary deterministic carry-respawn, mechanically grade what the successor searched for, verify a drill left every durable lifecycle leg, or report per-class sufficiency + terminal outcomes. Destructive start is default-off and rate-limited.',
  capability: 'coord:write',
  guidance: {
    when:
      'P-020 carry validation only. Call start at a clean boundary; the fresh successor follows the injected marker and calls grade at its next clean boundary.',
    notWhen:
      'Routine compaction or ordinary session recovery — use session:request-compaction. Never start while an owner message is unanswered or work is uncheckpointed.',
    seeAlso: ['session:request-compaction', 'coord:orient'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: argsSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const result =
      args.op === 'start'
        ? await startColdBootDrill({
            ownerId: identity.ownerId,
            ownerLabel: identity.ownerLabel,
            workspaceId: identity.workspaceId,
            sessionClass: args.sessionClass,
            effectiveWindowTokens: args.effectiveWindowTokens,
          })
        : args.op === 'grade'
          ? await gradeColdBootDrill(identity.ownerId, args.drillId)
          : args.op === 'verify'
            ? await verifyColdBootDrill(identity.ownerId, {
                drillId: args.drillId,
                sessionClass: args.sessionClass,
              })
            : await reportColdBootDrills();
    const failed = 'ok' in result && result.ok === false;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(failed ? { isError: true } : {}),
    };
  },
});

