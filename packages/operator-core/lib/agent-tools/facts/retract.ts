/**
 * facts:retract — soft-retract a standing fact by (scope, scopeRef, key) so it
 * stops folding into briefs/dossiers/orients (queen-memory-hybrid L1b).
 * A stale fact delivered verbatim is worse than no fact — retract promptly.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { retractFact, findFactKeyElsewhere, FACT_SCOPES } from '../../agent-facts/store';
import { resolveScopeRefFromCtx, resolveScopeRefAlias } from './scope-ctx';

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
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    key: z.string().min(1).max(120),
    reason: z.string().min(1).max(500).describe('Why this fact stopped being true — retained in the 30-day audit trail.'),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    // EI-7517: default an omitted scopeRef from the caller's context (owner = me,
    // harness = this harness, role = my role) so a fact asserted self-scoped
    // without a ref can be retracted the same way — symmetry with facts:assert.
    // EI-7371: resolve common misnamed aliases (scope_ref/ref/harness) first.
    const scopeRef = await resolveScopeRefFromCtx(args.scope, resolveScopeRefAlias(args.scope, args), ctx);
    const retracted = await retractFact({
      scope: args.scope,
      scopeRef: scopeRef ?? null,
      key: args.key,
      retractedBy: identity.ownerId,
      reason: args.reason,
    });
    if (retracted) return { data: { ok: true, retracted } };

    // EI-19328780288425209: a miss here is ambiguous — "never existed" vs "exists at a
    // DIFFERENT scope" — and the latter left a wrong fact live and believed-retracted for
    // 5h+ in the incident that reported this. Check before returning a bare false.
    const elsewhere = await findFactKeyElsewhere({
      scope: args.scope,
      scopeRef: scopeRef ?? '',
      key: args.key,
    });
    if (!elsewhere.length) return { data: { ok: true, retracted: false } };

    const first = elsewhere[0]!;
    return {
      data: {
        ok: true,
        retracted: false,
        alsoFoundAtScopes: elsewhere,
        hint:
          `key '${args.key}' exists at scope:'${first.scope}'` +
          (first.scopeRef ? ` scopeRef:'${first.scopeRef}'` : '') +
          ` (not the scope you searched) — retract there instead of concluding it's gone.`,
      },
    };
  },
});
