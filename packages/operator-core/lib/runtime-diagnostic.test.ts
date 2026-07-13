import { describe, expect, it } from 'vitest';
import { runtimeDiagnostic } from './runtime-diagnostic';

describe('runtimeDiagnostic', () => {
  it('preserves the five-field configured/effective/evidence/rootCause/nextVerb contract', () => {
    const out = runtimeDiagnostic({
      configured: { cap: 12 },
      effective: { cap: 1 },
      evidence: [{ queued: 3, idle: 9 }],
      rootCause: { component: 'admission', reason: 'queued while idle' },
      nextVerb: 'gateway:status',
    });
    expect(Object.keys(out)).toEqual(['configured', 'effective', 'evidence', 'rootCause', 'nextVerb']);
    expect(out.nextVerb).toBe('gateway:status');
  });

  it('uses null, not a missing field, for a healthy diagnostic', () => {
    const out = runtimeDiagnostic({
      configured: true,
      effective: true,
      evidence: [],
      rootCause: null,
      nextVerb: null,
    });
    expect(out).toHaveProperty('rootCause', null);
    expect(out).toHaveProperty('nextVerb', null);
  });
});
