/**
 * facts:list — read the live standing facts for one (scope, scopeRef)
 * (queen-memory-hybrid L1b). The same deterministic read the brief/dossier/
 * orient folds use, so what you see here is exactly what agents get folded.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { listFacts, FACT_SCOPES, type AgentFact } from '../../agent-facts/store';
import { resolveScopeRefFromCtx, resolveScopeRefAlias } from './scope-ctx';
import { markStaleSourceFacts, type FactSourceStaleness } from './stale-source';

/** EI-10948: was 50 × (500-char body + a 160-char provenance quote) ≈ 56k chars. */
export const FACTS_LIST_DEFAULT_LIMIT = 25;
/** Excerpt width — enough to identify a fact + decide whether to retract it. */
export const FACTS_LIST_EXCERPT_CHARS = 180;
export const FACTS_LIST_EXCERPT_NOTE =
  'Bodies are EXCERPTED (see body_truncated / body_full_chars). Pass full:true — ideally with a tighter limit — for verbatim bodies.';

/**
 * Project one fact for the list response: excerpt the body (and drop the bounded
 * provenance quote, which duplicates it) unless `full`. PURE — unit-tested without PG.
 */
export function projectFact(
  f: AgentFact & { sourceStale?: FactSourceStaleness },
  full: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    scope: f.scope,
    ref: f.scopeRef,
    key: f.key,
    sourceRef: f.sourceRef,
    createdBy: f.createdBy,
    updatedAt: f.updatedAt,
    expiresAt: f.expiresAt,
    ...(f.audienceScope ? { audienceScope: f.audienceScope } : {}),
    // The staleness flag is NEVER excerpted away — it is the reason to read the list.
    ...(f.sourceStale ? { stale: f.sourceStale } : {}),
  };
  if (full) return { ...base, body: f.body, sourceProvenance: f.sourceProvenance };
  const body = f.body ?? '';
  const cut = body.length > FACTS_LIST_EXCERPT_CHARS;
  return {
    ...base,
    body: cut ? `${body.slice(0, FACTS_LIST_EXCERPT_CHARS)}…` : body,
    ...(cut ? { body_truncated: true, body_full_chars: body.length } : {}),
  };
}

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
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z.enum(FACT_SCOPES),
    scopeRef: z.string().max(120).optional(),
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    limit: z.number().int().positive().max(100).optional().describe(`Max facts (default ${FACTS_LIST_DEFAULT_LIMIT}).`),
    full: z
      .boolean()
      .optional()
      .describe(
        'Return COMPLETE fact bodies instead of excerpts. Default false — bodies are excerpted (with body_truncated + body_full_chars) so a busy scope cannot blow the tool-output budget (EI-10948). Use when you need a fact verbatim, ideally with a tighter `limit`.',
      ),
  }),
  async handler(args, ctx) {
    // EI-7517: default an omitted scopeRef from the caller's context (owner = me,
    // harness = this harness, role = my role) so `facts:list { scope: 'owner' }`
    // lists YOUR facts without having to pass your own id — symmetry with assert.
    // EI-7371: resolve common misnamed aliases (scope_ref/ref/harness) first.
    const scopeRef = await resolveScopeRefFromCtx(args.scope, resolveScopeRefAlias(args.scope, args), ctx);
    const facts = await listFacts(
      { scope: args.scope, scopeRef: scopeRef ?? null },
      { limit: args.limit ?? FACTS_LIST_DEFAULT_LIMIT },
    );
    // EI-10947: flag facts whose source work-item has CLOSED — facts:list is where an
    // agent goes "hunting a stale fact to retract" (see guidance), so this is exactly
    // where the answer belongs. Fail-soft: unmarked on any lookup error.
    const marked = await markStaleSourceFacts(facts);
    // EI-10948: bodies are up to 500 chars and the default limit was 50, so a busy
    // harness returned ~56k chars — over the tool-output budget, a HARD error, spilled
    // to a file. The irony that hurt: the one read that shows you your stale facts was
    // the one that blew up. Excerpt by default, exactly as work_items:list already does.
    const rows = marked.map((f) => projectFact(f, args.full === true));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rows.length,
            ...(args.full !== true ? { excerpted: true, note: FACTS_LIST_EXCERPT_NOTE } : {}),
            facts: rows,
          }),
        },
      ],
    };
  },
});
