import { describe, it, expect } from 'vitest';
import {
  baseDisposition,
  classifySignal,
  classifyAll,
  partition,
  SALIENCE_POLICY_VERSION,
  type FleetSignal,
  type FleetSignalKind,
} from './salience-policy';

function sig(partial: Partial<FleetSignal> & { id: string; kind: FleetSignalKind }): FleetSignal {
  return { title: partial.id, ts: '2026-06-04T00:00:00Z', ...partial };
}

const NONE = { alreadySurfaced: new Set<string>() };

describe('baseDisposition — the kind→disposition map', () => {
  it('escalation → surface + urgent', () => {
    expect(baseDisposition('escalation')).toMatchObject({ disposition: 'surface', urgent: true });
  });
  it('blocker → surface + urgent', () => {
    expect(baseDisposition('blocker')).toMatchObject({ disposition: 'surface', urgent: true });
  });
  it('decision → surface but NOT urgent', () => {
    expect(baseDisposition('decision')).toMatchObject({ disposition: 'surface', urgent: false });
  });
  it('completion of user-requested work → surface', () => {
    expect(baseDisposition('completion', true)).toMatchObject({ disposition: 'surface', urgent: false });
  });
  it('fleet-internal completion → batch', () => {
    expect(baseDisposition('completion', false)).toMatchObject({ disposition: 'batch' });
    expect(baseDisposition('completion', undefined)).toMatchObject({ disposition: 'batch' });
  });
  it('routine progress → batch', () => {
    expect(baseDisposition('progress')).toMatchObject({ disposition: 'batch', urgent: false });
  });
  it('unknown kind → batch (defensive), never surface or drop', () => {
    expect(baseDisposition('???' as FleetSignalKind)).toMatchObject({ disposition: 'batch' });
  });
});

describe('INVARIANT — escalations/blockers are never suppressed on their merits (D-004)', () => {
  it('baseDisposition for escalation/blocker is ALWAYS surface, regardless of provenance', () => {
    for (const userRequested of [true, false, undefined]) {
      expect(baseDisposition('escalation', userRequested).disposition).toBe('surface');
      expect(baseDisposition('blocker', userRequested).disposition).toBe('surface');
    }
  });
  it('a brand-new escalation is surfaced even when other things were already surfaced', () => {
    const state = { alreadySurfaced: new Set(['progress:x', 'completion:y']) };
    const v = classifySignal(sig({ id: 'escalation:new', kind: 'escalation' }), state);
    expect(v.disposition).toBe('surface');
    expect(v.urgent).toBe(true);
  });
});

describe('classifySignal — idempotency overlay', () => {
  it('suppresses a signal already surfaced (de-dup, not hiding)', () => {
    const state = { alreadySurfaced: new Set(['escalation:e1']) };
    const v = classifySignal(sig({ id: 'escalation:e1', kind: 'escalation' }), state);
    expect(v.disposition).toBe('suppress');
    expect(v.reason).toMatch(/idempotency/);
  });
  it('suppresses an already-batched progress signal too', () => {
    const state = { alreadySurfaced: new Set(['progress:p1']) };
    expect(classifySignal(sig({ id: 'progress:p1', kind: 'progress' }), state).disposition).toBe('suppress');
  });
  it('does not suppress a fresh signal', () => {
    expect(classifySignal(sig({ id: 'decision:d1', kind: 'decision' }), NONE).disposition).toBe('surface');
  });
});

describe('classifyAll + partition', () => {
  const signals: FleetSignal[] = [
    sig({ id: 'progress:1', kind: 'progress' }),
    sig({ id: 'escalation:1', kind: 'escalation' }),
    sig({ id: 'decision:1', kind: 'decision' }),
    sig({ id: 'completion:user', kind: 'completion', userRequested: true }),
    sig({ id: 'completion:internal', kind: 'completion', userRequested: false }),
    sig({ id: 'blocker:1', kind: 'blocker' }),
    sig({ id: 'progress:seen', kind: 'progress' }),
  ];

  it('classifies the whole set keyed by id', () => {
    const verdicts = classifyAll(signals, { alreadySurfaced: new Set(['progress:seen']) });
    expect(verdicts.get('escalation:1')!.disposition).toBe('surface');
    expect(verdicts.get('progress:seen')!.disposition).toBe('suppress');
    expect(verdicts.get('completion:internal')!.disposition).toBe('batch');
  });

  it('partitions into surfaceNow (urgent-first) / batch, dropping suppressed', () => {
    const verdicts = classifyAll(signals, { alreadySurfaced: new Set(['progress:seen']) });
    const { surfaceNow, batch, hasUrgent } = partition(signals, verdicts);

    const surfacedIds = surfaceNow.map((c) => c.signal.id);
    // escalation + blocker (urgent) + decision + user-completion are surfaced
    expect(surfacedIds).toEqual(
      expect.arrayContaining(['escalation:1', 'blocker:1', 'decision:1', 'completion:user']),
    );
    // urgent ones lead
    expect(surfaceNow[0].verdict.urgent).toBe(true);
    expect(hasUrgent).toBe(true);

    // routine progress + internal completion are batched; the seen one is dropped
    const batchIds = batch.map((c) => c.signal.id);
    expect(batchIds).toEqual(expect.arrayContaining(['progress:1', 'completion:internal']));
    expect(batchIds).not.toContain('progress:seen');
    expect(surfacedIds).not.toContain('progress:seen');
  });

  it('hasUrgent is false when only routine/decision signals are present', () => {
    const calm: FleetSignal[] = [sig({ id: 'decision:x', kind: 'decision' }), sig({ id: 'progress:x', kind: 'progress' })];
    const verdicts = classifyAll(calm, NONE);
    expect(partition(calm, verdicts).hasUrgent).toBe(false);
  });
});

describe('SALIENCE_POLICY_VERSION', () => {
  it('is a stable non-empty string', () => {
    expect(typeof SALIENCE_POLICY_VERSION).toBe('string');
    expect(SALIENCE_POLICY_VERSION.length).toBeGreaterThan(0);
  });
});
