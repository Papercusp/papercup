/**
 * facts:conflicts — P-011's read surface: which LIVE assumptions are in tension
 * over the same referent (unified-agent-state-plane-2026-07-27 P-011, D-087).
 *
 * A projection over `harness_shared.agent_facts`, not a third store (D-004). The
 * comparison itself is pure and lives in `agent-facts/conflicts.ts`; this file is
 * the scope resolution, the payload diet, and the honest reporting of a zero.
 *
 * ⚠ THIS TOOL DOES NOT NOTIFY ANYONE, AND THAT IS THE SPEC, not a gap. P-011's
 * done-when: *"a seeded contradiction is detected, and the false-positive rate
 * over a week of real data is measured and reported before it notifies anyone."*
 * As of 2026-07-27 the ledger holds ZERO assumptions with typed claims (D-087), so
 * that FP rate is not yet computable — hence a pull read that makes it computable,
 * and no push. Wiring this into orient/coord before the number exists would be the
 * exact ordering the item forbids.
 *
 * Cross-scope by necessity: the assumption worth knowing about is the one a PEER
 * holds against yours, so there is no `scopeRefs` narrowing (see
 * `listAssumptionFacts` for why that is the opposite of conventions:governing).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { factCitationRef, listAssumptionFacts } from '../../agent-facts/store';
import {
  detectAssumptionConflicts,
  explainZero,
  isStructuralZero,
  CONFLICT_PAIRS_LIMIT,
  type AssumptionConflict,
} from '../../agent-facts/conflicts';

/** Body excerpt width — enough to judge a pair without blowing the output budget
 *  (EI-10948: 50 pairs × 2 sides × a 1200-char body is ~120k chars). */
export const CONFLICT_BODY_EXCERPT_CHARS = 200;

/** PURE — unit-tested without PG. */
export function projectConflict(c: AssumptionConflict, full: boolean): Record<string, unknown> {
  const side = (s: AssumptionConflict['a']) => {
    const body = s.body ?? '';
    const cut = !full && body.length > CONFLICT_BODY_EXCERPT_CHARS;
    return {
      // THE shared citation grammar, never a second hand-rolled one: a
      // workspace-scoped fact carries no ref segment, so `fact:workspace::key`
      // (what an inlined template produces) does not parse and would degrade
      // every such citation to `opaque` — the near-synonym failure D-041 exists
      // to prevent. Quotable straight into `premises` / `restsOn` (D-023).
      // `id: null` (the read did not select version identity) must arrive as
      // ABSENT, not null — factCitationRef takes `id?: number` and omits the
      // `@v<N>` pin when it is missing, which is D-026's degrade-gracefully rule.
      ref: factCitationRef({ ...s, id: s.id ?? undefined }),
      by: s.createdBy,
      updatedAt: s.updatedAt,
      assertion: s.assertion,
      body: cut ? `${body.slice(0, CONFLICT_BODY_EXCERPT_CHARS)}…` : body,
      ...(cut ? { body_truncated: true, body_full_chars: body.length } : {}),
    };
  };
  return {
    referent: c.referent,
    referentKind: c.referentKind,
    // Named rather than positional: "self-contradiction" and "two agents
    // disagree" are different problems with different fixes, and the pair alone
    // does not say which one you are looking at.
    conflictKind: c.sameAuthor ? 'self-contradiction' : 'cross-agent',
    a: side(c.a),
    b: side(c.b),
  };
}

export default defineTool({
  name: 'facts:conflicts',
  capability: 'coord:read',
  description:
    "Live ASSUMPTIONS in tension, workspace-wide: pairs whose typed `claim.assertion` DIFFERS over the same `claim.subject`. Typed fields only — prose bodies are never compared. Every zero states WHICH zero it is, so an empty ledger cannot read as agreement.",
  guidance: {
    when:
      "Before you act on a contested belief — closing, shipping, escalating or reporting on an assumption a peer may hold the opposite of — and when diagnosing why two lanes reached different conclusions from the same evidence. Also the standing read for conflicting-assumption incidence.",
    notWhen:
      "Checking whether YOUR OWN assumption went stale (facts:list — `dependsStale` re-reads the cells it rests on). Semantic/prose disagreement: deliberately undetectable here, by design.",
    chaining:
      "facts:conflicts → read both sides → facts:retract the one that is wrong, or coord:send citing both refs so the peer can attack the PREMISE. Declare with facts:assert { kind:'assumption', claim:{ subject, assertion } } — an assumption with no typed claim is invisible to this read.",
    seeAlso: ['facts:assert', 'facts:list', 'conventions:governing'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Max live assumptions to scan (default 200). Pairs returned are capped at ' + CONFLICT_PAIRS_LIMIT + '; the counts stay complete.'),
    full: z
      .boolean()
      .optional()
      .describe('Return COMPLETE bodies for both sides instead of excerpts. Default false.'),
  }),
  async handler(args) {
    const limit = args.limit ?? 200;
    const facts = await listAssumptionFacts({ limit });
    const report = detectAssumptionConflicts(facts);
    // A scan that hit its own cap has NOT searched the workspace, and a conflict
    // between two rows it never loaded is a miss reported as a clean answer. Say
    // so — the same reason every zero here names itself (D-087 R4).
    const scanCapped = facts.length >= limit;
    return {
      data: {
        ok: true,
        count: report.conflicts.length,
        ...(scanCapped
          ? {
              scanCapped: true,
              scanNote: `Loaded the full ${limit}-row scan cap, so live assumptions BEYOND it were never compared — this answer is partial. Raise \`limit\` (max 500).`,
            }
          : {}),
        conflicts: report.conflicts.map((c) => projectConflict(c, args.full === true)),
        ...(report.truncated ? { truncated: true, pairsLimit: CONFLICT_PAIRS_LIMIT } : {}),
        // D-087 R4: the denominator ships with the verdict, always. `comparedPairs`
        // is the false-positive-rate base P-011's done-when asks for.
        coverage: report.coverage,
        ...(report.structuralZero
          ? {
              zeroReason: report.structuralZero,
              // The one field a caller must branch on: TRUE means nothing was
              // compared, so this is not evidence of agreement. Named for the
              // question rather than the mechanism — `structuralZero: false`
              // alongside a `zeroReason` string reads as a contradiction.
              nothingCompared: isStructuralZero(report.structuralZero),
              note: explainZero(report.structuralZero),
            }
          : {}),
      },
    };
  },
});
