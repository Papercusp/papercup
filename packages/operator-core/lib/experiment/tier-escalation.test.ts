import { describe, expect, it } from 'vitest';
import { COST_EXCEPTION_KINDS, evaluateTierEscalation, isCostExceptionKind } from './tier-escalation';

describe('evaluateTierEscalation (P-040/P-041)', () => {
  it('offline is always allowed — the default front door, no justification needed', () => {
    expect(evaluateTierEscalation({ requestedTier: 'offline', kind: 'replay' }).ok).toBe(true);
    // even a cost-exception kind is fine at the offline tier (it never spends)
    expect(evaluateTierEscalation({ requestedTier: 'offline', kind: 'whole-hive' }).ok).toBe(true);
  });

  it('refuses a spending tier with NO escalation justification', () => {
    const v = evaluateTierEscalation({ requestedTier: 'live', kind: 'component' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/positive offline signal|couldn.t-isolate/i);
    // shadow is gated identically
    expect(evaluateTierEscalation({ requestedTier: 'shadow', kind: 'component' }).ok).toBe(false);
  });

  it('allows a spending tier on a positive offline signal (a prior offline runId)', () => {
    const v = evaluateTierEscalation({ requestedTier: 'live', kind: 'component', escalation: { offlineSignalRunId: 'run_123' } });
    expect(v.ok).toBe(true);
  });

  it('allows a spending tier on a written couldn’t-isolate trigger', () => {
    const v = evaluateTierEscalation({
      requestedTier: 'live',
      kind: 'component',
      escalation: { couldntIsolate: 'the overlay only matters under real multi-agent contention, which replay cannot reproduce' },
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a rubber-stamp couldn’t-isolate trigger that is too short', () => {
    const v = evaluateTierEscalation({ requestedTier: 'live', kind: 'component', escalation: { couldntIsolate: 'because' } });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/couldn.t-isolate/i);
  });

  it('treats blank/whitespace signal + trigger as absent', () => {
    const v = evaluateTierEscalation({ requestedTier: 'live', kind: 'component', escalation: { offlineSignalRunId: '   ', couldntIsolate: '    ' } });
    expect(v.ok).toBe(false);
  });

  it('whole-instance / whole-Hive need a cost-exception ack IN ADDITION to a signal/trigger', () => {
    // signal present but no costException → still refused for the gated cost-exception kinds
    for (const kind of COST_EXCEPTION_KINDS) {
      const noAck = evaluateTierEscalation({ requestedTier: 'live', kind, escalation: { offlineSignalRunId: 'run_1' } });
      expect(noAck.ok, kind).toBe(false);
      expect(noAck.reason, kind).toMatch(/gated cost-exception/i);

      const acked = evaluateTierEscalation({ requestedTier: 'live', kind, escalation: { offlineSignalRunId: 'run_1', costException: true } });
      expect(acked.ok, kind).toBe(true);
    }
  });

  it('a cost-exception ack alone (no signal/trigger) is still refused — both gates apply', () => {
    const v = evaluateTierEscalation({ requestedTier: 'live', kind: 'whole-hive', escalation: { costException: true } });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/positive offline signal|couldn.t-isolate/i);
  });

  it('isCostExceptionKind identifies only whole-instance + whole-Hive', () => {
    expect(isCostExceptionKind('whole-instance')).toBe(true);
    expect(isCostExceptionKind('whole-hive')).toBe(true);
    expect(isCostExceptionKind('component')).toBe(false);
    expect(isCostExceptionKind('replay')).toBe(false);
    expect(isCostExceptionKind('drill')).toBe(false);
  });
});
