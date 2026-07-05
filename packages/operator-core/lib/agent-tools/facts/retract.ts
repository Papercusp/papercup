/**
 * facts:retract — soft-retract a standing fact by (scope, scopeRef, key) so it
 * stops folding into briefs/dossiers/orients (queen-memory-hybrid L1b).
 * A stale fact delivered verbatim is worse than no fact — retract promptly.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { retractFact, FACT_SCOPES } from '../../agent-facts/store';
import { resolveScopeRefFromCtx } from './scope-ctx';

export default defineTool({
  name: 'facts:retract',
  capability: 'coord:write',
  description:
    'Retract a standing fact by (scope, scopeRef, key) — it immediately stops folding into briefs/dossiers/orients. Soft-delete (audit trail kept 30d).',
  guidance: {
    when:
      'A previously-asserted fact is no longer true (the residue cleared, the plan unstalled, the workaround shipped). Retract PROMPTLY — facts fold verbatim, so a stale one actively misleads every future turn.',
    notWhen: 'To update/replace the conclusion — facts:assert with the same key overwrites in place.',
    chaining: 'facts:list { scope } → facts:retract { scope, scopeRef, key }.',
    seeAlso: ['facts:assert (re-assert same key = update)', 'facts:list'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z.enum(FACT_SCOPES),
    scopeRef: z.string().max(120).optional(),
    key: z.string().min(1).max(120),
  }),
  async handler(args, ctx) {
    // EI-7517: default an omitted scopeRef from the caller's context (owner = me,
    // harness = this harness, role = my role) so a fact asserted self-scoped
    // without a ref can be retracted the same way — symmetry with facts:assert.
    const scopeRef = await resolveScopeRefFromCtx(args.scope, args.scopeRef, ctx);
    const retracted = await retractFact({ scope: args.scope, scopeRef: scopeRef ?? null, key: args.key });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, retracted }) }] };
  },
});
