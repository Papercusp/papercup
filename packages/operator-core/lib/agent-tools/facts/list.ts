/**
 * facts:list — read the live standing facts for one (scope, scopeRef)
 * (queen-memory-hybrid L1b). The same deterministic read the brief/dossier/
 * orient folds use, so what you see here is exactly what agents get folded.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { listFacts, FACT_SCOPES } from '../../agent-facts/store';

export default defineTool({
  name: 'facts:list',
  capability: 'coord:read',
  description:
    'List live (unexpired, unretracted) standing facts for one scope — the exact set future briefs/dossiers/orients will fold. workspace scope takes no scopeRef.',
  guidance: {
    when:
      'Before asserting (avoid duplicates — re-assert the same key to refresh instead), when auditing what a role/harness is being told every turn, or when hunting a stale fact to retract.',
    notWhen: 'Semantic search over background knowledge — that is memory:search.',
    chaining: 'facts:list → facts:assert (refresh) / facts:retract (stale).',
    seeAlso: ['facts:assert', 'facts:retract'],
  },
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z.enum(FACT_SCOPES),
    scopeRef: z.string().max(120).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async handler(args) {
    const facts = await listFacts(
      { scope: args.scope, scopeRef: args.scopeRef ?? null },
      { limit: args.limit ?? 50 },
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: facts.length, facts }) }] };
  },
});
