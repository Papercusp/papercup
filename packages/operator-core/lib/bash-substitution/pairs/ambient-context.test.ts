/**
 * ambient-context.test.ts — the FRESHNESS-BOUND guard for the clock pair.
 *
 * ── The class this guards (EI-21333774797481879) ─────────────────────────────
 * `model-drift.test.ts` already guards two directions of pair rot: a pair that
 * UNDER-claims coverage (the tool widened, the model didn't) and one that
 * OVER-claims it (the tool narrowed). This file guards a THIRD direction those
 * cannot see, because it is not about coverage at all.
 *
 * An ambient pair can be perfectly correct about SUBSTITUTABILITY and still be
 * wrong about FRESHNESS. `host.now` really is an ISO-8601 rendering of what
 * `date` prints — the substitution is `equivalent`, and measured side-by-side
 * against `db now()` the two agreed to the second. What the guidance omitted was
 * the BOUND: the payload is a snapshot stamped when that orient ran, and an
 * agent's turns are separated by arbitrary wall-clock time. Measured in one
 * session, two adjacent-in-transcript reads were 1h44m apart; an earlier pair in
 * the same session ~4h40m. Transcript adjacency is not temporal adjacency.
 *
 * Unbounded, the row read "Call nothing" — which is right for reading the clock
 * on the turn the payload arrived and actively wrong on any later one. An agent
 * followed it, differenced a carried `host.now` against a live DB timestamp,
 * concluded the two clocks were skewed ~4h40m, and shipped that to a peer as a
 * durable caution before retracting it. Nothing threw: a carried clock yields a
 * PLAUSIBLE wrong number, so there is no error for a test to catch downstream.
 * The bound in the guidance is the only place this is catchable.
 *
 * ── Why the assertions are on TEXT, and why that is not brittle here ─────────
 * `cover()` sees one atom and cannot know how stale the payload is, so the bound
 * provably cannot live in coverage logic (see the note in the pair's `cover`).
 * It has to live in the prompt-facing strings, which makes those strings
 * load-bearing behaviour rather than prose — so they are what gets pinned. The
 * assertions deliberately check for the two SEMANTIC halves (it is a snapshot +
 * here is the re-read) rather than exact sentences, so the wording stays free to
 * improve while the meaning cannot be dropped.
 *
 * ── Scope, stated honestly ───────────────────────────────────────────────────
 * Only the CLOCK is pinned here. `loadRead` and `memoryRead` point at volatile
 * values too (`host.load`, `host.memFreePct`) and carry the same unbounded "Call
 * nothing", but their failure mode is a stale instantaneous JUDGMENT rather than
 * silently wrong ARITHMETIC, and it has not been measured the way this one has.
 * Widening this guard to them means editing their prompt-facing rows, which is
 * real prompt weight — so that exposure is filed separately with its evidence
 * rather than assumed here. `coreCountRead` is correctly exempt: a core count is
 * static hardware, not a snapshot.
 */

import { describe, it, expect } from 'vitest';

import { clockRead, coreCountRead, AMBIENT_CONTEXT_PAIRS } from './ambient-context';

/** Names the value as a point-in-time capture rather than a live read. */
const SNAPSHOT_MARKER = /snapshot/i;
/** Names the concrete re-read an agent should run instead of carrying it. */
const REREAD_PATH = /date -u/;

describe('clock pair — freshness bound (EI-21333774797481879)', () => {
  it('routing.use bounds "Call nothing" with the snapshot caveat and the re-read', () => {
    const { use } = clockRead.routing;
    expect(use).toMatch(SNAPSHOT_MARKER);
    expect(use).toMatch(REREAD_PATH);
  });

  it('advisoryText bounds the claim too — it is what fires at the call site', () => {
    // The routing row is read while planning; the advisory fires when an agent
    // actually reaches for `date`. A bound on only one of the two leaves the
    // other still instructing the carry.
    expect(clockRead.advisoryText).toMatch(SNAPSHOT_MARKER);
    expect(clockRead.advisoryText).toMatch(REREAD_PATH);
  });

  it('the coverage expression carries the caveat, since that is what gets copied', () => {
    const result = clockRead.cover('date -u');
    expect(result.covered).toBe(true);
    // `expression` is the line an agent transcribes in place of the bash call,
    // so a bound absent HERE is absent exactly where it is acted on.
    expect(result.expression).toMatch(SNAPSHOT_MARKER);
    expect(result.expression).toMatch(REREAD_PATH);
  });

  it('still cites its own toolName — the pre-existing harness invariant', () => {
    // Guards against "fixing" the freshness bound by rewriting the expression
    // into something that no longer names coord:orient.
    const result = clockRead.cover('date');
    expect(result.expression).toContain(clockRead.toolName);
  });

  it('does not regress the substitution itself: a different instant stays uncovered', () => {
    // The bound must not be implemented by narrowing coverage — the verdict is
    // `equivalent` against a measured corpus and is not this guard's to weaken.
    expect(clockRead.expectedVerdict).toBe('equivalent');
    expect(clockRead.cover('date -d @1700000000').covered).toBe(false);
  });
});

describe('ambient pair exemptions', () => {
  it('a STATIC value needs no freshness bound — core count is hardware', () => {
    // Calibration: proves the assertions above are testing a real property and
    // not something every ambient row happens to satisfy. If this ever starts
    // matching, the markers have become vacuous.
    expect(coreCountRead.routing.use).not.toMatch(SNAPSHOT_MARKER);
  });

  it('the pair set is the four known ambient rows', () => {
    // A new ambient pair pointing at a volatile host.* value should decide
    // whether it needs a bound; this fails to force that decision.
    expect(AMBIENT_CONTEXT_PAIRS).toHaveLength(4);
  });
});
