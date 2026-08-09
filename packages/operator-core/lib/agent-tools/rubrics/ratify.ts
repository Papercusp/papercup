/**
 * rubrics:ratify — ratify one OR many proposed rubrics → status "active"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21). An active rubric is the shared
 * definition EVERY agent grades against, so the bar is higher than a one-off observation.
 *
 * D-001 GATE: the ratifying authority is the QUEEN/owner (fully autonomous — not a human
 * sign-off). v1 enforces this softly: the queen role is in COORD_ROLES, and superuser
 * callers bypass the role gate (so the owner/su can seed). Hardening the gate to
 * queen-only (via the autonomy policy) is a v2 follow-up; the intent is documented here.
 *
 * Bulk by default (the house keyed-array contract): ratify ONE inline ({ rubricRef
 * }), MANY (rubricRefs:[…]) → { ok, results:[{ ok, rubricId, rubric? | error }],
 * counts }. Each result self-describes its rubricId; one not-found id never fails
 * the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { ratifyRubric, rubricCompleteness } from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'rubrics:ratify',
  profile: 'engineer',
  description:
    'Ratify one OR many proposed rubrics → status "active" (D-001: the Mug/owner gate — an active rubric becomes the shared definition every agent grades against). Single: { rubricRef }. Many: { rubricRefs:[…] }. Returns { ok, results:[{ ok, rubricId, rubric?, completeness?, replicationSqlCheck? | error }], counts } — correlate by rubricId, not by position; a not-found ref never fails the rest. Each result reports testing-procedure `completeness` (criteria lacking their own replication drill + whether the rubric-level methodRef is set) and `replicationSqlCheck` (drill SQL that fails against live PG — read its `summary`; `findings` is REAL defects only) — the owner shape is one procedure per aspect PLUS one main methodRef; review the gaps before ratifying.',
  guidance: {
    when: 'You are the Mug/owner reviewing proposed rubric(s) and judge them sound shared standards. Activating one makes every agent grade structured observations against it. Ratify several at once via rubricRefs:[…].',
    notWhen: 'Authoring or revising content — rubrics:propose. You are not the ratifying authority — leave it proposed and flag the Mug.',
    chaining: 'rubrics:list { status: "proposed" } → rubrics:get → rubrics:ratify { rubricRefs:[…] }. Bulk: single | rubricRefs[] → { ok, results, counts }; correlate by rubricId not position; one failure never fails the rest.',
    seeAlso: [
      'rubrics:propose (author or revise content, not activate)',
      'rubrics:list { status:"proposed" } (find rubrics awaiting ratification)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricRef: z.string().min(1).optional().describe('single-ratify shorthand: the rubric ref/slug to activate'),
      rubricRefs: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric refs/slugs to activate (1–100)'),
    })
    .refine((a) => Boolean(a.rubricRef) || (a.rubricRefs?.length ?? 0) > 0, {
      message: 'pass `rubricRef` (one) or `rubricRefs` (many)',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.rubricRef, args.rubricRefs);
    const env = await runBulk(
      ids,
      async (rubricId) => {
        const rubric = await ratifyRubric(rubricId, id.ownerId);
        if (!rubric) {
          return { ok: false as const, rubricId, error: 'rubric not found' };
        }
        // WI-4287: report testing-procedure completeness at the ratification gate —
        // criteria lacking their own replication drill + a missing rubric methodRef
        // stay visible on every activation instead of being tribal knowledge.
        const completeness = rubricCompleteness(rubric);
        // EI-10514: schema-validate embedded replication-drill SQL against live PG at the
        // highest-stakes gate (ratifying makes it THE shared standard) — non-blocking.
        const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
        // Push-on-write (push-audit 2026-07-26): ratification flips governance
        // state the Rubrics pane + readiness strip both display.
        void import('../../sync-sse')
          .then((m) => {
            m.notifySyncInvalidate('rubrics.list');
            m.notifySyncInvalidate('rubrics.trend');
            m.notifySyncInvalidate('learning.releaseReadiness');
          })
          .catch(() => {});
        return { ok: true as const, rubricId, rubric, completeness, replicationSqlCheck };
      },
      { keyOf: (rubricId) => ({ rubricId }) },
    );
    return bulkContent(env);
  },
});
