/**
 * improvements:capture — file a captured papercusp improvement
 * (papercusp-self-improvement-loop-2026-06-04, Phase 1 / D-001;
 * close-the-self-improvement-loop-2026-06-05 D-002).
 *
 * The capture verb of the self-improvement loop: when an agent hits a papercusp
 * friction, this files it as a durable, claimable, topic-tagged work-unit (an
 * engineer_issue = work_item[kind ∈ bug|change]) instead of letting the insight
 * rot in chat. A THIN wrapper over the shared `captureImprovement` core
 * (capture-core.ts) — the watchdog's event-driven captures use the same core, so
 * the semantics (search-first dedup, native kind column, payload paths,
 * auto-tagging) live in exactly one place.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import type { IssueSeverity } from '../../issues-engineer';
import { captureImprovement } from '../../harness/improvements/capture-core';

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp improvement you discovered (a friction, a missing affordance, a bug in the tooling) as a durable, claimable, `papercusp-improvement`-tagged work-unit. kind=bug → auto-implement-eligible later; change|feature → human-reviewed. Search-first: declines an obvious duplicate (link to it instead) unless force. Pass `paths` when you know the files involved — it feeds the protected-path safety gate.',
  guidance: {
    when: 'You hit a papercusp DX / tooling / code friction worth fixing but out of your current scope. File it here so it lands in the triage backlog instead of being lost. Use kind=bug for something broken, kind=change for a desired improvement, kind=feature for net-new (the last two stay human-gated). Include `paths` (repo-relative files involved) when known — the auto-implement risk gate reads them.',
    notWhen: 'A problem in a MANAGED harness/project (not papercusp itself) — that is issues:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing question — coord:ask.',
    chaining: 'improvements:capture { kind, title, paths? } → (later) improvements:digest triages it → an agent claims + fixes it self/inline, or the auto-implement loop picks up the bugs and improvements:resolve closes them.',
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
    paths: z.array(z.string().min(1).max(300)).max(20).optional().describe('repo-relative file paths the improvement touches, when known — feeds the protected-path gate'),
    force: z.boolean().optional().describe('file even if a likely duplicate exists (default false → search-first declines)'),
    checkDuplicatesOnly: z.boolean().optional().describe('only run the dedup search, do not create'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    const result = await captureImprovement({
      title: args.title,
      kind: args.kind,
      body: args.body,
      severity: args.severity as IssueSeverity | undefined,
      subTopic: args.subTopic,
      scope: args.scope,
      foundDuring: args.foundDuring,
      paths: args.paths,
      force: args.force,
      checkDuplicatesOnly: args.checkDuplicatesOnly,
      createdBy: id.ownerId,
      source,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
