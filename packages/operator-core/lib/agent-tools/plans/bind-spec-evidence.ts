/** plans:bind-spec-evidence — append exact work-item/spec-revision proof bindings. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { bulkContent, runBulk } from '../_bulk';
import { resolvePlanScope } from './source';
import {
  ADHOC_WORK_ITEM_SPEC_SCOPE,
  bindSpecEvidence,
  measureRepoFilesEvidence,
  repoFilesEvidenceMeasurementSchema,
  retractSpecEvidence,
  SPEC_EVIDENCE_KINDS,
} from './spec-evidence-store';
import { SPEC_PROOF_OBLIGATION_ID_RE } from './spec-clauses-store';

const fingerprint = z.string().trim().min(1).max(256);
const proofCoverageIds = z
  .array(z.string().trim().min(1).max(200).regex(SPEC_PROOF_OBLIGATION_ID_RE))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'proof coverage ids must be unique');
const coverageRungsSchema = z
  .object({
    l1: z.boolean().optional(),
    l2: z.boolean().optional(),
    l3: z.boolean().optional(),
    l4: z.boolean().optional(),
  })
  .strict();
const adequacyBindingDetailsSchema = z
  .object({
    coverageRungs: coverageRungsSchema.optional(),
    scenarioIds: proofCoverageIds.optional(),
    causalPairIds: proofCoverageIds.optional(),
  })
  .passthrough();
// Keep the evaluator's adequacy vocabulary out of the free-form details
// namespace. `spec-test-adequacy` reads these keys only below
// `details.adequacy`; accepting them at the top level creates a successful,
// persisted binding whose metadata is silently inert.
const ADEQUACY_DETAIL_KEYS = new Set([
  'fixtureCalibrated',
  'falsifiable',
  'testLayer',
  'pathReachable',
  'oracleIndependent',
  'collected',
  'skipped',
  'executed',
  'outcome',
  'targeted',
  'coverageRungs',
  'scenarioIds',
  'causalPairIds',
  'provisionalProofBase',
]);
const bindingDetailsSchema = z.record(z.string(), z.unknown()).superRefine((details, ctx) => {
  if (details.adequacy === undefined) {
    for (const key of Object.keys(details).filter((candidate) => ADEQUACY_DETAIL_KEYS.has(candidate))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message:
          `adequacy metadata must be nested under details.adequacy.${key}; ` +
          `flat details.${key} is ignored by spec-test-adequacy`,
      });
    }
  }
  if (details.adequacy === undefined) return;
  const parsed = adequacyBindingDetailsSchema.safeParse(details.adequacy);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adequacy', ...issue.path],
      message: issue.message,
    });
  }
});
const CAUSAL_PAIR_EVIDENCE_KINDS = new Set([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);
export const bindingSchema = z
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
    sourceFingerprint: fingerprint
      .optional()
      .describe('Caller-declared fingerprint for opaque evidence. Pass this OR measurement, never both.'),
    testFingerprint: fingerprint.nullable().optional(),
    fixtureFingerprint: fingerprint.nullable().optional(),
    rubricFingerprint: fingerprint.nullable().optional(),
    environmentFingerprint: fingerprint.nullable().optional(),
    coverageEvidenceRef: z.number().int().positive().nullable().optional(),
    testRunId: z.number().int().positive().nullable().optional(),
    measurement: repoFilesEvidenceMeasurementSchema
      .optional()
      .describe(
        'Server-measured repository file sets. The binder stores the recipe and current source/test fingerprints; later reads recompute them from the canonical harness checkout.',
      ),
    details: bindingDetailsSchema.optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId (legacy coversVALs resolve through sourceValId)',
  })
  .refine((b) => Boolean(b.sourceFingerprint) !== Boolean(b.measurement), {
    message: 'pass exactly one of sourceFingerprint or measurement',
  })
  .refine((b) => !b.measurement || b.testFingerprint === undefined, {
    message: 'testFingerprint is server-computed when measurement is supplied',
  })
  .superRefine((binding, ctx) => {
    if (binding.measurement) {
      for (const field of ['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'] as const) {
        if (binding[field] == null) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            `repo-files measurement cannot independently refresh ${field}; omit it or pass null ` +
            '(record non-repository facts in details.observations without making them a freshness dimension)',
        });
      }
    }
    const adequacy = adequacyBindingDetailsSchema.safeParse(binding.details?.adequacy);
    if (
      adequacy.success &&
      adequacy.data.causalPairIds !== undefined &&
      !CAUSAL_PAIR_EVIDENCE_KINDS.has(binding.evidenceKind)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details', 'adequacy', 'causalPairIds'],
        message:
          'causalPairIds require executable test/check/coverage/operational proof or mutation/counterexample proof',
      });
    }
  });

/**
 * Withdraw one already-bound piece of evidence (decision D-011).
 *
 * Lives on THIS verb rather than a new one deliberately: retraction is the inverse of
 * binding over the same rows, the same scope resolution and the same bulk envelope, so
 * forking `plans:retract-spec-evidence` would duplicate all of it to express one flag.
 */
const retractionSchema = z.object({
  bindingId: z
    .number()
    .int()
    .positive()
    .describe(
      'The exact binding row id, from plans:get-spec-evidence. Never a (workItemId, evidenceRef) pair: changed fingerprints append history, so that pair routinely matches several rows.',
    ),
  reason: z
    .string()
    .trim()
    .min(12)
    .max(2000)
    .describe(
      'Why this proof is being withdrawn (for example: the bound run was never collected or executed). Required and stored on the row — a retraction with no stated cause is indistinguishable from evidence-shedding, which D-011 forbids.',
    ),
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
    retract: z
      .array(retractionSchema)
      .min(1)
      .max(100)
      .optional()
      .describe('Withdraw already-bound evidence instead of appending it. Mutually exclusive with binding/items.'),
  })
  .refine((args) => [args.binding, args.items, args.retract].filter(Boolean).length === 1, {
    message: 'pass exactly one of binding, items or retract',
  });

const OK = new Set(['created', 'unchanged']);

export default defineTool({
  name: 'plans:bind-spec-evidence',
  description:
    'Bind tests, fixtures, coverage-census rows, mutations/counterexamples, checks, manual proof, or operational evidence to an exact immutable spec revision and work item. Repository-backed evidence may pass measurement so the server hashes and later re-measures bounded source/test file sets; opaque evidence passes sourceFingerprint and remains caller-attested. Legacy coversVALs are accepted as sourceValId aliases. Exact replays are idempotent; changed fingerprints append history. The retract op withdraws a bound row by id with a required reason — stamped, never deleted, and excluded from default reads.',
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
    if (args.retract) {
      const retractions = await runBulk(
        args.retract,
        async (item) => {
          const result = await retractSpecEvidence({
            harnessSlug,
            bindingId: item.bindingId,
            reason: item.reason,
            actorId,
          });
          // already_retracted is a SUCCESS: the repair is idempotent, so replaying it
          // must not read as a failure. Only a binding that does not exist in this
          // scope is an error — that means the caller targeted the wrong row.
          return result.status === 'not_found'
            ? { ok: false as const, error: 'not_found' as const, ...result }
            : { ok: true as const, ...result };
        },
        { keyOf: (item) => ({ bindingId: item.bindingId }) },
      );
      return bulkContent(retractions);
    }
    const bindings = args.items ?? [args.binding!];
    const measurementScope = bindings.some((binding) => binding.measurement)
      ? await resolvePlanScope({ harnessSlug })
      : null;
    // P-022 / D-018: report the scope the binding ACTUALLY landed in, not the argument the
    // caller passed. An omitted `slug` resolves to the ad-hoc scope inside the store, and a
    // result echoing `slug: undefined` would hide which scope now owns the evidence.
    const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
    const env = await runBulk(
      bindings,
      async (binding) => {
        const measured = binding.measurement
          ? await measureRepoFilesEvidence(measurementScope!.workspaceId, harnessSlug, binding.measurement)
          : null;
        const { measurement, ...declared } = binding;
        const result = await bindSpecEvidence({
          ...declared,
          sourceFingerprint: measured?.sourceFingerprint ?? binding.sourceFingerprint!,
          ...(measured ? { testFingerprint: measured.testFingerprint } : {}),
          ...(measurement
            ? {
                details: {
                  ...(binding.details ?? {}),
                  currentMeasurement: measurement,
                },
              }
            : {}),
          ...(args.slug ? { planSlug: args.slug } : {}),
          harnessSlug,
          actorId,
        });
        return OK.has(result.status)
          ? { ok: true as const, slug: reportedSlug, ...result }
          : { ok: false as const, slug: reportedSlug, error: result.status, ...result };
      },
      {
        keyOf: (binding) => ({ slug: reportedSlug, workItemId: binding.workItemId, evidenceRef: binding.evidenceRef }),
      },
    );
    return bulkContent(env);
  },
});
