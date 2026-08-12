import { describe, expect, it } from 'vitest';

import {
  advSessionEndedAtCaveat,
  advSessionExitCodeCaveat,
  describeSessionEndTime,
  isInvoluntaryEnd,
  isObserverEndedSession,
  type AdvSessionRow,
} from './adv-sessions';
import { withFieldReliability } from './field-reliability';

type EndFields = Pick<AdvSessionRow, 'endedAt' | 'endedBy'>;
type KillFields = Pick<AdvSessionRow, 'endedAt' | 'endedBy' | 'endedSignal'>;

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

  describe('describeSessionEndTime — the prose form, where doubt has nowhere else to go', () => {
    it('states a real end time ONLY for a self-reported exit', () => {
      expect(describeSessionEndTime({ endedAt: ENDED, endedBy: 'self' })).toBe(`ended ${ENDED}`);
    });

    it.each(['reaper', 'reconciler', 'cleanup'] as const)(
      'never says "ended <ts>" for a %s-written stamp',
      (endedBy) => {
        const s = describeSessionEndTime({ endedAt: ENDED, endedBy });
        expect(s).not.toMatch(/^ended /);
        expect(s).toContain('NOTICED it was gone, not when it ended');
        expect(s).toContain(endedBy);
      },
    );

    it('names an unrecorded writer rather than implying a clean exit, for a legacy row', () => {
      const s = describeSessionEndTime({ endedAt: ENDED, endedBy: null });
      expect(s).not.toMatch(/^ended /);
      expect(s).toContain('an unrecorded writer');
    });

    it('says the end time is unknown when the session has not ended', () => {
      expect(describeSessionEndTime({ endedAt: null, endedBy: null })).toBe('end time unknown');
      expect(describeSessionEndTime({ endedAt: null, endedBy: 'self' })).toBe('end time unknown');
    });
  });

  it('supports a caller-supplied field name for nested results', () => {
    const c = advSessionEndedAtCaveat({ endedAt: ENDED, endedBy: 'reaper' }, 'session.endedAt');
    expect(c!.field).toBe('session.endedAt');
  });
});

describe('a KILLED session is not a voluntary exit (WI-38054)', () => {
  // 735 gave us one axis (is `ended_at` a real end time, or a NOTICE time?). This is
  // the orthogonal one: WAS THE EXIT VOLUNTARY? They come apart for exactly one
  // writer — 'signal' — and that is the case that cost the owner two agents silently.
  //
  // The trap this block exists to hold shut: 'signal' is an OBSERVATION (the live
  // parent watched its child die), so it must NOT be swept in with the sweeper
  // writers. Fixing "it lies about being voluntary" by making it lie about its
  // timestamp instead would just move the wrong answer one column over.

  it('treats a signal death as a REAL end time — the parent observed it', () => {
    const row: KillFields = { endedAt: ENDED, endedBy: 'signal' };
    expect(isObserverEndedSession(row)).toBe(false);
    expect(advSessionEndedAtCaveat(row)).toBeNull();
  });

  it('still reports a signal death as INVOLUNTARY, which is the whole point', () => {
    expect(isInvoluntaryEnd({ endedAt: ENDED, endedBy: 'signal' })).toBe(true);
    expect(isInvoluntaryEnd({ endedAt: ENDED, endedBy: 'self' })).toBe(false);
    // A sweeper row is NOT "involuntary" — we have no idea how the process died; it
    // was simply already gone. Claiming otherwise is the same over-attribution the
    // 'signal'-not-'reaped' naming decision exists to avoid.
    expect(isInvoluntaryEnd({ endedAt: ENDED, endedBy: 'reaper' })).toBe(false);
    expect(isInvoluntaryEnd({ endedAt: ENDED, endedBy: null })).toBe(false);
  });

  it('says KILLED in prose, and names the signal, while still stating the real time', () => {
    const s = describeSessionEndTime({ endedAt: ENDED, endedBy: 'signal', endedSignal: 'SIGHUP' });
    expect(s).toContain(ENDED); // the time IS trustworthy — do not hedge it
    expect(s).toMatch(/killed/i); // ...but never let it read as a clean exit
    expect(s).toContain('SIGHUP');
    expect(s).not.toContain('NOTICED it was gone');
  });

  it('does not invent a signal name when the column is null', () => {
    const s = describeSessionEndTime({ endedAt: ENDED, endedBy: 'signal', endedSignal: null });
    expect(s).toMatch(/killed/i);
    expect(s).not.toMatch(/\bSIG[A-Z]+\b/);
  });

  describe('exit_code 0 on a signal row is a node-pty placeholder, not a clean exit', () => {
    // MEASURED against the real node-pty in this tree:
    //     kill(pid,'SIGHUP')  ->  {"exitCode":0,"signal":1}
    // The zero is not an exit status at all. Every reader that treats exit_code as a
    // status must be told, because "exit 0" is the single most convincing piece of
    // false evidence in the whole row — it is what made the reap look deliberate.

    it('caveats exitCode on a signal-ended row', () => {
      const c = advSessionExitCodeCaveat({ endedAt: ENDED, endedBy: 'signal', exitCode: 0 });
      expect(c).not.toBeNull();
      expect(c!.field).toBe('exitCode');
      expect(c!.cannotAnswer).toMatch(/exit|clean/i);
      expect(c!.insteadRead).toContain('ended_signal');
    });

    it('leaves a genuine self-reported exit code uncaveated', () => {
      expect(
        advSessionExitCodeCaveat({ endedAt: ENDED, endedBy: 'self', exitCode: 0 }),
      ).toBeNull();
      expect(
        advSessionExitCodeCaveat({ endedAt: ENDED, endedBy: 'self', exitCode: 1 }),
      ).toBeNull();
    });

    it('renders a warning a skimming agent cannot miss', () => {
      const c = advSessionExitCodeCaveat({ endedAt: ENDED, endedBy: 'signal', exitCode: 0 })!;
      const out = withFieldReliability({ exitCode: 0 }, [c]) as {
        _fieldReliabilityWarning: string;
      };
      expect(out._fieldReliabilityWarning).toContain('INFERRED');
    });
  });

  it('REGRESSION — the exact reported row must not read as a voluntary clean exit', () => {
    // adv_sessions 14851/14852, 2026-08-11T22:44:42Z: two agents the owner launched
    // by hand, different lifetimes, killed in the same second by a sidecar restart,
    // both recorded exit 0 / ended_by 'self'. Reconstructed here as they SHOULD be
    // recorded. If any future refactor lets this row read as voluntary again, the
    // mass reap goes back to being undetectable.
    const reaped: KillFields & { exitCode: number | null } = {
      endedAt: '2026-08-11T22:44:42.000Z',
      endedBy: 'signal',
      endedSignal: 'SIGHUP',
      exitCode: 0,
    };
    expect(isInvoluntaryEnd(reaped)).toBe(true);
    expect(describeSessionEndTime(reaped)).toMatch(/killed/i);
    expect(advSessionExitCodeCaveat(reaped)).not.toBeNull();
    // ...and the timestamp stays trustworthy, so "same second" remains provable.
    expect(isObserverEndedSession(reaped)).toBe(false);
  });
});
