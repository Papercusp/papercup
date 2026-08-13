/**
 * Guards for the reflect-direction sweep's decision rail
 * (reflect-orphaned-plan-items.ts, EI-18713141708830049).
 *
 * The sweep WRITES plan-item status, and a wrong flip silently marks a live
 * defect fixed — so the interesting assertions here are the REFUSALS, not the
 * happy path. Every refusal branch gets a case, and the happy path is kept as a
 * permanent positive control: without it, a `decideReflectFlip` that regressed
 * to "never flip" would satisfy every other test in this file.
 */
import { describe, it, expect } from 'vitest';
import { decideReflectFlip, DEFAULT_REFLECT_SWEEP_CAP } from './reflect-orphaned-plan-items';

describe('decideReflectFlip', () => {
  it('POSITIVE CONTROL: flips when every linked work-item is terminal and one is done', () => {
    // Guards against a regression to "never flip", which would silently turn
    // this whole sweep into a no-op while every refusal test below still passed.
    expect(decideReflectFlip({ linked: 2, doneLike: 2, terminal: 2, liveProgress: 0 })).toEqual({
      flip: true,
      to: 'done',
    });
  });

  it('refuses a plan item with no linked work-items at all', () => {
    // Nothing links it, so nothing licenses an opinion about whether it is done.
    expect(decideReflectFlip({ linked: 0, doneLike: 0, terminal: 0, liveProgress: 0 })).toEqual({
      flip: false,
      reason: 'no-links',
    });
  });

  it('refuses while ANY linked work-item is still non-terminal', () => {
    // The core safety rail: one open sibling means the plan item is legitimately
    // still open, however many of its siblings finished.
    expect(decideReflectFlip({ linked: 3, doneLike: 2, terminal: 2, liveProgress: 0 })).toEqual({
      flip: false,
      reason: 'live-sibling',
    });
  });

  it('reports in-flight progress as the reason, in preference to the coarser live-sibling', () => {
    // liveProgress > 0 always implies a non-terminal sibling, so both branches
    // match; the more specific (and more actionable) reason must win.
    expect(decideReflectFlip({ linked: 2, doneLike: 1, terminal: 1, liveProgress: 1 })).toEqual({
      flip: false,
      reason: 'in-flight-progress',
    });
  });

  it('refuses when every link is terminal but NONE is done-like', () => {
    // All siblings dropped/deprecated: the work was abandoned, not completed —
    // reflecting `done` here would assert a fix that never landed.
    expect(decideReflectFlip({ linked: 2, doneLike: 0, terminal: 2, liveProgress: 0 })).toEqual({
      flip: false,
      reason: 'no-done-link',
    });
  });

  it('flips on a mix of done and dropped siblings — a dropped sibling must not un-finish real work', () => {
    // EI-20129670928216719's class, in the reflect direction: dropping a
    // follow-on work-item must never erase the completion a different work-item
    // actually delivered. One done-like sibling is enough.
    expect(decideReflectFlip({ linked: 3, doneLike: 1, terminal: 3, liveProgress: 0 })).toEqual({
      flip: true,
      to: 'done',
    });
  });

  it('is total over the tallies the sweep can produce (never throws, always decides)', () => {
    for (const linked of [0, 1, 5]) {
      for (const doneLike of [0, 1, 5]) {
        for (const terminal of [0, 1, 5]) {
          for (const liveProgress of [0, 1, 5]) {
            const d = decideReflectFlip({ linked, doneLike, terminal, liveProgress });
            expect(typeof d.flip).toBe('boolean');
            if (!d.flip) expect(typeof d.reason).toBe('string');
          }
        }
      }
    }
  });

  /**
   * FALSIFIABILITY CONTROL. A guard that has never failed is a guard nobody has
   * tested — but proving it by mutating the real module in this shared tree is
   * unsafe (git-sync commits the whole tree on a schedule, so a probe window can
   * be committed even when nothing goes wrong). So the two ways this decision
   * could plausibly rot are kept here as permanent local implementations, and
   * the same case table is replayed against them: each MUST fail it.
   */
  it('the case table above actually discriminates — both degenerate impls fail it', () => {
    const table: Array<{ t: Parameters<typeof decideReflectFlip>[0]; flips: boolean }> = [
      { t: { linked: 2, doneLike: 2, terminal: 2, liveProgress: 0 }, flips: true },
      { t: { linked: 3, doneLike: 1, terminal: 3, liveProgress: 0 }, flips: true },
      { t: { linked: 0, doneLike: 0, terminal: 0, liveProgress: 0 }, flips: false },
      { t: { linked: 3, doneLike: 2, terminal: 2, liveProgress: 0 }, flips: false },
      { t: { linked: 2, doneLike: 1, terminal: 1, liveProgress: 1 }, flips: false },
      { t: { linked: 2, doneLike: 0, terminal: 2, liveProgress: 0 }, flips: false },
    ];

    // The REAL subject must satisfy the whole table (calibration).
    for (const { t, flips } of table) expect(decideReflectFlip(t).flip).toBe(flips);

    // "always flip" — the sweep rubber-stamping every candidate, the failure
    // mode that would mass-close live plan items.
    const alwaysFlip = () => ({ flip: true as const, to: 'done' as const });
    // "never flip" — the sweep silently regressing to a no-op, which no refusal
    // test alone can detect.
    const neverFlip = () => ({ flip: false as const, reason: 'no-links' as const });

    for (const wrong of [alwaysFlip, neverFlip]) {
      const disagreements = table.filter(({ t, flips }) => wrong().flip !== flips).length;
      expect(disagreements).toBeGreaterThan(0);
    }
  });

  it('exposes a positive, finite default candidate cap', () => {
    expect(DEFAULT_REFLECT_SWEEP_CAP).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_REFLECT_SWEEP_CAP)).toBe(true);
  });
});
