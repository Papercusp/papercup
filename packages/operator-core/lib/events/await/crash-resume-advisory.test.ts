import { describe, expect, it } from 'vitest';
import {
  CRASH_RESUME_ADVISORY_MARKER,
  appendCrashResumeAdvisory,
  buildCrashResumeAdvisory,
} from './crash-resume-advisory';

describe('crash-resume-advisory (P-004 / R4, D-002)', () => {
  it('appends the advisory after the wake text, preserving the original as a byte-identical prefix', () => {
    const out = appendCrashResumeAdvisory('WAKE TEXT', { agent: 'claude' });
    expect(out.startsWith('WAKE TEXT\n\n')).toBe(true);
    expect(out).toContain(CRASH_RESUME_ADVISORY_MARKER);
  });

  it('is self-identifying and instructs re-verification of carried background-work claims (EI-16611)', () => {
    const a = buildCrashResumeAdvisory({ agent: 'claude' });
    expect(a.startsWith(CRASH_RESUME_ADVISORY_MARKER)).toBe(true);
    expect(a).toMatch(/RE-VERIFY/);
    // The concrete re-check levers the advisory must hand the resumed turn:
    expect(a).toContain('kill -0');
    expect(a).toContain('run_in_background');
    // The stale wrapper-shell completion claim is the trap named by EI-16611:
    expect(a).toContain('COMPLETED');
  });

  it('names the dead client and the recorded end time when known', () => {
    const a = buildCrashResumeAdvisory({ agent: 'codex', endedAtIso: '2026-09-01T12:00:00.000Z' });
    expect(a).toContain('codex process');
    expect(a).toContain('2026-09-01T12:00:00.000Z');
  });

  it('is total on null/absent meta — fail-soft framing, never a throw on the wake path', () => {
    const a = buildCrashResumeAdvisory({ agent: null });
    expect(a).toContain('CLI process');
    expect(a).not.toContain('ended_at:'); // no fabricated timestamp
    expect(appendCrashResumeAdvisory('X', { agent: null, endedAtIso: null })).toContain(
      CRASH_RESUME_ADVISORY_MARKER,
    );
    expect(appendCrashResumeAdvisory('X', { agent: '' })).toContain('CLI process');
  });

  it('stays constant-size framing, bounded well under the injection budget', () => {
    // The advisory rides OUTSIDE applyInjectionDoor (appended after the door ran on
    // the base text), so its size must stay trivially bounded. Guard the CLASS: if
    // this grows past ~1200 chars someone turned framing into a document — that
    // content belongs in a doc the advisory points at, not in every resume turn.
    expect(
      buildCrashResumeAdvisory({ agent: 'claude', endedAtIso: new Date(0).toISOString() }).length,
    ).toBeLessThan(1200);
  });
});
