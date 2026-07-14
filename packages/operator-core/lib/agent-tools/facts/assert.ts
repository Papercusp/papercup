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
import { assertFact, resolveFactScopeRef, FACT_SCOPES, FACT_BODY_MAX_CHARS, type FactSourceProvenance } from '../../agent-facts/store';
import { resolveScopeRefAlias } from './scope-ctx';
import { carryProvenanceFields } from '../../carry-surface-provenance-stamp';

/**
 * EI-10952: the disclosure for a truncated body. Returns undefined on the clean
 * case (no field on the response) — same warn-only shape as provenanceLint.
 *
 * PURE (unit-tested without PG): compares what the caller SENT against what the
 * store actually PERSISTED, so it reports the real stored/dropped counts rather
 * than re-deriving the clamp and hoping the two agree.
 */
export function truncationField(
  rawBody: string,
  storedBody: string,
): { storedChars: number; droppedChars: number; note: string } | undefined {
  const raw = rawBody.trim();
  if (raw.length <= storedBody.length) return undefined;
  return {
    storedChars: storedBody.length,
    droppedChars: raw.length - storedBody.length,
    note:
      `TRUNCATED to the ${FACT_BODY_MAX_CHARS}-char cap — the write was KEPT (a fact is never lost to a length ` +
      `error), but ${raw.length - storedBody.length} chars were dropped and the stored body now ends mid-sentence ` +
      `with '…'. This matters more than a normal clip: facts fold VERBATIM into every future orient as BINDING ` +
      `context, so a truncated fact reads as a complete instruction that stops halfway. Re-assert the SAME key with ` +
      `a tighter conclusion (facts are conclusions, not documents) and put the detail on the work-item / insight ` +
      `the fact points at.`,
  };
}

/**
 * P-015 (deterministic-context-carry) — the DEAD-END fact slot. A tried-and-
 * failed approach recorded as ordinary prose ("the FS-watch route didn't work")
 * reads as narrative and gets re-tried by successors; typed as a dead-end slot
 * it is machine-greppable (key LIKE 'dead-end:%') and renders unmistakably in
 * every fold. Deliberately encoded in the key + body (no schema change): every
 * existing delivery surface (orient/brief/dossier fact folds) renders it
 * correctly with zero renderer changes.
 */
export const DEAD_END_KEY_PREFIX = 'dead-end:';
export const DEAD_END_BODY_PREFIX = '⛔ DEAD END — do not retry: ';

/** PURE: normalize a slot:'dead-end' assert's key/body onto the slot encoding.
 *  Idempotent — an already-prefixed key/body is left alone (a re-assert of the
 *  same fact must hit the same upsert key and not stack markers). */
export function normalizeDeadEndSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(DEAD_END_KEY_PREFIX) ? key : `${DEAD_END_KEY_PREFIX}${key}`;
  const b = body.startsWith(DEAD_END_BODY_PREFIX) ? body : `${DEAD_END_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

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
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef; accepted so a snake_case call still resolves the ref instead of silently dropping it.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    key: z.string().min(1).max(120).describe('Stable slug — upsert + retract target (e.g. "wi-1439-owner-residue").'),
    // Transport ceiling 4000 ≫ the stored cap: the store TRUNCATES to FACT_BODY_MAX_CHARS
    // (code-run-self-state-adoption-2026-07-03 P-007 — the hard zod reject cost the WHOLE
    // write 7×/14d; truncate-not-reject preserves the fact, '…' makes it visible).
    body: z.string().min(1).max(4000).describe(`The conclusion — stored truncated to ${FACT_BODY_MAX_CHARS} chars (write tight conclusions, not documents).`),
    sourceRef: z.string().max(200).optional().describe('Anchor that proved it. A TYPED ref — msg:<id>, wi:<id>/WI-/EI- id, or "owner-turn" (the human turn you are answering) — is PLATFORM-VERIFIED at assert time and folds with the verified verbatim quote; anything else (plan slug, prose) stays a plain anchor.'),
    slot: z.enum(['dead-end']).optional().describe("Typed slot (P-015). 'dead-end' = a tried-and-failed approach, recorded so successors never re-try it: the key is normalized under 'dead-end:' and the body rendered with the ⛔ DEAD END marker in every future fold. State the approach AND why it failed; pair with sourceRef to anchor the evidence."),
    audienceScope: z.string().max(160).optional().describe('Restrict WHO receives this fact in folds (v1 grammar: "fleet:<slug>") — it then folds ONLY into orients of that fleet\'s members. Omit = every reader of the scope. Orthogonal to `scope` (what the fact is about). facts:list still shows it to everyone (delivery relevance, not secrecy).'),
    ttlSec: z.number().int().positive().max(90 * 24 * 3600).optional().describe('TTL seconds (default 7d, max 90d).'),
    shareable: z.boolean().optional().describe('OPT-IN federation egress (F0-2): true = this fact may leave the pot over the substrate. Default false — facts are pot-private.'),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    // EI-7517: default an OMITTED scopeRef from the caller's context for the
    // self-scoped cases (owner = me, harness = this harness, role = my role), so
    // the common "assert a fact about just myself" doesn't error on a missing
    // ref the tool can infer. An explicit scopeRef always wins.
    const aliasedScopeRef = resolveScopeRefAlias(args.scope, args);
    const scopeRef = resolveFactScopeRef(args.scope, aliasedScopeRef, {
      ownerId: identity.ownerId,
      harnessSlug: ctx.harnessSlug,
      role: deriveAgentRole(identity),
    });
    // F1-1 federation identity: a SHAREABLE fact must carry the hive-home slug
    // (mig 461 harness_slug) or the capture routes nowhere and peers reject the
    // wire row. Resolved only when federating (a registry read per assert is
    // not worth paying for hive-private facts).
    const potHomeSlug =
      args.shareable === true
        ? await (await import('../../agent-facts/store')).resolveFactFederationSlug(ctx.harnessSlug)
        : null;
    // P-007: a TYPED sourceRef (msg:/wi:/owner-turn) is platform-verified at
    // assert time — the stamp travels with the fact and folds render the
    // verified quote with zero extra reads. Fail-soft: stamping never blocks
    // the assert (the resolver degrades internally; this catch is the belt).
    let sourceProvenance: FactSourceProvenance | null = null;
    if (args.sourceRef) {
      try {
        const { resolveFactSourceProvenance } = await import('./source-provenance-resolve');
        sourceProvenance = await resolveFactSourceProvenance(identity, args.sourceRef);
      } catch {
        sourceProvenance = null;
      }
    }
    // P-015 dead-end slot: normalize key/body onto the slot encoding (idempotent).
    const slotted =
      args.slot === 'dead-end' ? normalizeDeadEndSlot(args.key, args.body) : { key: args.key, body: args.body };
    const fact = await assertFact({
      scope: args.scope,
      scopeRef: scopeRef ?? null,
      key: slotted.key,
      body: slotted.body,
      sourceRef: args.sourceRef ?? null,
      audienceScope: args.audienceScope ?? null,
      sourceProvenance,
      ttlSec: args.ttlSec,
      createdBy: identity.ownerId,
      ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
      ...(potHomeSlug ? { potHomeSlug } : {}),
    });
    // WI-3801 lint + P-014 turn-ref verification/origin stamp — warn-only,
    // no fields on the common clean case.
    const provenanceFields = await carryProvenanceFields(slotted.body, identity.ownerId);
    // EI-10952: a body over the cap is TRUNCATED, not rejected (P-007 — the hard
    // reject cost 7 whole facts in 14d, so truncate-not-reject stays). But the
    // caller was never TOLD: the response was a clean `ok:true` and the fact
    // shipped cut mid-sentence. Facts fold VERBATIM into every future orient and
    // are BINDING context, so a silently-truncated fact is not a clipped note —
    // it is a mid-sentence INSTRUCTION presented as complete, to every future
    // agent, until someone retracts it. Keep the write; stop calling it clean.
    const truncation = truncationField(slotted.body, fact.body);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            fact,
            ...(truncation ? { truncated: truncation } : {}),
            ...provenanceFields,
          }),
        },
      ],
    };
  },
});
