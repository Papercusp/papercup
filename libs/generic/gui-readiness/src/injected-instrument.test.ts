/**
 * The property under test is DISCRIMINATION, not "does it return a string".
 *
 * The bug this module exists to fix (WI-38449) was four distinct causes
 * collapsing into one observation, so the tests that matter are the ones where
 * two inputs differ ONLY in the field that separates two causes. A suite that
 * merely checked each state in isolation would pass against a classifier that
 * returned a constant for three of them.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyInjectedInstrument,
  isInstrumentUnusable,
  type InjectedInstrumentObservation,
} from './injected-instrument.js';

/** A healthy reading. Every case below is this, minus exactly one thing. */
const healthy: InjectedInstrumentObservation = {
  docTokenAtInjection: 'doc-1',
  docTokenAfterSettle: 'doc-1',
  injectedSentinel: true,
  fatal: null,
  readySentinel: true,
};

const obs = (over: Partial<InjectedInstrumentObservation>): InjectedInstrumentObservation => ({
  ...healthy,
  ...over,
});

describe('classifyInjectedInstrument', () => {
  it('CALIBRATION: the healthy observation is ready — without this, every negative case below could pass vacuously', () => {
    const v = classifyInjectedInstrument(healthy);
    expect(v.state).toBe('ready');
    expect(v.replacementChecked).toBe(true);
    expect(isInstrumentUnusable(v)).toBe(false);
  });

  it('reports `replaced` when the doc token changed', () => {
    const v = classifyInjectedInstrument(obs({ docTokenAfterSettle: 'doc-2' }));
    expect(v.state).toBe('replaced');
    expect(v.reason).toContain('doc-1');
    expect(v.reason).toContain('doc-2');
  });

  it('reports `replaced` when the doc token vanished entirely', () => {
    const v = classifyInjectedInstrument(obs({ docTokenAfterSettle: null }));
    expect(v.state).toBe('replaced');
    expect(v.reason).toContain('(absent)');
  });

  it('reports `threw` with the message when the payload threw', () => {
    const v = classifyInjectedInstrument(obs({ fatal: 'TypeError: x is not a function' }));
    expect(v.state).toBe('threw');
    expect(v.reason).toContain('TypeError: x is not a function');
  });

  it('reports `never-executed` when the first-statement sentinel is missing', () => {
    const v = classifyInjectedInstrument(obs({ injectedSentinel: false, readySentinel: false }));
    expect(v.state).toBe('never-executed');
  });

  it('reports `incomplete` when it started, did not throw, but never completed', () => {
    const v = classifyInjectedInstrument(obs({ readySentinel: false }));
    expect(v.state).toBe('incomplete');
  });

  // ── THE DISCRIMINATION CASES — the whole reason this module exists ──────────
  //
  // Each pair is the SAME "nothing came back" observation the old probe saw. A
  // classifier that cannot separate them is the bug, restored.

  it('DISCRIMINATION: replacement and never-executed look identical to the old probe but are separated here', () => {
    const dead = { injectedSentinel: false, fatal: null, readySentinel: false };
    const replaced = classifyInjectedInstrument(obs({ ...dead, docTokenAfterSettle: 'doc-2' }));
    const neverRan = classifyInjectedInstrument(obs({ ...dead }));

    // Both are "no sentinels at all" — the exact signature that was ambiguous.
    expect(replaced.state).toBe('replaced');
    expect(neverRan.state).toBe('never-executed');
    expect(replaced.state).not.toBe(neverRan.state);
  });

  it('DISCRIMINATION: a throw is not reported as never-executed, even though both leave the ready sentinel unset', () => {
    const threw = classifyInjectedInstrument(obs({ fatal: 'boom', readySentinel: false }));
    const neverRan = classifyInjectedInstrument(
      obs({ injectedSentinel: false, readySentinel: false }),
    );
    expect(threw.state).toBe('threw');
    expect(neverRan.state).toBe('never-executed');
  });

  it('REPLACEMENT WINS over a throw: a payload cannot be judged on a document it never ran in', () => {
    // Both signals present. Judging the throw here would attribute a dead
    // window's leftovers to the payload.
    const v = classifyInjectedInstrument(obs({ docTokenAfterSettle: 'doc-2', fatal: 'boom' }));
    expect(v.state).toBe('replaced');
  });

  it('an empty-string fatal is not a throw (absence must not read as a message)', () => {
    expect(classifyInjectedInstrument(obs({ fatal: '' })).state).toBe('ready');
  });

  describe('when the caller could not read an injection-time token', () => {
    it('does NOT claim replacement, and says the check did not happen', () => {
      const v = classifyInjectedInstrument(
        obs({ docTokenAtInjection: null, docTokenAfterSettle: 'doc-9' }),
      );
      expect(v.state).toBe('ready');
      expect(v.replacementChecked).toBe(false);
    });

    it('still classifies the payload states it CAN see', () => {
      const v = classifyInjectedInstrument(
        obs({ docTokenAtInjection: null, docTokenAfterSettle: null, fatal: 'boom' }),
      );
      expect(v.state).toBe('threw');
      expect(v.replacementChecked).toBe(false);
    });
  });

  it('every state carries a non-empty reason', () => {
    const cases: Partial<InjectedInstrumentObservation>[] = [
      {},
      { docTokenAfterSettle: 'doc-2' },
      { fatal: 'boom' },
      { injectedSentinel: false },
      { readySentinel: false },
    ];
    for (const c of cases) {
      expect(classifyInjectedInstrument(obs(c)).reason.length).toBeGreaterThan(0);
    }
  });

  it('isInstrumentUnusable is true for every non-ready state', () => {
    const nonReady: Partial<InjectedInstrumentObservation>[] = [
      { docTokenAfterSettle: 'doc-2' },
      { fatal: 'boom' },
      { injectedSentinel: false },
      { readySentinel: false },
    ];
    for (const c of nonReady) {
      expect(isInstrumentUnusable(classifyInjectedInstrument(obs(c)))).toBe(true);
    }
  });
});
