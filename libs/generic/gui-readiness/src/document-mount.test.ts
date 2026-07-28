import { describe, expect, it } from 'vitest';
import {
  classifyMountObservation,
  INITIAL_MOUNT_PROGRESS,
  type DocumentObservation,
  type MountClassifierConfig,
  type MountProgress,
  type MountVerdict,
} from './document-mount.js';

const CONFIG: MountClassifierConfig = {
  isTerminalWrongScreen: (p) => p === '/onboarding' || p === '/setup' || p === '/login',
  wrongScreenDwellMs: 5_000,
  documentDeathDwellMs: 2_000,
};

function obs(over: Partial<DocumentObservation> = {}): DocumentObservation {
  return { pathname: '/', docToken: 'doc-A', rootChildren: 0, targetPresent: false, ...over };
}

/**
 * Drive a sequence the way the real poll loop does — carrying state forward and
 * advancing the clock by the poll interval — and return the first terminal
 * verdict with the poll index that produced it.
 *
 * Sequences are the whole point here. Every bug this classifier exists to catch
 * is a property of a TRANSITION, so a test that classifies single observations
 * in isolation would miss all of them.
 */
function run(
  observations: DocumentObservation[],
  intervalMs = 500,
): { verdict: MountVerdict; atPoll: number; state: MountProgress } {
  let state: MountProgress = { ...INITIAL_MOUNT_PROGRESS };
  let now = 1_000_000;
  for (let i = 0; i < observations.length; i += 1) {
    const step = classifyMountObservation(state, observations[i]!, now, CONFIG);
    state = step.state;
    if (step.verdict !== 'waiting') return { verdict: step.verdict, atPoll: i, state };
    now += intervalMs;
  }
  return { verdict: 'waiting', atPoll: observations.length - 1, state };
}

describe('classifyMountObservation', () => {
  it('reports mounted only when the target marker is present AND something rendered', () => {
    expect(run([obs({ targetPresent: true, rootChildren: 3 })]).verdict).toBe('mounted');
    // The marker alone is not enough: a stale/detached marker in an empty
    // document must not count as a mount.
    expect(run([obs({ targetPresent: true, rootChildren: 0 })]).verdict).toBe('waiting');
    expect(run([obs({ targetPresent: false, rootChildren: 10 })]).verdict).toBe('waiting');
  });

  it('keeps waiting through a normal progressive render', () => {
    expect(
      run([obs({ rootChildren: 0 }), obs({ rootChildren: 7 }), obs({ rootChildren: 8 })]).verdict,
    ).toBe('waiting');
  });

  describe('the run-6 fixture — a real recorded failure, replayed exactly', () => {
    /**
     * Verbatim from /tmp/perf-run6.log, spec [0-1], 2026-07-28T12:36:52–12:37:52Z:
     * #root goes 0 → 7 → 8 → 10 under document A over ~2s, holds 10 for 21 polls
     * (~10s), then document B appears with rootChildren -1 and stays for the
     * remaining 94 polls (~47s) until mocha killed the spec.
     *
     * This is the sequence that produced a bare `Error: Timeout` and no
     * diagnosis at all. Encoding the measurement itself — rather than a
     * hand-written approximation of it — is what makes this test evidence that
     * the classifier handles the real world, not a story about it.
     */
    const RUN_6: DocumentObservation[] = [
      obs({ docToken: 'doc-A', rootChildren: 0 }),
      obs({ docToken: 'doc-A', rootChildren: 0 }),
      obs({ docToken: 'doc-A', rootChildren: 7 }),
      obs({ docToken: 'doc-A', rootChildren: 7 }),
      obs({ docToken: 'doc-A', rootChildren: 8 }),
      obs({ docToken: 'doc-A', rootChildren: 8 }),
      ...Array.from({ length: 21 }, () => obs({ docToken: 'doc-A', rootChildren: 10 })),
      ...Array.from({ length: 94 }, () => obs({ docToken: 'doc-B', rootChildren: -1 })),
    ];

    it('calls the webview dead instead of waiting out the budget', () => {
      const { verdict, atPoll } = run(RUN_6);
      expect(verdict).toBe('documentDestroyed');
      // Death is declared 2s (4 polls at 500ms) into document B, i.e. ~13.5s
      // into a run that previously burned its entire 60s+ budget on this.
      expect(atPoll).toBe(31);
    });

    it('remembers WHICH document rendered, so the diagnosis can contrast them', () => {
      expect(run(RUN_6).state.renderedDocToken).toBe('doc-A');
    });

    it('is exactly the case the old predicate could not distinguish from a slow boot', () => {
      // The pre-fix predicate was "#root has children" with no document
      // identity: under it, every one of the 94 post-death polls is simply
      // "not ready yet" — indistinguishable from an app still booting.
      const oldPredicateSaysReady = RUN_6.map((o) => o.rootChildren > 0);
      expect(oldPredicateSaysReady.slice(-94).some(Boolean)).toBe(false);
    });
  });

  describe('documentDestroyed requires all three conditions', () => {
    const dead = () => obs({ docToken: 'doc-B', rootChildren: -1 });

    it('does not fire when no document ever rendered (a boot that never started)', () => {
      // Root absent from the very first poll, and never any render: this is a
      // slow/failed boot, which must remain a timeout — not a death.
      expect(run(Array.from({ length: 40 }, dead)).verdict).toBe('waiting');
    });

    it('does not fire while the document identity is unchanged', () => {
      // Same document losing its root is a different (and far stranger) bug;
      // it must not be reported as the webview having been replaced.
      const seq = [
        obs({ docToken: 'doc-A', rootChildren: 10 }),
        ...Array.from({ length: 40 }, () => obs({ docToken: 'doc-A', rootChildren: -1 })),
      ];
      expect(run(seq).verdict).toBe('waiting');
    });

    it('does not fire for a route change that re-renders into a fresh document', () => {
      // A new document that HAS a root is a navigation, not a death.
      const seq = [
        obs({ docToken: 'doc-A', rootChildren: 10 }),
        ...Array.from({ length: 40 }, () => obs({ docToken: 'doc-B', rootChildren: 2 })),
      ];
      expect(run(seq).verdict).toBe('waiting');
    });

    it('does not fire before the dwell elapses', () => {
      const seq = [obs({ docToken: 'doc-A', rootChildren: 10 }), dead(), dead()];
      expect(run(seq).verdict).toBe('waiting'); // 2 polls = 500ms < 2000ms dwell
    });

    it('resets the dwell when the document recovers', () => {
      // A flicker must not accumulate toward a death verdict across a recovery.
      const seq = [
        obs({ docToken: 'doc-A', rootChildren: 10 }),
        dead(),
        dead(),
        obs({ docToken: 'doc-A', rootChildren: 10 }),
        dead(),
        dead(),
      ];
      expect(run(seq).verdict).toBe('waiting');
    });

    it('still reports mounted if the replacement document recovers before the dwell', () => {
      // A webview that is replaced and then genuinely comes back is a recovery,
      // not a death: success outranks every failure reading, so a target that
      // is present RIGHT NOW wins regardless of the history behind it.
      const seq = [
        obs({ docToken: 'doc-A', rootChildren: 10 }),
        dead(),
        dead(),
        dead(),
        dead(),
        obs({ docToken: 'doc-B', rootChildren: 4, targetPresent: true }),
      ];
      expect(run(seq).verdict).toBe('mounted');
    });
  });

  describe('wrongScreen', () => {
    it('fires once a wrong-screen landing has settled', () => {
      const seq = Array.from({ length: 20 }, () => obs({ pathname: '/onboarding' }));
      const { verdict, atPoll } = run(seq);
      expect(verdict).toBe('wrongScreen');
      expect(atPoll).toBe(10); // 5000ms dwell / 500ms interval
    });

    it('does not fire for a redirect observed mid-flight', () => {
      const seq = [
        ...Array.from({ length: 4 }, () => obs({ pathname: '/onboarding' })),
        ...Array.from({ length: 4 }, () => obs({ pathname: '/' })),
      ];
      expect(run(seq).verdict).toBe('waiting');
    });

    it('yields to a mount on the same poll', () => {
      const seq = [obs({ pathname: '/onboarding', rootChildren: 5, targetPresent: true })];
      expect(run(seq).verdict).toBe('mounted');
    });

    it('reports death rather than wrong-screen when both could apply', () => {
      // A dead document reports whatever pathname it died on. Naming it
      // "wrong screen" would send the reader chasing a routing bug that does
      // not exist.
      const seq = [
        obs({ docToken: 'doc-A', pathname: '/onboarding', rootChildren: 10 }),
        ...Array.from({ length: 30 }, () =>
          obs({ docToken: 'doc-B', pathname: '/onboarding', rootChildren: -1 }),
        ),
      ];
      expect(run(seq).verdict).toBe('documentDestroyed');
    });
  });

  it('never mutates the state it is given', () => {
    const state = { ...INITIAL_MOUNT_PROGRESS };
    classifyMountObservation(state, obs({ rootChildren: 5 }), 1000, CONFIG);
    expect(state).toEqual(INITIAL_MOUNT_PROGRESS);
  });
});
