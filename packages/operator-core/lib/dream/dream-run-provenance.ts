/** Versioned capability provenance inside the existing dream_runs.outcome JSON. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CapabilityManifestSchema, capabilityHash, type CapabilityManifest } from './capability-contracts';
import { validateCapabilityDreamSelection } from './capability-pass';
import { CAPABILITY_SAMPLING_VERSION, type CapabilitySamplingResult } from './capability-sampler';

export const DREAM_CAPABILITY_RUN_VERSION = 'dream-capability-run-v1';
const name = z.string().trim().min(1).max(200);
const usd = z.number().finite().nonnegative();
export const DreamCallUsageSchema = z
  .object({
    model: name,
    costUsd: usd,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export const DREAM_CALL_PHASES = [
  'packet',
  'retrieval',
  'rerank',
  'generation',
  'control-a',
  'control-b',
  'review',
  'experiment',
] as const;
const CallSchema = z
  .object({
    callId: name,
    phase: z.enum(DREAM_CALL_PHASES),
    model: name,
    reservedUsd: usd,
    status: z.enum(['reserved', 'settled', 'unknown']),
    usage: DreamCallUsageSchema.nullable(),
    error: z.string().max(4_000).nullable(),
  })
  .strict()
  .superRefine((call, ctx) => {
    if ((call.status === 'settled') !== (call.usage !== null) || (call.usage && call.usage.model !== call.model))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Call status/model does not match usage' });
  });
export type DreamRunCall = z.infer<typeof CallSchema>;
const HeaderSchema = z
  .object({
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifestRevision: name,
    dreamerModel: name,
    reviewerModel: name,
    dreamPromptVersion: name,
    reviewPromptVersion: name,
    evaluation: z
      .object({
        protocolPin: z.string().regex(/^[a-f0-9]{64}$/),
        arm: z.enum(['uniform-pair', 'structured-pair', 'structured-triple']),
        matchedPairIndex: z.number().int().min(0).max(49).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const EnvelopeSchema = HeaderSchema.extend({
  schemaVersion: z.literal(DREAM_CAPABILITY_RUN_VERSION),
  sampling: z.unknown().nullable(),
  calls: z.array(CallSchema).max(64),
  artifactId: z
    .string()
    .regex(/^EI-\d+$/)
    .nullable()
    .default(null),
}).strict();
export interface DreamCapabilityRun extends z.infer<typeof HeaderSchema> {
  schemaVersion: typeof DREAM_CAPABILITY_RUN_VERSION;
  sampling: CapabilitySamplingResult | null;
  calls: DreamRunCall[];
  artifactId: string | null;
}
export interface BeginCapabilityRunInput {
  manifest: CapabilityManifest;
  dreamerModel: string;
  reviewerModel: string;
  dreamPromptVersion: string;
  reviewPromptVersion: string;
  evaluation?: z.infer<typeof HeaderSchema>['evaluation'];
}

export function newDreamCapabilityRun(input: BeginCapabilityRunInput): DreamCapabilityRun {
  const { manifest, ...versions } = input;
  const parsed = CapabilityManifestSchema.parse(manifest);
  const header = HeaderSchema.parse({
    ...versions,
    manifestHash: capabilityHash(JSON.stringify(parsed)),
    manifestRevision: parsed.revision,
  });
  if (header.dreamerModel.toLowerCase() === header.reviewerModel.toLowerCase())
    throw new Error('Dream reviewer must use a different model');
  return { ...header, schemaVersion: DREAM_CAPABILITY_RUN_VERSION, sampling: null, calls: [], artifactId: null };
}

export function validateDreamSampling(value: CapabilitySamplingResult): void {
  if (!value || !['selected', 'no-pair'].includes(value.status)) throw new Error('Invalid persisted sampling result');
  const log = value.log;
  if (
    !log ||
    log.version !== CAPABILITY_SAMPLING_VERSION ||
    !log.seed?.trim() ||
    !log.promptVersion?.trim() ||
    !/^[a-f0-9]{64}$/.test(log.snapshotFingerprint) ||
    !/^[a-f0-9]{64}$/.test(log.inputFingerprint) ||
    !Number.isFinite(log.pathProbability) ||
    log.pathProbability < 0 ||
    log.pathProbability > 1 ||
    !Array.isArray(log.draws) ||
    log.draws.some((d) => !Number.isFinite(d.probability) || d.probability <= 0 || d.probability > 1)
  )
    throw new Error('Invalid persisted sampling provenance');
  if (
    log.eligibleUnitIds !== undefined &&
    (!Array.isArray(log.eligibleUnitIds) ||
      log.eligibleUnitIds.length > 200 ||
      new Set(log.eligibleUnitIds).size !== log.eligibleUnitIds.length ||
      log.eligibleUnitIds.some((id) => typeof id !== 'string' || !id.trim()))
  )
    throw new Error('Invalid persisted sampling population');
  if (
    value.status === 'selected' &&
    log.eligibleUnitIds !== undefined &&
    [value.selection.a, value.selection.b, ...(value.selection.c ? [value.selection.c.entry] : [])].some(
      (e) => !log.eligibleUnitIds!.includes(e.packet.unit.id),
    )
  )
    throw new Error('Selected unit is outside recorded sampling population');
  if (value.status === 'selected') validateCapabilityDreamSelection(value.selection);
  else if (!['insufficient-units', 'no-eligible-pair', 'no-third-candidate'].includes(value.reason))
    throw new Error('Invalid no-pair reason');
}

/** Legacy rows have no envelope; an unknown/corrupt new envelope fails explicitly. */
export function dreamCapabilityRun(run: { outcome: Record<string, unknown> | null }): DreamCapabilityRun | null {
  if (!run.outcome || !Object.hasOwn(run.outcome, 'capabilityRun')) return null;
  const value = EnvelopeSchema.parse(run.outcome.capabilityRun);
  if (new Set(value.calls.map((c) => c.callId)).size !== value.calls.length)
    throw new Error('Duplicate paid call identity');
  if (value.sampling !== null) validateDreamSampling(value.sampling as CapabilitySamplingResult);
  return value as DreamCapabilityRun;
}

export function sameDreamValue(a: unknown, b: unknown): boolean {
  // JSONB changes object-key order; equality must survive a database round trip.
  return isDeepStrictEqual(a, b);
}

export function dreamCallTotals(calls: readonly DreamRunCall[]) {
  return {
    inputTokens: calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
    // A crashed/unknown call is not free. Preserve its admitted upper bound.
    costUsd: calls.reduce((n, c) => n + (c.usage?.costUsd ?? c.reservedUsd), 0),
    costBasis: calls.every((c) => c.status === 'settled') ? ('actual' as const) : ('conservative-bound' as const),
    unknownCallIds: calls.filter((c) => c.status !== 'settled').map((c) => c.callId),
  };
}

export function validateDreamRunCall(value: DreamRunCall): DreamRunCall {
  return CallSchema.parse(value);
}

/** Post-run judgments are evidence, not inferred from a proposal's wording or a pass rate. */
const assessmentFinding = z.enum(['supported', 'disproven', 'unknown']);
export const DreamRunAssessmentSchema = z
  .object({
    schemaVersion: z.literal('dream-run-assessment-v1'),
    id: name,
    assessor: name,
    recordedAt: z.string().datetime(),
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    familyId: name.nullable(),
    novelty: assessmentFinding,
    usefulness: assessmentFinding,
    maintainability: assessmentFinding,
    evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    experimentBatteryIds: z.array(name).max(20),
  })
  .strict();
export type DreamRunAssessment = z.infer<typeof DreamRunAssessmentSchema>;

export function dreamRunAssessments(run: { outcome: Record<string, unknown> | null }): DreamRunAssessment[] {
  if (!run.outcome || !Object.hasOwn(run.outcome, 'assessments')) return [];
  return z.array(DreamRunAssessmentSchema).max(16).parse(run.outcome.assessments);
}
