import { describe, expect, it } from 'vitest';

import { advSessionEndedAtCaveat, isObserverEndedSession, type AdvSessionRow } from './adv-sessions';
import { withFieldReliability } from './field-reliability';

type EndFields = Pick<AdvSessionRow, 'endedAt' | 'endedBy'>;

const ENDED = '2026-08-02T19:05:07.810Z';

describe('adv_session ended_at provenance (P-015, silent-wrong-answers-2026-08-01)', () => {
  it('treats a self-reported end as a real observation — no caveat, result untouched', () => {
    const row: EndFields = { endedAt: ENDED, endedBy: 'self' };
    expect(isObserverEndedSession(row)).toBe(false);
    expect(advSessionEndedAtCaveat(row)).toBeNull();

    const result = { id: 1, endedAt: ENDED };
    // withFieldReliability returns the object UNCHANGED for an empty caveat list, so a
    // healthy row gains no noise.
    expect(withFieldReliability(result, [])).toBe(result);
  });

  it('caveats a reaper-ended row and names what CAN answer the question', () => {
    const row: EndFields = { endedAt: ENDED, endedBy: 'reaper' };
    expect(isObserverEndedSession(row)).toBe(true);

    const c = advSessionEndedAtCaveat(row);
    expect(c).not.toBeNull();
    expect(c!.reliability).toBe('inferred');
    expect(c!.field).toBe('endedAt');
    // A refusal/caveat that strands the reader is not an answer.
    expect(c!.insteadRead).toContain('coord_presence.last_active_at');
    expect(c!.because).toContain('reaper');
  });

  it.each(['reaper', 'reconciler', 'cleanup'] as const)(
    'caveats every non-self writer (%s)',
    (endedBy) => {
      expect(advSessionEndedAtCaveat({ endedAt: ENDED, endedBy })).not.toBeNull();
    },
  );

  it('treats a legacy NULL endedBy as UNKNOWN provenance, never as a clean self exit', () => {
    // Absence of attribution is not evidence of a clean exit. A pre-migration-735 row
    // must caveat, or every historical row silently reads as an observation.
    const row: EndFields = { endedAt: ENDED, endedBy: null };
    expect(isObserverEndedSession(row)).toBe(true);
    expect(advSessionEndedAtCaveat(row)?.because).toContain('unknown');
  });

  it('never caveats a session that has not ended', () => {
    expect(isObserverEndedSession({ endedAt: null, endedBy: null })).toBe(false);
    expect(advSessionEndedAtCaveat({ endedAt: null, endedBy: null })).toBeNull();
  });

  it('does NOT infer provenance from exitCode — the shortcut that over-fires on real self-reports', () => {
    // The tempting rule was "exitCode == null means a sweeper wrote it". It is WRONG:
    // harness/spawn.ts passes `r.exitCode ?? null`, so a genuine self-report also writes
    // NULL. Locking this in: a self-ended row with a null exit code stays UNCAVEATED, and
    // a reaper-ended row with a non-null exit code stays CAVEATED. Both directions.
    expect(advSessionEndedAtCaveat({ endedAt: ENDED, endedBy: 'self' })).toBeNull();
    expect(advSessionEndedAtCaveat({ endedAt: ENDED, endedBy: 'reaper' })).not.toBeNull();
  });

  it('renders a warning a skimming agent cannot miss', () => {
    const c = advSessionEndedAtCaveat({ endedAt: ENDED, endedBy: 'reaper' })!;
    const out = withFieldReliability({ endedAt: ENDED }, [c]) as {
      _fieldReliabilityWarning: string;
    };
    expect(out._fieldReliabilityWarning).toContain('INFERRED');
    expect(out._fieldReliabilityWarning).toContain('when did this session actually end?');
    expect(out._fieldReliabilityWarning).toContain('coord_presence.last_active_at');
  });

  it('supports a caller-supplied field name for nested results', () => {
    const c = advSessionEndedAtCaveat({ endedAt: ENDED, endedBy: 'reaper' }, 'session.endedAt');
    expect(c!.field).toBe('session.endedAt');
  });
});
