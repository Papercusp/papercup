/**
 * set-status.block-attribution-guard.test.ts — the ATTRIBUTED CLEAR guard
 * (deterministic-plan-state-derivation-2026-08-31 P-001 / D-001).
 *
 * The guard exists because `setStatusArgs` in plan-items/reflect-rules.ts sets
 * `onlyIfNotBlocked` on every reflection, and set-status SKIPS an already-blocked item
 * under that flag — so a plan item parked by a work-item blocker could never be un-parked
 * by that blocker clearing. `onlyIfBlockAttributedTo` is the narrow opening: exactly one
 * work-item may lift the block it is itself responsible for.
 *
 * Both halves are tested here as pure functions. The sibling-coverage half
 * (`blocked_coverage_guard`, which needs a linked-work-item lookup) is exercised in
 * set-status.coverage-guard.test.ts alongside the other coverage guards.
 *
 * FALSIFIABILITY. Per CLAUDE.md's guard discipline the negative controls live here
 * permanently rather than being produced by mutating the tree: every `toBe(true)` case
 * below is a skip the guard MUST produce, and each has a mirrored `toBe(false)` case that
 * differs in exactly one field. If the predicate degrades to a constant, one side fails.
 */
import { describe, expect, it } from 'vitest';
import { blockAttributionTrips, noteAttributesBlockTo, flipStatusInBody, NOTE_MARKER_RE } from './set-status';

const WI = 'WI-1733069';
const OTHER = 'WI-999';
/** The note shape `setStatusArgs` renders for the park direction: `← <id> <status> (…)`. */
const blockedNote = (id: string) => `Do the thing — note: ← ${id} blocked (1 external blocker)`;

describe('noteAttributesBlockTo — does the LIVE note attribute this block to this work-item?', () => {
  it('accepts a note naming this work-item together with a block word', () => {
    expect(noteAttributesBlockTo(blockedNote(WI), WI)).toBe(true);
    expect(noteAttributesBlockTo(`x — note: ← ${WI} needs-human (owner decision)`, WI)).toBe(true);
  });

  it('is case-insensitive on the work-item id', () => {
    expect(noteAttributesBlockTo(blockedNote(WI.toLowerCase()), WI)).toBe(true);
    expect(noteAttributesBlockTo(blockedNote(WI), WI.toLowerCase())).toBe(true);
  });

  // The controls. Each differs from an accepted case in ONE respect.
  it('rejects a note attributing the block to a DIFFERENT work-item', () => {
    expect(noteAttributesBlockTo(blockedNote(OTHER), WI)).toBe(false);
  });

  it('rejects an item with no injected note at all', () => {
    expect(noteAttributesBlockTo('Do the thing', WI)).toBe(false);
    expect(noteAttributesBlockTo(undefined, WI)).toBe(false);
    expect(noteAttributesBlockTo('', WI)).toBe(false);
  });

  it('rejects a note that names this work-item WITHOUT a block word', () => {
    // The completion annotation names the same id — attribution must not confuse
    // "this work-item finished the item" with "this work-item is blocking it".
    expect(noteAttributesBlockTo(`x — note: ← ${WI} completed (done)`, WI)).toBe(false);
  });

  it('ignores a block word that appears OUTSIDE the note (in the item prose)', () => {
    // The item text legitimately talks about blocking; only the note carries attribution.
    expect(noteAttributesBlockTo(`Fix the blocked-lane bug for ${WI}`, WI)).toBe(false);
  });
});

describe('blockAttributionTrips — skip the clear when the block is not ours to lift', () => {
  const base = { currentStatus: 'blocked', nextStatus: 'todo', currentItemText: blockedNote(WI) };

  it('does not engage at all when the caller did not opt in', () => {
    expect(blockAttributionTrips({ ...base, onlyIfBlockAttributedTo: undefined })).toBe(false);
  });

  it('PERMITS the clear when the live note attributes the block to this work-item', () => {
    expect(blockAttributionTrips({ ...base, onlyIfBlockAttributedTo: WI })).toBe(false);
  });

  it('SKIPS when the block is attributed to another work-item', () => {
    expect(
      blockAttributionTrips({ ...base, currentItemText: blockedNote(OTHER), onlyIfBlockAttributedTo: WI }),
    ).toBe(true);
  });

  it('SKIPS when nothing attributes the block (a gate set some other way)', () => {
    expect(blockAttributionTrips({ ...base, currentItemText: 'Do the thing', onlyIfBlockAttributedTo: WI })).toBe(
      true,
    );
  });

  it('SKIPS `needs-human` even when the note attributes it to this work-item', () => {
    // The one-way door: a human-capability blocker reflects INTO needs-human
    // automatically and only ever comes out of it by hand.
    expect(
      blockAttributionTrips({
        currentStatus: 'needs-human',
        nextStatus: 'todo',
        currentItemText: `x — note: ← ${WI} needs-human (owner decision)`,
        onlyIfBlockAttributedTo: WI,
      }),
    ).toBe(true);
  });

  it('governs ONLY the blocked→unblocked edge, leaving every other transition alone', () => {
    // Not currently blocked — another guard's business.
    expect(
      blockAttributionTrips({ ...base, currentStatus: 'todo', onlyIfBlockAttributedTo: WI }),
    ).toBe(false);
    expect(
      blockAttributionTrips({ ...base, currentStatus: 'done', onlyIfBlockAttributedTo: WI }),
    ).toBe(false);
    // Blocked → blocked is not a lift.
    expect(
      blockAttributionTrips({ ...base, nextStatus: 'needs-human', onlyIfBlockAttributedTo: WI }),
    ).toBe(false);
    // No status to read.
    expect(
      blockAttributionTrips({ ...base, currentStatus: null, onlyIfBlockAttributedTo: WI }),
    ).toBe(false);
  });
});

/**
 * THE LOAD-BEARING ASSUMPTION. `noteAttributesBlockTo` reads THE note and treats it as
 * the CURRENT attribution. That is only sound because a note REPLACES the previous one
 * (EI-384). If notes ever start stacking, a stale `← WI-x blocked` would sit beside a
 * newer note and the predicate would attribute the block to whoever blocked it FIRST —
 * silently, since the guard would still return a well-formed answer.
 *
 * So the assumption is pinned here rather than trusted: this fails the moment replace
 * degrades to append, which is the change that would quietly break the guard above.
 */
describe('replace-not-append — the invariant the attribution predicate rests on', () => {
  const line = '- **P-007** `todo` Do the thing';

  it('leaves exactly ONE note marker after repeated flips, carrying the LATEST note', () => {
    const first = flipStatusInBody(line, 'P-007', 'blocked', `← ${OTHER} blocked (1 external blocker)`);
    expect(first.found).toBe(true);

    const second = flipStatusInBody(first.newBody!, 'P-007', 'blocked', `← ${WI} blocked (1 external blocker)`);
    expect(second.found).toBe(true);

    const markers = second.newBody!.match(new RegExp(NOTE_MARKER_RE.source, 'g')) ?? [];
    expect(markers, 'a second flip must REPLACE the note, never stack a second one').toHaveLength(1);

    // And the surviving attribution is the newer one — the direction that matters.
    expect(noteAttributesBlockTo(second.newBody!, WI)).toBe(true);
    expect(noteAttributesBlockTo(second.newBody!, OTHER)).toBe(false);
  });
});
