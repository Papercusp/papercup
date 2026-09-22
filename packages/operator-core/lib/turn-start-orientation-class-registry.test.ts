/**
 * ORIENTATION_CLASS_REGISTRY — the DECLARATION contract (plan item P-023).
 *
 * WHAT THIS GUARDS THAT `turn-start-orientation-class-coverage.test.ts` CANNOT.
 *
 * The coverage guard asserts that every declared class is PRESENT in the
 * rendered surface. Presence is order-blind, so all 32 of its assertions stay
 * green while the emitted lines are in a completely different sequence. That is
 * the exact hazard P-023's extraction created, and it is why this file exists:
 *
 * `renderOrientationLines` was never one block per category. `held` emits at
 * FOUR distinct priorities (stale checkpoints, missing checkpoints, the holding
 * line, checkpoint excerpts) and `loopArmed` at TWO (the not-armed WARNING near
 * the top, the reassuring ARMED line last), interleaved with other categories.
 * So a registry keyed one-entry-per-category cannot reproduce the emitted
 * order, and a plain `Record<>` scrambles it SILENTLY. The `order` field on each
 * segment is what preserves it — and an `order` nobody asserts is a comment.
 *
 * Scope note (D-028): P-023 is the MECHANISM only. These tests therefore assert
 * the registry's own contract — one entry per field, total order, sink
 * selection, watermark claims — and deliberately do NOT pin the current sink
 * POPULATION, because P-024 / P-025 are supposed to add leader-brief and
 * carry-brief classes and must not have to edit this file to do it.
 *
 * Every test here is fixture-free: it reads declarations, not a hand-built
 * `OrientationState`. Where a state IS needed it is the minimal one, and the
 * test carries a calibration assertion so it cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest';

// Deliberately imported through the SEAM (the sink-neutral path P-024 / P-025
// will use), not from `turn-start-orientation` directly — so these tests also
// prove the seam resolves and re-exports the live binding. `fingerprintOrientation`
// / `renderOrientationLines` / `OrientationState` are turn-start's own surface and
// are NOT re-exported, so they come from the module itself.
import {
  ORIENTATION_CLASS_REGISTRY,
  selectOrientationSegments,
  type OrientationSink,
  type RegisteredOrientationClass,
} from './orientation-class-registry';
import {
  ORIENTATION_CLASS_REGISTRY as REGISTRY_VIA_OWNING_MODULE,
  fingerprintOrientation,
  renderOrientationLines,
  type OrientationState,
} from './turn-start-orientation';

/**
 * COMPILE-TIME EXHAUSTIVENESS, not a hand-listed copy.
 *
 * `Record<keyof OrientationState, true>` requires EVERY field and rejects any
 * key that is not one, so `lint:tsc` fails the moment a field is added to or
 * removed from `OrientationState` without this literal being updated with it.
 * The runtime assertion below then compares that compiler-checked set against
 * the registry's ids — which is what makes "one entry per field" a derived
 * claim rather than two copies of a list that drift apart.
 *
 * ⚠ vitest transforms via esbuild and does NOT typecheck, so the compile-time
 * half of this guard only fires under `lint:tsc`. A green run of this file says
 * nothing about it.
 */
const EVERY_ORIENTATION_STATE_FIELD: Record<keyof OrientationState, true> = {
  held: true,
  ownerDirectives: true,
  historyUpdates: true,
  effortUpdates: true,
  unansweredDirected: true,
  unansweredStale: true,
  inboxRecent: true,
  openAsks: true,
  announcedGates: true,
  loopArmed: true,
  loopFireWithheld: true,
  improvementTriage: true,
  executableFrontier: true,
  obligations: true,
  neverDropFacts: true,
  toolSurface: true,
  carryBlindWindow: true,
  openChecks: true,
};

/** The optional fields are omitted on purpose — `undefined` is a real input. */
const MINIMAL_STATE: OrientationState = {
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  loopArmed: false,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

const ALL_SINKS: readonly OrientationSink[] = ['turn-start', 'leader-brief', 'carry-brief'];

/** Every (order, class id) pair the turn-start sink emits, in emitted sequence. */
function emittedOrderOfTurnStart(): [number, string][] {
  return ORIENTATION_CLASS_REGISTRY.flatMap((entry) =>
    entry.applicableSinks.includes('turn-start')
      ? entry.segments.map((segment): [number, string] => [segment.order, String(entry.id)])
      : [],
  ).sort((a, b) => a[0] - b[0]);
}

describe('ORIENTATION_CLASS_REGISTRY — declaration integrity', () => {
  it('is re-exported by the sink-neutral seam as the SAME binding, not a copy', () => {
    // A re-export that had drifted into a second array — or a seam that got
    // "helpfully" rewritten to build its own registry — would still satisfy a
    // deep-equality check while giving the other sinks a divergent declaration.
    // Identity is the property that matters, so identity is what is asserted.
    expect(ORIENTATION_CLASS_REGISTRY).toBe(REGISTRY_VIA_OWNING_MODULE);
  });

  it('declares exactly one entry per OrientationState field', () => {
    const declared = ORIENTATION_CLASS_REGISTRY.map((entry) => String(entry.id)).sort();
    const fields = Object.keys(EVERY_ORIENTATION_STATE_FIELD).sort();

    // Calibration: a registry that silently emptied would satisfy a subset
    // check, so assert the population is real before comparing.
    expect(declared.length).toBeGreaterThan(10);
    expect(declared).toEqual(fields);
    expect(new Set(declared).size).toBe(declared.length); // no field claimed twice
  });

  it('gives every segment a unique order, so the emitted sequence is total and stable', () => {
    const orders = ORIENTATION_CLASS_REGISTRY.flatMap((entry) =>
      entry.segments.map((segment) => segment.order),
    );

    expect(orders.length).toBeGreaterThan(ORIENTATION_CLASS_REGISTRY.length); // multi-segment classes exist
    expect(new Set(orders).size).toBe(orders.length);
    // A duplicated order would make `sort` non-deterministic between engines,
    // which is the failure this asserts away rather than merely documents.
  });

  it('declares at least one real sink for every class', () => {
    for (const entry of ORIENTATION_CLASS_REGISTRY) {
      expect(entry.applicableSinks.length, `${String(entry.id)} declares no sink`).toBeGreaterThan(0);
      for (const sink of entry.applicableSinks) {
        expect(ALL_SINKS, `${String(entry.id)} declares unknown sink ${sink}`).toContain(sink);
      }
    }
  });

  it('declares an unrenderedReason exactly when a class contributes no segments', () => {
    const unrendered = ORIENTATION_CLASS_REGISTRY.filter((entry) => entry.segments.length === 0);

    // Calibration: if every class rendered, this test would pass while asserting
    // nothing. There are deliberately-unrendered classes (P-017 retired the
    // improvement-triage row), so an empty set here means the premise moved.
    expect(unrendered.length).toBeGreaterThan(0);

    for (const entry of ORIENTATION_CLASS_REGISTRY) {
      const hasReason = typeof entry.unrenderedReason === 'string' && entry.unrenderedReason.length > 0;
      expect(hasReason, `${String(entry.id)}: unrenderedReason must be present iff it renders nothing`).toBe(
        entry.segments.length === 0,
      );
    }
  });
});

describe('emitted priority order — the contract the coverage guard cannot assert', () => {
  /**
   * PINNED INDEPENDENTLY of the registry's own declaration order, so moving an
   * `order:` value — or re-homing a segment onto another class — fails here.
   * This literal IS the priority rule: a directed message awaiting your answer
   * outranks your own work, and the no-wake-source warning precedes it all
   * because an agent that cannot be re-woken silently halts.
   */
  const EXPECTED_TURN_START_ORDER: [number, string][] = [
    [10, 'toolSurface'],
    [20, 'ownerDirectives'],
    [30, 'carryBlindWindow'],
    // P-010 (WI-10002221): deliberately at 35, directly after carryBlindWindow —
    // it shares that class's decay property and worsens it, because a carried
    // FALSE claim is acted on at the agent's first action of the turn.
    [35, 'openChecks'],
    [40, 'historyUpdates'],
    [50, 'effortUpdates'],
    [60, 'unansweredDirected'],
    [70, 'unansweredStale'],
    [80, 'openAsks'],
    [90, 'loopArmed'],
    [100, 'held'],
    [110, 'held'],
    [120, 'obligations'],
    [130, 'neverDropFacts'],
    [140, 'executableFrontier'],
    [150, 'held'],
    [160, 'announcedGates'],
    [170, 'held'],
    [180, 'inboxRecent'],
    [190, 'loopArmed'],
  ];

  it('pins the turn-start segment order to its declared priority sequence', () => {
    expect(emittedOrderOfTurnStart()).toEqual(EXPECTED_TURN_START_ORDER);
  });

  /**
   * PERMANENT CONTROL — proves the pin above is order-SENSITIVE.
   *
   * `toEqual` on an array of tuples compares positionally, but a green run
   * cannot show that: a pin that had degenerated into a set/length comparison
   * looks identical when it passes. So the two mutations this guard exists to
   * catch are applied here to a COPY of the derived data and asserted to fail.
   *
   * This is the falsifiability evidence for the order contract, and it is the
   * tier that suits an imported module: a deliberately-wrong value kept
   * permanently in the test, never a mutation of the shared source file (which
   * on this swept checkout can be committed by git-sync mid-probe).
   */
  it('would catch a reorder and a re-homed segment (permanent control)', () => {
    const truth = emittedOrderOfTurnStart();

    // MUTATION 1 — two segments swapped. Same set, same length, wrong sequence.
    const reordered = truth.slice();
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(reordered).not.toEqual(EXPECTED_TURN_START_ORDER);
    expect(reordered.map(([order]) => order).sort((a, b) => a - b)).toEqual(
      truth.map(([order]) => order),
    ); // the mutation is invisible to an order-blind check — that is the point

    // MUTATION 2 — one segment re-homed onto another class at the same order.
    const rehomed = truth.map(([order, id], index): [number, string] =>
      index === 0 ? [order, 'inboxRecent'] : [order, id],
    );
    expect(rehomed).not.toEqual(EXPECTED_TURN_START_ORDER);

    // CALIBRATION — the unmutated data still matches, so a failure above is the
    // mutation and not a stale pin.
    expect(truth).toEqual(EXPECTED_TURN_START_ORDER);
  });

  it('keeps the interleavings that a one-entry-per-category registry would destroy', () => {
    const emitted = emittedOrderOfTurnStart();
    const positionsOf = (id: string) =>
      emitted.reduce<number[]>((acc, [, entryId], index) => (entryId === id ? [...acc, index] : acc), []);

    const held = positionsOf('held');
    const loop = positionsOf('loopArmed');

    // `held` at FOUR priorities and `loopArmed` at TWO — the specific shape that
    // makes a category-keyed registry unable to reproduce the emitted order.
    expect(held).toHaveLength(4);
    expect(loop).toHaveLength(2);

    // Both are INTERLEAVED, not contiguous: something else emits between them.
    expect(held[held.length - 1] - held[0]).toBeGreaterThan(held.length - 1);
    expect(loop[1] - loop[0]).toBeGreaterThan(1);

    // The playbook's own rule: a directed message awaiting your answer outranks
    // your own work, so it precedes every `held` emission.
    const unanswered = positionsOf('unansweredDirected')[0];
    expect(unanswered).toBeLessThan(held[0]);

    // The not-armed WARNING precedes the work; the reassuring ARMED line is last.
    expect(loop[0]).toBeLessThan(held[0]);
    expect(loop[1]).toBe(emitted.length - 1);
  });

  it('routes every rendered line through the registry — no bespoke line escapes it', () => {
    const viaRegistry = selectOrientationSegments('turn-start').flatMap((segment) =>
      segment.render(MINIMAL_STATE, null),
    );
    const viaRenderer = renderOrientationLines(MINIMAL_STATE, null);

    // Calibration: with `loopArmed: false` the no-wake-source warning fires, so
    // this comparison is over a NON-EMPTY surface. Two empty arrays would be
    // equal while proving nothing.
    expect(viaRenderer.length).toBeGreaterThan(0);
    expect(viaRenderer).toEqual(viaRegistry);
    // A line appended directly inside `renderOrientationLines` — the regression
    // back toward the 155-line body this item deleted — fails here.
  });
});

describe('watermark tokens are pinned to the real cursor keys', () => {
  it('claims every fingerprint key except epoch, exactly once', () => {
    const cursorKeys = Object.keys(fingerprintOrientation(MINIMAL_STATE, 1, null));
    const claimed = ORIENTATION_CLASS_REGISTRY.flatMap((entry) => [...entry.watermarkTokens]);

    // Every declared token is a REAL cursor key — a typo'd token would silently
    // watermark nothing, which is invisible at runtime.
    for (const token of claimed) {
      expect(cursorKeys, `watermark token '${token}' is not a fingerprintOrientation key`).toContain(token);
    }

    // No key is claimed by two classes: a shared token means one class's change
    // re-emits the block for another's signal.
    expect(new Set(claimed).size).toBe(claimed.length);

    // `epoch` is deliberately unclaimed: it is the context-generation bump, not
    // a class's own signal. Every OTHER key belongs to exactly one class.
    const unclaimed = cursorKeys.filter((key) => !claimed.includes(key));
    expect(unclaimed).toEqual(['epoch']);
  });

  it('emits a cursor whose key set does not depend on the state values', () => {
    const minimal = Object.keys(fingerprintOrientation(MINIMAL_STATE, 1, null)).sort();
    const populated = Object.keys(
      fingerprintOrientation(
        { ...MINIMAL_STATE, loopArmed: true, unansweredDirected: 3, neverDropFacts: ['wall:x'] },
        2,
        null,
      ),
    ).sort();

    expect(minimal.length).toBeGreaterThan(10); // calibration
    expect(populated).toEqual(minimal);
    // The token-claim assertion above reads the key set from ONE state; this is
    // what makes that reading a statement about the cursor rather than about
    // the fixture it happened to use.
  });
});

describe('selectOrientationSegments — the sink mechanism, falsifiably', () => {
  const syntheticClass = (
    id: keyof OrientationState,
    order: number,
    sinks: readonly OrientationSink[],
    line: string,
  ): RegisteredOrientationClass => ({
    id,
    watermarkTokens: [],
    applicableSinks: sinks,
    segments: [{ order, render: () => [line] }],
  });

  it('selects a class for its declared sink and excludes it from every other', () => {
    const registry: RegisteredOrientationClass[] = [
      syntheticClass('held', 10, ['leader-brief'], 'leader-only'),
      syntheticClass('openAsks', 20, ['turn-start'], 'turn-start-only'),
    ];

    const render = (sink: OrientationSink) =>
      selectOrientationSegments(sink, registry).flatMap((segment) => segment.render(MINIMAL_STATE, null));

    // FALSIFIER: the declaration is load-bearing — each entry reaches exactly
    // the sink it names.
    expect(render('leader-brief')).toEqual(['leader-only']);
    expect(render('turn-start')).toEqual(['turn-start-only']);

    // CONTROL: a sink no entry declares selects nothing. This is what proves the
    // two results above come from the `applicableSinks` filter and not from the
    // selector returning everything it is given.
    expect(render('carry-brief')).toEqual([]);
  });

  it('orders the selection by declared order, not by registry position', () => {
    const registry: RegisteredOrientationClass[] = [
      syntheticClass('held', 99, ['turn-start'], 'last'),
      syntheticClass('openAsks', 1, ['turn-start'], 'first'),
    ];

    const lines = selectOrientationSegments('turn-start', registry).flatMap((segment) =>
      segment.render(MINIMAL_STATE, null),
    );

    // Declared LAST in the array, declared FIRST by order — so an implementation
    // that preserved array position instead of sorting fails here.
    expect(lines).toEqual(['first', 'last']);
  });

  it('does not mutate the registry it is given', () => {
    const registry: RegisteredOrientationClass[] = [
      syntheticClass('held', 99, ['turn-start'], 'last'),
      syntheticClass('openAsks', 1, ['turn-start'], 'first'),
    ];
    const positionsBefore = registry.map((entry) => String(entry.id));

    selectOrientationSegments('turn-start', registry);

    // The selector sorts, and sorting in place would reorder a caller's own
    // registry as a side effect of reading it.
    expect(registry.map((entry) => String(entry.id))).toEqual(positionsBefore);
  });
});
