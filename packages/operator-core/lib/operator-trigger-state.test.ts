import { describe, expect, it } from 'vitest';
import { fingerprint, type TriggerState } from './operator-trigger-state';

describe('fingerprint', () => {
  const base: TriggerState = {
    unconsumedEvents: 0,
    projects: [{ slug: 'a', status: 'idle' }],
    operatorInboxCount: 0,
  };

  it('is stable for identical state', () => {
    expect(fingerprint(base)).toBe(fingerprint(base));
  });

  it('changes when unconsumedEvents changes', () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, unconsumedEvents: 1 }));
  });

  it('changes when a project status flips', () => {
    expect(fingerprint(base)).not.toBe(
      fingerprint({ ...base, projects: [{ slug: 'a', status: 'running' }] }),
    );
  });

  it('changes when the operator inbox count changes', () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, operatorInboxCount: 5 }));
  });

  it('does NOT include perHarness in the digest (display-only)', () => {
    const withCosmetic: TriggerState = {
      ...base,
      perHarness: [{ slug: 'a', status: 'idle', lastTouched: '2026-05-02' }],
    };
    expect(fingerprint(base)).toBe(fingerprint(withCosmetic));
  });
});
