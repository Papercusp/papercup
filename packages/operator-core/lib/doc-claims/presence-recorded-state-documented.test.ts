/**
 * Doc-claim: coord:presence's `when` guidance must NAME `recorded` and say it is ALIVE.
 *
 * WHY THIS IS A GUARD AND NOT A COMMENT (EI-21354481056006346):
 *
 * `recorded` is a correct-by-definition state, not a bug: the shared oracle assigns it
 * from a predicate literally named `recordedLiveOnly` (liveness-oracle.ts — not wakeable,
 * no live turn, NOT pid-confirmed-dead), and `classifyReadActionability` returns
 * 'actionable' for exactly `live | parked | recorded`. So the oracle already treats it as
 * alive, on the same tier as live/parked.
 *
 * The failure was entirely at the READ SURFACE. The tool's guidance enumerated
 * parked / draining / suspect / ended and simply omitted `recorded`, so a row in that
 * state matched no documented category and the nearest neighbour ("ended rows need
 * relaunch") reads as death. Worse, the guidance's prescribed way to confirm a suspect
 * agent — send a required wake and inspect the result — is STRUCTURALLY UNAVAILABLE for
 * these rows, because they are `wakeable:false`: the confirmation step returns the same
 * silence for "alive but unwakeable" as for "dead". A reporter came within one step of
 * taking over a live lane on that reading, which would have fired a duplicate release
 * checkpoint against a named sole-serializer owner (D-018/D-019) and burnt a 30-55min
 * suite. Only `lastActiveSecAgo` (6 seconds) stopped it.
 *
 * The recurrence risk is specific and mechanical: `coord:presence` runs close to the
 * per-tool prompt-weight budget (measured 1446/1500 when this landed), so the guidance is
 * a standing candidate for trimming. Deleting this one sentence to buy headroom silently
 * re-arms the near-miss, and nothing else in the tree would notice. Hence a guard rather
 * than a comment.
 *
 * Deliberately asserts on the SOURCE TEXT rather than importing the tool: pulling the
 * registered catalog in costs ~37s of module import here, and the claim is about the
 * shipped prose, which the source is the source of truth for.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESENCE_TOOL = resolve(
  __dirname,
  join('..', 'agent-tools', 'coordination', 'tools', 'presence.ts'),
);

const source = (): string => readFileSync(PRESENCE_TOOL, 'utf8');

describe('coord:presence documents the `recorded` session state', () => {
  it('the guidance names `recorded` at all', () => {
    // Calibration: the file must be readable and non-trivial, or every assertion
    // below would pass vacuously against an empty string.
    const text = source();
    expect(text.length, `${PRESENCE_TOOL} is empty or unreadable`).toBeGreaterThan(1000);

    expect(
      /recorded/.test(text),
      'coord:presence guidance no longer mentions `recorded`. It is an ALIVE state ' +
        '(oracle: recordedLiveOnly / classifyReadActionability) that renders wakeable:false, ' +
        'so an undocumented row reads as dead and invites taking over a live lane. ' +
        'See EI-21354481056006346 before trimming this for prompt-weight headroom.',
    ).toBe(true);
  });

  it('says `recorded` is alive, and that a wake is not how you judge it', () => {
    const text = source();

    // The load-bearing pair. Naming the state is not enough: the whole point is that it
    // is ALIVE, and that the documented confirmation (a required wake) cannot speak for
    // it — so both halves have to survive a future edit, not just the word.
    expect(
      /`?recorded`?[^\n]*ALIVE/i.test(text),
      'coord:presence mentions `recorded` but no longer says it is ALIVE — the exact ' +
        'reading that caused the near-miss in EI-21354481056006346.',
    ).toBe(true);

    expect(
      /lastActiveSecAgo/.test(text),
      'coord:presence no longer points readers at lastActiveSecAgo, which is the only ' +
        'signal that distinguishes an alive-but-unwakeable `recorded` row from a dead one.',
    ).toBe(true);
  });
});
