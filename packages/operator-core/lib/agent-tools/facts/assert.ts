/**
 * facts:assert — upsert a standing fact: a deterministic, scoped, TTL'd
 * CONCLUSION that will be folded VERBATIM into every relevant future brief /
 * dossier / orient until it expires or is retracted
 * (queen-memory-hybrid-2026-07-02 L1b; D-001: harness/work_item scopes optional).
 *
 * THE LINE vs the other memory surfaces (put facts HERE, not there):
 *   facts  = deterministic delivery of a scoped conclusion ("WI-1439 is
 *            owner-residue — exclude from frontier").
 *   mem0   = fuzzy semantic background (may or may not surface).
 *   coord  = ephemeral status. checkpoint = task progress. insights doc =
 *            long-form how-it-works.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { assertFact, resolveFactScopeRef, FACT_SCOPES, FACT_BODY_MAX_CHARS } from '../../agent-facts/store';
import { resolveScopeRefAlias } from './scope-ctx';

export default defineTool({
  name: 'facts:assert',
  capability: 'coord:write',
  description:
    'Assert (upsert by key) a STANDING FACT — a durable, scoped conclusion folded VERBATIM into every relevant future brief/dossier/orient until it expires (default TTL 7d) or is retracted. Unlike memory:remember (fuzzy semantic recall), a fact is delivered deterministically. Re-asserting the same key refreshes body + TTL.',
  guidance: {
    when:
      'You reached a durable CONCLUSION that should shape future turns — yours or your role\'s: "X is owner-residue, exclude it", "plan Y stalls on Z", "this harness\'s tests need Docker". Scope it as narrowly as true: workspace (global), role (all queens/bees/…), owner (just you), harness, or work_item.',
    notWhen:
      'Ephemeral status (use coord), in-flight task progress (work_items:checkpoint), long-form knowledge (agent-insights doc), fuzzy background worth semantic recall (memory:remember). Not a dumping ground — 500-char cap, per-scope cap 50, TTL mandatory.',
    chaining:
      'facts:list { scope } to see what already stands (re-assert refreshes rather than duplicating); facts:retract when a fact stops being true — a stale fact folded verbatim is worse than none.',
    seeAlso: ['facts:retract', 'facts:list', 'memory:remember (fuzzy background instead)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z.enum(FACT_SCOPES).describe('workspace (global, no ref) | role | owner | harness | work_item'),
    scopeRef: z.string().max(120).optional().describe('Required for every scope except workspace: role name / ownerId / harness slug / WI id.'),
    key: z.string().min(1).max(120).describe('Stable slug — upsert + retract target (e.g. "wi-1439-owner-residue").'),
    // Transport ceiling 4000 ≫ the stored cap: the store TRUNCATES to FACT_BODY_MAX_CHARS
    // (code-run-self-state-adoption-2026-07-03 P-007 — the hard zod reject cost the WHOLE
    // write 7×/14d; truncate-not-reject preserves the fact, '…' makes it visible).
    body: z.string().min(1).max(4000).describe(`The conclusion — stored truncated to ${FACT_BODY_MAX_CHARS} chars (write tight conclusions, not documents).`),
    sourceRef: z.string().max(200).optional().describe('Anchor that proved it (WI-/EI- id, plan slug) so readers can verify.'),
    ttlSec: z.number().int().positive().max(90 * 24 * 3600).optional().describe('TTL seconds (default 7d, max 90d).'),
    shareable: z.boolean().optional().describe('OPT-IN federation egress (F0-2): true = this fact may leave the hive over the substrate. Default false — facts are hive-private.'),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    // EI-7517: default an OMITTED scopeRef from the caller's context for the
    // self-scoped cases (owner = me, harness = this harness, role = my role), so
    // the common "assert a fact about just myself" doesn't error on a missing
    // ref the tool can infer. An explicit scopeRef always wins.
    const scopeRef = resolveFactScopeRef(args.scope, args.scopeRef, {
      ownerId: identity.ownerId,
      harnessSlug: ctx.harnessSlug,
      role: deriveAgentRole(identity),
    });
    // F1-1 federation identity: a SHAREABLE fact must carry the hive-home slug
    // (mig 461 harness_slug) or the capture routes nowhere and peers reject the
    // wire row. Resolved only when federating (a registry read per assert is
    // not worth paying for hive-private facts).
    const hiveHomeSlug =
      args.shareable === true
        ? await (await import('../../agent-facts/store')).resolveFactFederationSlug(ctx.harnessSlug)
        : null;
    const fact = await assertFact({
      scope: args.scope,
      scopeRef: scopeRef ?? null,
      key: args.key,
      body: args.body,
      sourceRef: args.sourceRef ?? null,
      ttlSec: args.ttlSec,
      createdBy: identity.ownerId,
      ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
      ...(hiveHomeSlug ? { hiveHomeSlug } : {}),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, fact }) }] };
  },
});
