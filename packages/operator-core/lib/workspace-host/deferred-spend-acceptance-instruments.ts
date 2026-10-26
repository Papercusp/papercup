/** Distinct deferred-spend measurements. Source proof never establishes a live outcome. */
import { z } from 'zod';
import {
  deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, evaluateDeferredSpendEvidence,
  type DeferredSpendEvidence, type DeferredSpendEvidenceIdentity, type DeferredSpendEvidenceResult,
  type EvidenceVerdict,
} from './deferred-spend-acceptance-contract';

export const DEFERRED_SPEND_ACCEPTANCE_PLAN = 'workspace-host-deferred-spend-reconciliation-2026-09-07';
export const DEFERRED_SPEND_INSTRUMENT_KEYS = Object.freeze({
  r007: 'workspace-host.deferred-spend.r007',
  r008: 'workspace-host.deferred-spend.r008',
});

const text = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
export const deferredSpendMeasurementRequestSchema = z.object({
  workspaceId: text, harness: text, planSlug: z.literal(DEFERRED_SPEND_ACCEPTANCE_PLAN),
  rubricRef: text, rubricRevision: z.number().int().positive(),
  criteriaHash: z.string().regex(/^[a-f0-9]{64}$/),
  subjectRef: text, windowStart: timestamp, windowEnd: timestamp,
}).strict().refine(value => Date.parse(value.windowStart) < Date.parse(value.windowEnd), 'empty observation interval');
export type DeferredSpendMeasurementRequest = z.infer<typeof deferredSpendMeasurementRequestSchema>;
export type DeferredSpendCriterion = keyof typeof DEFERRED_SPEND_INSTRUMENT_KEYS;
export interface DeferredSpendCriterionMeasurement {
  readonly verdict: EvidenceVerdict;
  readonly reasons: readonly string[];
  readonly evidence?: DeferredSpendEvidenceResult;
}
export interface DeferredSpendAcceptanceMeasurement {
  readonly scope: 'deferred-spend-acceptance';
  readonly identity?: DeferredSpendEvidenceIdentity;
  readonly manifestRef?: string;
  readonly manifestHash?: string;
  readonly criteria: Readonly<Record<DeferredSpendCriterion, DeferredSpendCriterionMeasurement>>;
}
export interface DeferredSpendAcceptanceEvidence {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly r007: DeferredSpendEvidence;
  readonly r008: DeferredSpendEvidence;
  /** Complete source manifests and join provenance, retained without relabelling their identity. */
  readonly source: unknown;
}
export interface DeferredSpendAcceptanceDependencies {
  /** Trusted platform adapter only. Never derived from caller instrumentSnapshots. */
  readonly read?: (request: Readonly<DeferredSpendMeasurementRequest>) => Promise<DeferredSpendAcceptanceEvidence>;
  /** Persist the complete content-addressed manifest in existing durable artifact storage. */
  readonly persist?: (harness: string, path: string, body: string) => Promise<void>;
}

function unknown(reason: string): DeferredSpendAcceptanceMeasurement {
  return { scope: 'deferred-spend-acceptance', criteria: {
    r007: { verdict: 'unknown', reasons: [reason] }, r008: { verdict: 'unknown', reasons: [reason] },
  } };
}
async function persistManifest(harness: string, path: string, body: string): Promise<void> {
  const { compareAndSwapTextArtifact, loadTextArtifact } = await import('../text-artifacts');
  const current = await loadTextArtifact(harness, path);
  if (current !== body && (current !== null || !await compareAndSwapTextArtifact(harness, path, null, body))) {
    throw new Error('manifest persistence conflict');
  }
  if (await loadTextArtifact(harness, path) !== body) throw new Error('durable manifest readback differs');
}

/** Both criteria are independently validated and persisted together in one immutable edition.
 * No default runtime reader is inferred from a source checkout or a supplied snapshot.
 */
export async function measureDeferredSpendAcceptance(
  request: DeferredSpendMeasurementRequest,
  dependencies: DeferredSpendAcceptanceDependencies = {},
): Promise<DeferredSpendAcceptanceMeasurement> {
  const parsed = deferredSpendMeasurementRequestSchema.safeParse(request);
  if (!parsed.success) return unknown('complete platform measurement scope, rubric identity and interval required');
  if (!dependencies.read) return unknown('trusted read-only runtime evidence adapter unavailable');
  const wanted = Object.freeze(parsed.data);
  try {
    const evidence = await dependencies.read(wanted);
    const parsedIdentity = deferredSpendEvidenceIdentitySchema.safeParse(evidence.identity);
    if (!parsedIdentity.success) return unknown('runtime evidence identity missing or invalid');
    const identity = parsedIdentity.data;
    if (identity.subject.kind !== 'live' || identity.subject.ref !== wanted.subjectRef ||
        deferredSpendFingerprint(identity.scope) !== deferredSpendFingerprint({
          workspaceId: wanted.workspaceId, harness: wanted.harness, planSlug: wanted.planSlug,
          rubricRef: wanted.rubricRef, rubricRevision: wanted.rubricRevision, criteriaHash: wanted.criteriaHash,
        }) || identity.observation.window.startAt !== wanted.windowStart || identity.observation.window.endAt !== wanted.windowEnd) {
      return unknown('source-only, foreign or stale evidence cannot establish the requested live observation');
    }
    const r007 = evaluateDeferredSpendEvidence({ expectedIdentity: identity,
      requiredSlices: ['retained-spend-population'] }, evidence.r007);
    const r008 = evaluateDeferredSpendEvidence({ expectedIdentity: identity,
      requiredSlices: ['source-census', 'action-boundary'] }, evidence.r008);
    const criteria = {
      r007: { verdict: r007.verdict, reasons: r007.reasons, evidence: r007 },
      r008: { verdict: r008.verdict, reasons: r008.reasons, evidence: r008 },
    };
    const manifest = structuredClone({ schemaVersion: 'deferred-spend-acceptance-manifest-v1',
      request: wanted, identity, criteria, source: evidence.source, inputs: { r007: evidence.r007, r008: evidence.r008 } });
    const manifestHash = deferredSpendFingerprint(manifest);
    const path = `evidence/deferred-spend/${manifestHash}.json`;
    await (dependencies.persist ?? persistManifest)(wanted.harness, path, JSON.stringify(manifest));
    return { scope: 'deferred-spend-acceptance', identity, manifestHash,
      manifestRef: `artifact:${wanted.harness}:${path}`, criteria };
  } catch {
    return unknown('runtime evidence collection or durable manifest persistence failed');
  }
}
