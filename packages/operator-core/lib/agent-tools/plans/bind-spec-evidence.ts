/** plans:bind-spec-evidence — append exact work-item/spec-revision proof bindings. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { bulkContent, runBulk } from '../_bulk';
import { ADHOC_WORK_ITEM_SPEC_SCOPE, bindSpecEvidence, SPEC_EVIDENCE_KINDS } from './spec-evidence-store';

const fingerprint = z.string().trim().min(1).max(256);
const bindingSchema = z
  .object({
    workItemId: z.string().trim().min(1).max(200),
    specId: z.string().trim().min(1).max(200).optional(),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .optional(),
    specRevision: z.number().int().positive().optional(),
    evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
    evidenceRef: z.string().trim().min(1).max(2000),
    sourceFingerprint: fingerprint,
    testFingerprint: fingerprint.nullable().optional(),
    fixtureFingerprint: fingerprint.nullable().optional(),
    rubricFingerprint: fingerprint.nullable().optional(),
    environmentFingerprint: fingerprint.nullable().optional(),
    coverageEvidenceRef: z.number().int().positive().nullable().optional(),
    testRunId: z.number().int().positive().nullable().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId (legacy coversVALs resolve through sourceValId)',
  });

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan owning the referenced spec revisions. Omit for an ad-hoc work-item that belongs to no plan; ' +
          'its clauses are scoped to the harness-wide ad-hoc spec scope instead.',
      ),
    binding: bindingSchema.optional().describe('Single-binding shorthand (n=1 of items).'),
    items: z.array(bindingSchema).min(1).max(500).optional(),
  })
  .refine((args) => Boolean(args.binding) !== Boolean(args.items), {
    message: 'pass exactly one of binding or items',
  });

const OK = new Set(['created', 'unchanged']);

export default defineTool({
  name: 'plans:bind-spec-evidence',
  description:
    'Bind tests, fixtures, coverage-census rows, mutations/counterexamples, checks, manual proof, or operational evidence to an exact immutable spec revision and work item. Legacy coversVALs are accepted as sourceValId aliases. Exact replays are idempotent; changed fingerprints append history.',
  guidance: {
    when: 'Recording execution proof for one or more plan specs before work-item completion or plan acceptance.',
    notWhen: 'Authoring behavior — plans:set-specs. Running a test — testing:run.',
    chaining: 'plans:get-specs → plans:bind-spec-evidence → plans:get-spec-evidence with current fingerprints.',
    seeAlso: ['plans:get-spec-evidence (inspect proof/currentness)', 'plans:get-specs (resolve exact revisions)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const actorId = resolveAgentIdentity(ctx).ownerId;
    const bindings = args.items ?? [args.binding!];
    // P-022 / D-018: report the scope the binding ACTUALLY landed in, not the argument the
    // caller passed. An omitted `slug` resolves to the ad-hoc scope inside the store, and a
    // result echoing `slug: undefined` would hide which scope now owns the evidence.
    const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
    const env = await runBulk(
      bindings,
      async (binding) => {
        const result = await bindSpecEvidence({
          ...binding,
          ...(args.slug ? { planSlug: args.slug } : {}),
          harnessSlug,
          actorId,
        });
        return OK.has(result.status)
          ? { ok: true as const, slug: reportedSlug, ...result }
          : { ok: false as const, slug: reportedSlug, error: result.status, ...result };
      },
      { keyOf: (binding) => ({ slug: reportedSlug, workItemId: binding.workItemId, evidenceRef: binding.evidenceRef }) },
    );
    return bulkContent(env);
  },
});
