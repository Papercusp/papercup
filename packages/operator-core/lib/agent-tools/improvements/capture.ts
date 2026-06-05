/**
 * improvements:capture — file a captured papercusp improvement
 * (papercusp-self-improvement-loop-2026-06-04, Phase 1 / D-001).
 *
 * The capture verb of the self-improvement loop: when an agent hits a papercusp
 * friction, this files it as a durable, claimable, topic-tagged work-unit (an
 * engineer_issue today; a work_item[kind=bug|change] after unify-work-items)
 * instead of letting the insight rot in chat. It:
 *   - auto-tags the built-in `papercusp-improvement` topic (+ an optional sub-topic),
 *   - records the `kind` (bug|change|feature) as a `[kind]` title prefix so the
 *     triage policy can tier it (bug = auto-eligible; the rest human — D-004),
 *   - does **search-first dedup** (D-001): it surfaces likely-existing items and,
 *     by default, declines to create a near-duplicate (link/comment on it instead)
 *     unless you pass `force`. Dedup here is good-search + a nudge, NOT a hard gate.
 *
 * This is a thin convenience over issues:create — same store, same fan-out — so a
 * captured improvement is a first-class issue (claim/comment/close/promote all work).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { createIssue, searchIssues, type IssueSeverity } from '../../issues-engineer';
import { IMPROVEMENT_TOPIC } from '../../harness/improvements/read-items';
import { titleSimilarity } from '../../harness/improvements/digest';

const DUP_THRESHOLD = 0.6;

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp improvement you discovered (a friction, a missing affordance, a bug in the tooling) as a durable, claimable, `papercusp-improvement`-tagged work-unit. kind=bug → auto-implement-eligible later; change|feature → human-reviewed. Search-first: declines an obvious duplicate (link to it instead) unless force.',
  guidance: {
    when: 'You hit a papercusp DX / tooling / code friction worth fixing but out of your current scope. File it here so it lands in the triage backlog instead of being lost. Use kind=bug for something broken, kind=change for a desired improvement, kind=feature for net-new (the last two stay human-gated).',
    notWhen: 'A problem in a MANAGED harness/project (not papercusp itself) — that is issues:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing question — coord:ask.',
    chaining: 'improvements:capture { kind, title } → (later) improvements:digest triages it → an agent claims + fixes it self/inline, or the auto-implement loop picks up the bugs.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    title: z.string().min(1).max(180).describe('one-line summary (do NOT include a [kind] prefix — pass kind separately)'),
    kind: z.enum(['bug', 'change', 'feature']).describe('bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated)'),
    body: z.string().max(8000).optional().describe('repro / context / the correct-state, especially for a bug'),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    subTopic: z.string().min(1).max(40).optional().describe('optional sub-area topic, e.g. coord-dx, db-tooling'),
    scope: z.string().max(80).optional().describe("'operator' (default) or 'harness:<slug>'"),
    foundDuring: z.string().max(120).optional(),
    force: z.boolean().optional().describe('file even if a likely duplicate exists (default false → search-first declines)'),
    checkDuplicatesOnly: z.boolean().optional().describe('only run the dedup search, do not create'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';

    // Search-first dedup (D-001): full-text search, then a title-similarity pass.
    const candidates = await searchIssues(args.title, 20).catch(() => []);
    const possibleDuplicates = candidates
      .map((i) => ({ id: i.id, title: i.title, state: i.state, severity: i.severity, similarity: Math.round(titleSimilarity(args.title, i.title) * 100) / 100 }))
      .filter((d) => d.similarity >= DUP_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    if (args.checkDuplicatesOnly) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, created: false, possibleDuplicates }) }] };
    }
    if (possibleDuplicates.length > 0 && !args.force) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              created: false,
              reason: 'likely-duplicate',
              possibleDuplicates,
              hint: 'This looks already filed — comment on / claim the existing item, or re-run with force:true if it is genuinely distinct.',
            }),
          },
        ],
      };
    }

    const topics = [IMPROVEMENT_TOPIC, ...(args.subTopic ? [args.subTopic] : [])];
    const issue = await createIssue({
      title: `[${args.kind}] ${args.title}`,
      body: args.body,
      severity: (args.severity as IssueSeverity | undefined) ?? (args.kind === 'bug' ? 'major' : 'minor'),
      scope: args.scope,
      topics,
      foundDuring: args.foundDuring,
      createdBy: id.ownerId,
      source,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, created: true, kind: args.kind, issue, topics, possibleDuplicates }),
        },
      ],
    };
  },
});
