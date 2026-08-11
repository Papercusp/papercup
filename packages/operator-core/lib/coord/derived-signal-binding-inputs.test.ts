/**
 * P-001 — `inputs` MUST COUNT THE BINDING INPUT, NOT THE CANDIDATE POOL
 * (coupling-signal-liveness-and-lifecycle-2026-08-11, EI-20088486454213771).
 *
 * ── WHAT BROKE, AND WHY A UNIT TEST DID NOT CATCH IT ────────────────────────
 *
 * Both derived legs below are decided by a SELF-side precondition before any peer
 * is examined: `awaits` by the caller's own await key, `holds-a-lock-on` by the
 * caller's own held files. The census nonetheless counted the PEER POOL, so a run
 * that short-circuited published "armed, N inputs, 0 edges" — which reads as *we
 * compared N candidates and rejected them all*, a predicate-bug signature. The
 * live reading was 1023 inputs / 0 edges, and it sent three separate readings
 * hunting a phantom bug in correct code.
 *
 * Every existing census test passed throughout, because they assert the census
 * over HAND-BUILT leg states — which is precisely the blind spot: supplying
 * `{ armed: true, inputs: 3 }` by hand cannot discover that production computes
 * that 3 from the wrong set. So these cases drive the REAL `deriveCouplings` and
 * read the REAL verdict function, end to end.
 *
 * ── WHY THE ASSERTION IS A VERDICT, NEVER A FIELD ───────────────────────────
 *
 * P-001 requires this be guarded BEHAVIOURALLY: asserting `inputs === 0` would
 * restate the implementation and would still pass if the number stopped reaching
 * the human-visible verdict. What must hold is that a STARVED run and an
 * ARMED-AND-EMPTY run READ DIFFERENTLY to whoever reads the probe — so each case
 * composes census → `judgeSignalFiring`, the same predicate the shipped probe
 * uses, and the load-bearing assertions compare the two verdicts directly.
 *
 * The `firing` cases are CALIBRATION, not decoration: without them a mistake that
 * made every relation read `starved` would satisfy the inequality above and look
 * like a pass. They prove the pipeline can still reach the positive verdict.
 */
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS gate script, no .d.ts; imported for its predicate only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { CENSUS_VERSION, judgeSignalFiring } from '../../../../scripts/check-derived-signal-firings.mjs';
import { describe, expect, it } from 'vitest';
import { deriveCouplings } from './coupling-derivation';
import {
  DERIVED_SIGNAL_CENSUS_KEY,
  DERIVED_SIGNAL_CENSUS_VERSION,
  type DerivedSignalCensus,
} from './derived-signal-census';

const SELF = 'owner-self';

type Row = { ownerId: string; awaitingEventKey?: string | null };

/** A roster row; `awaitingEventKey` omitted means the caller awaits nothing. */
const row = (ownerId: string, awaitingEventKey: string | null = null): Row => ({ ownerId, awaitingEventKey });

/**
 * Drive the real derivation and return the verdict a reader would see for one
 * relation, over a window containing exactly this run.
 *
 * The counts mirror the shipped probe's aggregation (`runs`, runs where armed,
 * runs where inputs > 0, summed edges) so a verdict here means what it means in
 * production rather than in a shape invented for the test.
 */
async function verdictFor(
  relation: 'awaits' | 'holds-a-lock-on',
  rows: readonly Row[],
  held?: ReadonlyMap<string, readonly string[]>,
): Promise<string> {
  let census: DerivedSignalCensus | undefined;
  await deriveCouplings(SELF, rows, {
    observe: (c) => {
      census = c;
    },
    ...(held ? { heldFiles: async () => held } : {}),
  });
  const o = census?.relations?.[relation];
  expect(o, `census must emit every relation, including ${relation} at zero`).toBeDefined();
  return judgeSignalFiring({
    runs: 1,
    armedRuns: o!.armed ? 1 : 0,
    inputRuns: o!.inputs > 0 ? 1 : 0,
    edges: o!.edges,
    windowHadCensus: true,
  });
}

// The exact production shape: peers exist and are awaiting things, but the caller
// awaits nothing, so the comparison never runs. Pre-fix this censused
// inputs = <peer count> and read `armed-silent` — "evaluated, found nothing".
const starved = () => [row(SELF, null), row('peer-1', 'gate-a'), row('peer-2', 'gate-b'), row('peer-3', 'gate-c')];

describe('awaits — a short-circuited run must not read as an evaluated one', () => {
  // Caller IS awaiting, peers await other keys: genuinely evaluated, no match.
  const armedEmpty = () => [row(SELF, 'gate-mine'), row('peer-1', 'gate-a'), row('peer-2', 'gate-b')];

  it('reads starved when the caller awaits nothing, however many peers await', async () => {
    expect(await verdictFor('awaits', starved())).toBe('starved');
  });

  it('reads armed-silent when the caller awaits and no peer matches', async () => {
    expect(await verdictFor('awaits', armedEmpty())).toBe('armed-silent');
  });

  it('THE GUARD: starved and armed-and-empty read differently', async () => {
    // Both produce zero edges. If these two ever collapse to one verdict the
    // census has stopped being able to say which case a zero is — the whole
    // defect, restored. Asserted as an inequality so it fails on ANY collapse,
    // in either direction, not only on a return to the original wrong value.
    expect(await verdictFor('awaits', starved())).not.toBe(await verdictFor('awaits', armedEmpty()));
  });

  it('CALIBRATION: still reaches firing when a peer awaits the same key', async () => {
    const rows = [row(SELF, 'gate-mine'), row('peer-1', 'gate-mine'), row('peer-2', 'gate-b')];
    expect(await verdictFor('awaits', rows)).toBe('firing');
  });

  it('CONTROL: the pre-fix pool count really did read a starved run as armed-silent', async () => {
    // The deliberately-wrong rule, kept here PERMANENTLY rather than proven once
    // by mutating the source: a guard that has never been shown to fail is a
    // guard nobody has tested, and mutating shared source to prove it is unsafe
    // in this tree (the git-sync sweep can commit the mutant).
    //
    // This is what makes the inequality above load-bearing instead of decorative.
    // It reproduces the ACTUAL shipped defect — count the peer pool, ignore the
    // self-side precondition — and shows it collapsing the starved case onto the
    // armed-silent verdict, which is the misreading that cost three separate
    // investigations. If some future change made the two cases indistinguishable
    // again, THIS is the reading it would revert to.
    // The old rule, applied to the SAME rows the starved case above uses.
    const pooledInputs = starved().filter((r) => r.ownerId !== SELF).length;
    expect(pooledInputs, 'the control is vacuous unless the peer pool is non-empty').toBeGreaterThan(0);
    const oldVerdict = judgeSignalFiring({
      runs: 1,
      armedRuns: 1,
      inputRuns: pooledInputs > 0 ? 1 : 0,
      edges: 0,
      windowHadCensus: true,
    });
    expect(oldVerdict).toBe('armed-silent');
    // ...and the fixed pipeline must NOT agree with it on these very rows.
    expect(await verdictFor('awaits', starved())).not.toBe(oldVerdict);
  });
});

describe('holds-a-lock-on — a short-circuited run must not read as an evaluated one', () => {
  const roster = [row(SELF), row('peer-1'), row('peer-2')];

  it('reads starved when the caller holds nothing, however many peers hold', async () => {
    const held = new Map<string, readonly string[]>([
      ['peer-1', ['a.ts']],
      ['peer-2', ['b.ts']],
    ]);
    expect(await verdictFor('holds-a-lock-on', roster, held)).toBe('starved');
  });

  it('reads starved when ONLY the caller holds — its own entry is not a candidate', async () => {
    // The second, quieter half of the defect: `held` includes the caller's own
    // entry, so this censused inputs = 1 and read as a comparison that examined
    // something. There is no peer in the map at all.
    const held = new Map<string, readonly string[]>([[SELF, ['a.ts']]]);
    expect(await verdictFor('holds-a-lock-on', roster, held)).toBe('starved');
  });

  it('reads armed-silent when caller and peer both hold, but share no path', async () => {
    const held = new Map<string, readonly string[]>([
      [SELF, ['a.ts']],
      ['peer-1', ['b.ts']],
    ]);
    expect(await verdictFor('holds-a-lock-on', roster, held)).toBe('armed-silent');
  });

  it('THE GUARD: starved and armed-and-empty read differently', async () => {
    const starvedHeld = new Map<string, readonly string[]>([['peer-1', ['a.ts']]]);
    const armedEmptyHeld = new Map<string, readonly string[]>([
      [SELF, ['a.ts']],
      ['peer-1', ['b.ts']],
    ]);
    expect(await verdictFor('holds-a-lock-on', roster, starvedHeld)).not.toBe(
      await verdictFor('holds-a-lock-on', roster, armedEmptyHeld),
    );
  });

  it('CALIBRATION: still reaches firing on a genuinely shared path', async () => {
    const held = new Map<string, readonly string[]>([
      [SELF, ['a.ts']],
      ['peer-1', ['a.ts']],
    ]);
    expect(await verdictFor('holds-a-lock-on', roster, held)).toBe('firing');
  });
});

describe('the census key stays the one the probe reads', () => {
  it('is the key the shipped probe aggregates on', () => {
    // Cheap, but it is the seam that would silently orphan every verdict above:
    // a renamed key leaves the census writing rows the probe never sees, which
    // presents as every relation reading `no-data` rather than as an error.
    expect(DERIVED_SIGNAL_CENSUS_KEY).toBe('derivedSignals');
  });

  /**
   * The writer and the probe are in different languages and cannot import each
   * other's constants, so this pin is the only thing holding them together.
   *
   * It guards the failure the `v` tag exists for and did NOT catch on its own
   * first outing: P-001 REDEFINED `inputs` (candidate pool -> binding input) and
   * left the version at 1, so 279 rows carrying two different meanings of the
   * field became indistinguishable. A redefinition reds nothing by itself — that
   * is exactly why the version has to move with it, and why the probe filters on
   * it rather than trusting the 14-day window.
   */
  it('the probe interprets exactly the version the census writes', () => {
    expect(CENSUS_VERSION).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
  });

  it('CONTROL: the pin is a real comparison, not two references to one constant', () => {
    // Without this, the assertion above would still pass if someone "fixed" a
    // future mismatch by importing the same constant twice — which would pin the
    // two files to each other in name only.
    expect(DERIVED_SIGNAL_CENSUS_VERSION).toBe(2);
    expect(CENSUS_VERSION).toBe(2);
  });
});
