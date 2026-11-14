import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FINAL_CONTEXT_SAMPLE_INSTRUMENT, finalContextSampleRescore, measureFinalContextSource } from './final-context-measurement';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import type { FinalContextAttemptSnapshot } from './injection-delivery-coverage';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const window = { workspaceId: 'fixture-workspace', harnessSlug: 'fixture-harness',
  windowStart: '2026-11-11T12:00:00.000Z', windowEnd: '2026-11-12T12:00:00.000Z' };
function fixture(): FinalContextAttemptSnapshot {
  const text = 'Deploy only after approval.';
  return { schemaVersion: 'final-attempt-source-v1', snapshotId: 'fixture', sourceSchemaSha256: hash('schema'),
    runtimeGeneration: 'fixture-only', environmentSha256: hash('env'), configurationSha256: hash('config'),
    measuredAt: window.windowEnd, capturedAt: window.windowEnd,
    attempts: [{ sourceStoreId: 'fixture-store', attemptId: 'one', attemptSchemaVersion: 'v1', recordVersion: 1,
      createdAt: '2026-11-12T10:00:00.000Z', visibleAt: '2026-11-12T11:00:00.000Z', client: 'codex', sink: 'mid-turn',
      recipient: 'fixture-recipient', workspace: window.workspaceId, epoch: 1, nativeSessionId: 'fixture-native',
      labelEvidenceRef: 'fixture-independent-labels', taskBenefit: 'useful', context: {
        attemptId: 'one', sessionId: 'fixture-recipient', epoch: 1, port: 'mid-turn', block: text,
        requiredFactKeys: ['approval'], retrievedFactKeys: ['approval'], admittedFactKeys: ['approval'],
        fragments: [{ sourceRef: 'fixture-decision', factKey: 'approval', text, requiredQualifiers: ['only after approval'],
          correct: true, current: true, authoritative: true, scopeAllowed: true, referencesResolve: true }],
      } }],
    receipts: [{ sourceStoreId: 'fixture-store', attemptId: 'one', attemptSchemaVersion: 'v1',
      recipient: 'fixture-recipient', workspace: window.workspaceId, epoch: 1, client: 'codex', sink: 'mid-turn',
      event: 'complete-stdout', blockSha256: hash(text), fragmentSha256: [hash(text)], evidenceRef: 'fixture-native-receipt' }],
  };
}
const measure = (source: FinalContextAttemptSnapshot, scope = window) => {
  const json = JSON.stringify(source);
  return measureFinalContextSource(json, hash(json), scope);
};

describe('registered final-context sample measurement', () => {
  it('replays labelled receipt-joined source and retains its exact immutable evidence', () => {
    const source = fixture(), result = measure(source);
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).toEqual([`immutable/sha256/${hash(JSON.stringify(source))}.json`,
      'fixture-native-receipt', 'fixture-independent-labels']);
    expect(JSON.parse(result.detail)).toMatchObject({ attempted: 1, usefulSuccesses: 1, usefulFailures: 0, usefulUnknown: 0 });
  });
  it.each(['labels', 'receipt', 'epoch', 'native', 'opportunity', 'benefit', 'empty'] as const)(
    'preserves UNKNOWN for missing %s instead of passing mechanism integrity', missing => {
      const source = fixture();
      if (missing === 'labels') delete source.attempts[0]!.labelEvidenceRef;
      if (missing === 'receipt') source.receipts = [];
      if (missing === 'epoch') source.attempts[0]!.epoch = null;
      if (missing === 'native') source.attempts[0]!.nativeSessionId = null;
      if (missing === 'opportunity') delete source.attempts[0]!.context.requiredFactKeys;
      if (missing === 'benefit') delete source.attempts[0]!.taskBenefit;
      if (missing === 'empty') { source.attempts = []; source.receipts = []; }
      expect(measure(source).verdict).toBe('unknown');
    });
  it('records a confirmed harmful outcome as failure even alongside an unknown label', () => {
    const source = fixture(); source.attempts[0]!.taskBenefit = 'harmful'; delete source.attempts[0]!.labelEvidenceRef;
    expect(measure(source).verdict).toBe('fail');
  });
  it('uses native identity from the latest sampled record version, retaining earlier sightings', () => {
    const source = fixture();
    source.attempts.push({ ...structuredClone(source.attempts[0]!), recordVersion: 0, nativeSessionId: null });
    expect(measure(source).verdict).toBe('pass');
  });
  it('rejects foreign workspaces, shifted windows, modified bytes and malformed snapshots', () => {
    expect(measure(fixture(), { ...window, workspaceId: 'other' }).verdict).toBe('unknown');
    expect(measure(fixture(), { ...window, windowEnd: '2026-11-12T13:00:00.000Z' }).verdict).toBe('unknown');
    expect(measureFinalContextSource(JSON.stringify(fixture()), hash('other'), window).verdict).toBe('unknown');
    expect(measureFinalContextSource('{}', hash('{}'), window).verdict).toBe('unknown');
  });
  it('registers an executable subject binding and refuses mutable or missing subjects before I/O', async () => {
    const instrument = getRegisteredInstrument(FINAL_CONTEXT_SAMPLE_INSTRUMENT);
    expect(instrument).toMatchObject({ evaluator: 'platform', rescore: { scope: 'subject', windowMs: 86_400_000 } });
    expect(await finalContextSampleRescore().resolve(window)).toMatchObject({ verdict: 'unknown' });
    expect(await finalContextSampleRescore().resolve({ ...window, subject: { ref: 'mutable-alias' } })).toMatchObject({ verdict: 'unknown' });
  });
});
