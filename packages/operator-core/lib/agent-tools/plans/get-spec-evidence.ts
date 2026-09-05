/** plans:get-spec-evidence — exact proof bindings with explicit currentness. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecEvidence, SPEC_EVIDENCE_KINDS, evidenceCurrentInputSchema } from './spec-evidence-store';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  sourceValIds: z
    .array(z.string().regex(/^VAL-[A-Za-z0-9._-]+$/))
    .min(1)
    .max(500)
    .optional(),
  evidenceKinds: z.array(z.enum(SPEC_EVIDENCE_KINDS)).min(1).max(SPEC_EVIDENCE_KINDS.length).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  current: z
    .array(evidenceCurrentInputSchema)
    .max(500)
    .optional()
    .describe(
      'Current fingerprints keyed by evidenceKind+evidenceRef. Missing applicable values return unknown, never current.',
    ),
  currentness: z
    .array(z.enum(['current', 'stale', 'unknown']))
    .min(1)
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export default defineTool({
  name: 'plans:get-spec-evidence',
  description:
    'Read exact work-item/spec-revision evidence and compute per-dimension current|stale|unknown|not-applicable status. Spec currentness comes from the canonical revision pointer; source/test/fixture/rubric/environment values compare with explicit current fingerprints, and missing inputs remain unknown.',
  guidance: {
    when: 'Auditing whether each current plan spec has fresh evidence, including legacy VAL aliases and historical bindings.',
    notWhen: 'Writing evidence — plans:bind-spec-evidence. Reading behavior without proof — plans:get-specs.',
    chaining: 'plans:bind-spec-evidence → plans:get-spec-evidence { current:[…] } → completion/acceptance gate.',
    seeAlso: ['plans:bind-spec-evidence (append proof)', 'plans:get-specs (canonical behavior)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // EI-21841626363210048: the judge role's grading-integrity audit is mandated to
  // "execute each evidence probe exactly as written" for a spec-test-adequacy card —
  // this read-only tool IS that probe (named by spec-test-adequacy's own method text
  // and by its `freshness` method). Without it the auditor was structurally blocked
  // from the one re-run its own rubric prescribes and had to substitute weaker
  // corroboration with no signal in the emitted card.
  agentRoles: [...SU_ROLES, 'kettle', 'worker', 'cup', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const evidence = await listSpecEvidence({ ...args, planSlugs: [args.slug], harnessSlug });
    const counts = { current: 0, stale: 0, unknown: 0 };
    for (const row of evidence) counts[row.currentness.overall] += 1;
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        evidence,
        count: evidence.length,
        currentness: counts,
      },
    };
  },
});
