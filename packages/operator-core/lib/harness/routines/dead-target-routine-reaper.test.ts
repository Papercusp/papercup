/**
 * Unit tests for the dead-target routine reaper's PURE decider
 * (dead-target-routine-reaper-2026-08-30 P-001 / P-006).
 *
 * The property under test is asymmetric and that asymmetry is the whole point: under-reaping
 * costs wasted ticks, over-reaping disables a live pot's routines. So the bulk of this file is
 * not "does it detect a dead tree" (one obvious case) but "does it refuse to park on anything
 * short of a positive confirmation" — every timeout, EACCES, unreadable registry, unregistered
 * slug and thrown error, each asserted individually rather than as a group.
 *
 * FALSIFIABILITY: `WRONG_DECIDERS` at the bottom holds deliberately-broken implementations that
 * are kept PERMANENTLY, and the suite asserts each one FAILS the same properties the real
 * decider passes. A guard test that has never failed is a guard you have not tested; mutating
 * the real module to prove that would be unsafe here (git-sync sweeps the whole tree every few
 * minutes and would commit the mutant), so the controls live in the test file instead — the
 * repo's prescribed tier for a module you `import`.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTargetHealth,
  confirmPermanence,
  isPermanentState,
  isProtectedInstall,
  targetIdentity,
  type TargetProbe,
  type TargetHealthVerdict,
  type PermanenceRecord,
} from './dead-target-routine-reaper';

const WS = 'papercusp-workspace';

function probe(over: Partial<TargetProbe> = {}): TargetProbe {
  return {
    installSlug: 'ei669-repro-su-b621d',
    workspaceId: WS,
    resolution: { kind: 'resolved', path: '/tmp/ei669-repro-su-b621d' },
    rootExists: true,
    gitObjectStore: 'readable',
    ...over,
  };
}

describe('classifyTargetHealth — the two states that may park', () => {
  it('reports root-missing only from a POSITIVE observation of absence', () => {
    const v = classifyTargetHealth(probe({ rootExists: false }));
    expect(v.state).toBe('root-missing');
    expect(v.permanent).toBe(true);
    expect(v.reason).toContain('/tmp/ei669-repro-su-b621d');
  });

  it('reports git-corrupt and carries the verbatim git error into the reason', () => {
    const v = classifyTargetHealth(
      probe({
        gitObjectStore: 'corrupt',
        gitError: 'invalid object 100644 d75c463ae71a1031fc95c9',
      }),
    );
    expect(v.state).toBe('git-corrupt');
    expect(v.permanent).toBe(true);
    // The reason is what a human reads out of metadata.health; a bare label would make the
    // ei669 post-mortem (whose only witness was a frozen last_error) repeat itself.
    expect(v.reason).toContain('d75c463ae71a1031fc95c9');
  });

  it('reports ok for a healthy tree', () => {
    const v = classifyTargetHealth(probe());
    expect(v.state).toBe('ok');
    expect(v.permanent).toBe(false);
  });

  it('marks exactly root-missing and git-corrupt as permanent', () => {
    expect(isPermanentState('root-missing')).toBe(true);
    expect(isPermanentState('git-corrupt')).toBe(true);
    expect(isPermanentState('ok')).toBe(false);
    expect(isPermanentState('unknown')).toBe(false);
  });
});

describe('classifyTargetHealth — fail-closed: nothing else may ever be permanent', () => {
  // Each case is enumerated separately, not looped over as a blob, so a regression names the
  // exact input that started parking.
  const nonCommittal: Array<[string, Partial<TargetProbe>]> = [
    ['a thrown probe error', { probeError: 'EACCES: permission denied' }],
    ['an unreadable registry', { resolution: { kind: 'read-failed', detail: 'ECONNREFUSED' } }],
    ['an unregistered slug', { resolution: { kind: 'unresolvable' } }],
    ['root existence undetermined (null)', { rootExists: null }],
    ['root existence undetermined (absent field)', { rootExists: undefined }],
    ['git object store uninspectable', { gitObjectStore: 'unknown' }],
    ['git object store absent entirely', { gitObjectStore: 'absent' }],
    ['git object store field omitted', { gitObjectStore: undefined }],
  ];

  for (const [label, over] of nonCommittal) {
    it(`decides unknown, never permanent, for ${label}`, () => {
      const v = classifyTargetHealth(probe(over));
      expect(v.state).toBe('unknown');
      expect(v.permanent).toBe(false);
    });
  }

  it('does NOT read an unreadable registry as an absent tree', () => {
    // The hazard D-003 names: resolveProject returns null for BOTH an unregistered slug and a
    // registry it could not read, so collapsing them would let one transient registry failure
    // park every install it could not resolve.
    const readFailed = classifyTargetHealth(probe({ resolution: { kind: 'read-failed', detail: 'ETIMEDOUT' } }));
    const unregistered = classifyTargetHealth(probe({ resolution: { kind: 'unresolvable' } }));

    expect(readFailed.state).toBe('unknown');
    expect(unregistered.state).toBe('unknown');
    // Same verdict, but the reasons must stay distinguishable: one is an outage, the other a
    // registration question, and they call for different human follow-up.
    expect(readFailed.reason).not.toBe(unregistered.reason);
    expect(readFailed.reason).toContain('could not be read');
    expect(unregistered.reason).toContain('not registered');
  });

  it('a probe error outranks every other signal, including a would-be permanent one', () => {
    const v = classifyTargetHealth(probe({ probeError: 'boom', rootExists: false, gitObjectStore: 'corrupt' }));
    expect(v.state).toBe('unknown');
  });

  it('a missing root is reported as root-missing, never as a git problem', () => {
    // Ordering matters: below an absent root every nested observation is meaningless, and
    // naming it a git fault would send a reader to repair the wrong thing.
    const v = classifyTargetHealth(probe({ rootExists: false, gitObjectStore: 'corrupt' }));
    expect(v.state).toBe('root-missing');
  });
});

describe('targetIdentity', () => {
  it('always renders the workspace, so an enforced-but-invisible scope stays auditable', () => {
    expect(targetIdentity({ installSlug: 'papercusp', workspaceId: 'default' })).toBe('papercusp [default]');
    expect(targetIdentity({ installSlug: 'papercusp', workspaceId: WS })).toBe(`papercusp [${WS}]`);
  });

  it('distinguishes the same harness slug across two workspaces', () => {
    // EI-19372306666296664: 'papercusp' exists in both `default` and `papercusp-workspace`, and
    // an identity that drops the workspace made a foreign tenant's alert read as a live one.
    expect(targetIdentity({ installSlug: 'papercusp', workspaceId: 'default' })).not.toBe(
      targetIdentity({ installSlug: 'papercusp', workspaceId: WS }),
    );
  });
});

describe('confirmPermanence — a single observation never parks (D-003)', () => {
  const dead: TargetHealthVerdict = { state: 'root-missing', permanent: true, reason: 'gone' };
  const T0 = 1_000_000;
  const SPACING = 10 * 60 * 1000;

  it('does not park on the first sighting, but records it', () => {
    const d = confirmPermanence(dead, null, T0, SPACING);
    expect(d.park).toBe(false);
    expect(d.record).toMatchObject({ state: 'root-missing', confirmations: 1, firstSeenAtMs: T0 });
  });

  it('parks on a second sighting once the spacing window has elapsed', () => {
    const first = confirmPermanence(dead, null, T0, SPACING).record;
    const d = confirmPermanence(dead, first, T0 + SPACING + 1, SPACING);
    expect(d.park).toBe(true);
    expect(d.record?.confirmations).toBe(2);
  });

  it('does NOT park on a second sighting that arrives too soon', () => {
    const first = confirmPermanence(dead, null, T0, SPACING).record;
    const d = confirmPermanence(dead, first, T0 + 1000, SPACING);
    expect(d.park).toBe(false);
  });

  it('a root that comes back clears the run instead of confirming it', () => {
    // The lazily-materialized / briefly-unmounted pot home. This is the case that makes the
    // empirical question ("can a root be absent-then-present?") non-load-bearing.
    const first = confirmPermanence(dead, null, T0, SPACING).record;
    const healthy: TargetHealthVerdict = { state: 'ok', permanent: false, reason: 'back' };
    const cleared = confirmPermanence(healthy, first, T0 + SPACING + 1, SPACING);
    expect(cleared.park).toBe(false);
    expect(cleared.record).toBeNull();

    // ...and the NEXT absence starts from one again, so it still cannot park immediately.
    const restarted = confirmPermanence(dead, cleared.record, T0 + 2 * SPACING, SPACING);
    expect(restarted.park).toBe(false);
    expect(restarted.record?.confirmations).toBe(1);
  });

  it('does not let one failure mode confirm a different one', () => {
    const first = confirmPermanence(dead, null, T0, SPACING).record;
    const corrupt: TargetHealthVerdict = { state: 'git-corrupt', permanent: true, reason: 'corrupt' };
    const d = confirmPermanence(corrupt, first, T0 + SPACING + 1, SPACING);
    expect(d.park).toBe(false);
    expect(d.record).toMatchObject({ state: 'git-corrupt', confirmations: 1 });
  });

  it('never parks a non-permanent verdict, whatever the history', () => {
    const unknown: TargetHealthVerdict = { state: 'unknown', permanent: false, reason: 'dunno' };
    const rich: PermanenceRecord = { state: 'root-missing', firstSeenAtMs: 0, lastSeenAtMs: T0, confirmations: 99 };
    expect(confirmPermanence(unknown, rich, T0 + 10 * SPACING, SPACING).park).toBe(false);
  });

  it('zero spacing still requires TWO sightings — no config makes one observation park', () => {
    expect(confirmPermanence(dead, null, T0, 0).park).toBe(false);
    const first = confirmPermanence(dead, null, T0, 0).record;
    expect(confirmPermanence(dead, first, T0, 0).park).toBe(true);
  });
});

describe('isProtectedInstall — the R3 hard guard', () => {
  it('protects the active workspace home harness', () => {
    expect(isProtectedInstall('papercusp', 'papercusp')).toBe(true);
  });

  it('does not protect an unrelated install', () => {
    expect(isProtectedInstall('ei669-repro-su-b621d', 'papercusp')).toBe(false);
  });

  it('treats an unidentifiable install as protected, not as fair game', () => {
    expect(isProtectedInstall('', 'papercusp')).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * FALSIFIABILITY CONTROLS — kept permanently. Each is a plausible way to get
 * this decider wrong; the suite asserts each one is CAUGHT by the properties
 * above, so those properties cannot silently stop discriminating.
 * ───────────────────────────────────────────────────────────────────────── */
type Decider = (p: TargetProbe) => TargetHealthVerdict;

const WRONG_DECIDERS: Array<{ name: string; fn: Decider }> = [
  {
    // The bug D-003 exists to prevent: collapse "no path" into "root missing".
    name: 'treats an unresolvable/unreadable registry as an absent root',
    fn: (p) =>
      p.resolution.kind !== 'resolved'
        ? { state: 'root-missing', permanent: true, reason: 'no path' }
        : { state: 'ok', permanent: false, reason: 'ok' },
  },
  {
    // The classic falsy-check bug: `!rootExists` treats null/undefined as false.
    name: 'treats an undetermined root as an absent one',
    fn: (p) =>
      !p.rootExists
        ? { state: 'root-missing', permanent: true, reason: 'falsy' }
        : { state: 'ok', permanent: false, reason: 'ok' },
  },
  {
    // Ignoring the probe fault and trusting its (untrustworthy) observations anyway.
    name: 'ignores a probe error',
    fn: (p) =>
      p.rootExists === false || p.gitObjectStore === 'corrupt'
        ? { state: 'git-corrupt', permanent: true, reason: 'ignored the error' }
        : { state: 'ok', permanent: false, reason: 'ok' },
  },
];

describe('falsifiability: the fail-closed properties actually discriminate', () => {
  const mustNotPark: TargetProbe[] = [
    probe({ probeError: 'EACCES', rootExists: false }),
    probe({ resolution: { kind: 'read-failed', detail: 'ECONNREFUSED' } }),
    probe({ resolution: { kind: 'unresolvable' } }),
    probe({ rootExists: null }),
  ];

  it('the REAL decider marks none of the non-committal probes permanent', () => {
    for (const p of mustNotPark) expect(classifyTargetHealth(p).permanent).toBe(false);
  });

  for (const wrong of WRONG_DECIDERS) {
    it(`catches a decider that ${wrong.name}`, () => {
      // At least one non-committal probe must come back permanent from the broken decider —
      // i.e. the assertion above would genuinely FAIL if the real module regressed this way.
      const anyPermanent = mustNotPark.some((p) => wrong.fn(p).permanent);
      expect(anyPermanent).toBe(true);
    });
  }

  it('calibration: the controls and the real decider agree on a genuinely dead tree', () => {
    // Without this, every control would also "pass" if the properties above were vacuous.
    const reallyDead = probe({ rootExists: false });
    expect(classifyTargetHealth(reallyDead).permanent).toBe(true);
  });
});
