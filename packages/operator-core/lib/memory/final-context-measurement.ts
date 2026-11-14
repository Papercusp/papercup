/** Replay a frozen source through the maintained R-10 sampler. This measures
 * labelled sample quality; independent acceptance still verifies label custody.
 * Reuses immutable artifacts and the rubric-check ledger, with no new store. */
import { createHash } from 'node:crypto';
import { sampleFinalDeliveredContext, type FinalContextAttemptSnapshot } from './injection-delivery-coverage';
import type { PlatformInstrument } from '../rubric-instrument-registry';

export const FINAL_CONTEXT_SAMPLE_INSTRUMENT = 'context-injection:final-sample-quality';
export const FINAL_CONTEXT_SOURCE_PREFIX = 'final-context-source:';
const DAY_MS = 86_400_000;
type Window = Parameters<NonNullable<PlatformInstrument['rescore']>['resolve']>[0];
type Measurement = Awaited<ReturnType<NonNullable<PlatformInstrument['rescore']>['resolve']>>;

/** The reference pins source bytes, never a mutable alias or caller-authored total.
 * A foreign scope, incomplete identity or empty denominator cannot pass. */
export function measureFinalContextSource(sourceJson: string, sourceSha256: string, window: Window): Measurement {
  const unknown = (detail: string) => ({ verdict: 'unknown' as const, detail });
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) ||
      createHash('sha256').update(sourceJson).digest('hex') !== sourceSha256) return unknown('Source artifact hash mismatch.');
  try {
    const source = JSON.parse(sourceJson) as FinalContextAttemptSnapshot;
    const sample = sampleFinalDeliveredContext(source);
    if (!window.workspaceId.trim() || window.windowStart !== sample.windowStart || window.windowEnd !== sample.measuredAt ||
        source.attempts.some(row => row.workspace !== window.workspaceId)) return unknown('Source workspace/window mismatch.');
    const selected = new Map(sample.attempts.map(row => [row.identity, row.recordVersion]));
    const missingNativeIdentity = source.attempts.some(row => selected.get(JSON.stringify([
      row.sourceStoreId, row.attemptId, row.attemptSchemaVersion,
    ])) === row.recordVersion && !row.nativeSessionId?.trim());
    const verdict = sample.usefulFailures > 0 ? 'fail' as const
      : !sample.attempted || sample.usefulUnknown > 0 || missingNativeIdentity ? 'unknown' as const : 'pass' as const;
    const sampleSha256 = createHash('sha256').update(JSON.stringify(sample)).digest('hex');
    return { verdict,
      detail: JSON.stringify({ schemaVersion: sample.schemaVersion, sourceSha256, sampleSha256,
        windowStart: sample.windowStart, windowEnd: sample.measuredAt, runtimeGeneration: sample.runtimeGeneration,
        environmentSha256: sample.environmentSha256, configurationSha256: sample.configurationSha256,
        attempted: sample.attempted, usefulSuccesses: sample.usefulSuccesses,
        usefulFailures: sample.usefulFailures, usefulUnknown: sample.usefulUnknown, missingNativeIdentity,
        qualification: 'label-custody-and-serving-containment-require-independent-review' }),
      evidenceRefs: [...new Set([`immutable/sha256/${sourceSha256}.json`,
        ...sample.attempts.flatMap(row => [...row.receiptRefs, ...(row.labelEvidenceRef ? [row.labelEvidenceRef] : [])])])],
    };
  } catch {
    return unknown('Invalid frozen final-context source; no measurement can be inferred.');
  }
}

export function finalContextSampleRescore(): NonNullable<PlatformInstrument['rescore']> {
  return { windowMs: DAY_MS, unit: 'count', scope: 'subject', resolve: async window => {
    const match = window.subject?.ref.match(/^final-context-source:([a-f0-9]{64})$/);
    if (!match || !window.harnessSlug?.trim()) return { verdict: 'unknown', detail: 'Exact immutable source subject and harness required.' };
    const [{ activeWorkspaceId }, { loadImmutableTextArtifact }] = await Promise.all([
      import('../workspace-registry'), import('../text-artifacts'),
    ]);
    if (window.workspaceId !== activeWorkspaceId()) return { verdict: 'unknown', detail: 'Foreign workspace refused.' };
    const source = await loadImmutableTextArtifact(window.harnessSlug, match[1]!);
    if (source === null) return { verdict: 'unknown', detail: 'Immutable source unavailable in this workspace/harness.' };
    return measureFinalContextSource(source, match[1]!, window);
  } };
}
