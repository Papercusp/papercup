/**
 * P-007 (directive-visibility-and-ownership-2026-09-22) — the THREE BUCKETS.
 *
 * WHY THIS FILE EXISTS. The renderer it guards was implemented and committed
 * with NO test: a repo-wide grep for `addressedToMe` and for the literal
 * "NOT yours to resolve" across every `*.test.ts` returned EMPTY. Implemented
 * but unguarded is not done — and this particular renderer is one whose
 * regression is silent, because every bucket produces a plausible-looking line.
 *
 * WHAT THE BUG WAS (WI-10002426 / WI-10002437). Before the split, every
 * directive line ended in "orders:resolve-pending first." regardless of whom
 * the owner was addressing. Because `owner_directives` rows are WORKSPACE-
 * GLOBAL, an agent obeying that on someone else's directive did not merely
 * mishandle its own agenda — it DESTROYED the addressee's row. su-ebc936c4
 * later measured the damage exhaustively: 41 of 105 directives, and 41/41 by
 * foreign dismissal with zero self-dismissals.
 *
 * THE CONTRACT, per D-004: foreign directives are NOT filtered out — they are
 * LABELLED, and every bucket still RENDERS. The owner asked to see them
 * ("I actually like the idea of agents seeing all the directives"). So the
 * assertions below deliberately pin BOTH halves: that a foreign row appears at
 * all, and that its imperative is not an imperative.
 */
import { describe, expect, it } from 'vitest';
import {
  projectOrientationRows,
  type OrientationOwnerDirective,
  type OrientationState,
} from './turn-start-orientation';
import type { DirectiveStatus } from './owner-directive-status';

const ME = 'su-9390fc63-26a0-46a9-95d1-805705cc5e2d';
const PEER = 'su-51a6b83f-a691-4e44-b550-0adfe7a0d3c5';

/**
 * Quiet on every OTHER class, so a failure here names this renderer rather than
 * a neighbour. Mirrors the baseline in turn-start-orientation-class-coverage.
 */
const BASELINE: OrientationState = {
  // Required on OrientationState as of the P-015 lock-transition class. Explicit
  // `undefined` (not omission) so this stays valid whether that field settles as
  // required or optional, and so the quiet shape is stated rather than implied.
  lockTransitions: undefined,
  planDecisions: undefined,
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  modes: [],
  authorityVerdict: null,
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

function status(kind: DirectiveStatus['kind'], over: Partial<DirectiveStatus> = {}): DirectiveStatus {
  return {
    kind,
    holders: [],
    activeWorkItemIds: [],
    captureLagging: false,
    workedButUndispositioned: false,
    ...over,
  };
}

function directive(over: Partial<OrientationOwnerDirective> = {}): OrientationOwnerDirective {
  return {
    id: 17,
    captureStatus: 'pending',
    verbatimText: 'green the gate before you refactor it',
    recordedBy: ME,
    capturedByHook: true,
    addressedToMe: true,
    status: status('unclaimed'),
    ...over,
  };
}

/** Only this class's rows, as text — the projection is the real public seam. */
function lines(...directives: OrientationOwnerDirective[]): string[] {
  return projectOrientationRows({ ...BASELINE, ownerDirectives: directives }, 'turn-start')
    .filter((row) => row.classId === 'ownerDirectives')
    .map((row) => row.text);
}

describe('P-007 owner-directive buckets', () => {
  describe('bucket 1 — addressed to ME, so carry it out', () => {
    it('a PENDING capture asks for resolve-pending first, because the row is not yet promoted', () => {
      expect(lines(directive({ captureStatus: 'pending' }))[0]).toContain(
        'YOURS — orders:resolve-pending, then carry out.',
      );
    });

    it('an OPEN capture is already promoted, so it asks for disposition AFTER the work', () => {
      const [line] = lines(directive({ captureStatus: 'open' }));
      expect(line).toContain('YOURS — carry out, then orders:disposition.');
      // The two mine-branches must not collapse into each other: an already
      // promoted row re-asking for resolve-pending is the nag D-007 describes.
      expect(line).not.toContain('orders:resolve-pending');
    });
  });

  describe('bucket 2 — another session’s, unclaimed: visible, but not yours to resolve', () => {
    it('names the addressee and routes through a directiveRef work-item instead of an imperative', () => {
      const [line] = lines(directive({ recordedBy: PEER, addressedToMe: false, id: 42 }));
      expect(line).toContain('NOT yours to resolve');
      expect(line).toContain('work_items:create { directiveRef: 42 }');
      // The addressee is NAMED. A line that hides whose it is cannot be acted
      // on correctly even by an agent that reads it carefully.
      expect(line).toContain(PEER.slice(0, 12));
    });

    it('D-004: the foreign row is LABELLED, never filtered — it still renders', () => {
      // The acting agent’s first instinct was to filter these out, and the owner
      // rejected it outright. This asserts the rejection, not the instinct.
      expect(lines(directive({ recordedBy: PEER, addressedToMe: false }))).toHaveLength(1);
    });
  });

  describe('bucket 3 — another session’s and already claimed: awareness only', () => {
    it('carries NO imperative at all, so the reader does not duplicate in-flight work', () => {
      const [line] = lines(
        directive({
          recordedBy: PEER,
          addressedToMe: false,
          status: status('claimed', { claimedBy: 'su-14342fa6-a88a', holders: ['su-14342fa6-a88a'] }),
        }),
      );
      expect(line).toContain('FYI only, do not act or resolve.');
      // 12-char truncation, same convention as the addressee handle: the holder
      // is NAMED (so the reader can go ask them) but not at full length.
      expect(line).toContain('claimed by su-14342fa6-');
      expect(line).not.toContain('work_items:create');
      expect(line).not.toContain('YOURS');
    });
  });

  describe('undecided addressing falls to NOT-mine', () => {
    /**
     * A segment `render` receives only (state, committed) — no ownerId — so
     * addressing is decided in the READER and arrives here as a boolean. When
     * that decision could not be made the field is absent, and the asymmetry
     * matters: claiming a foreign directive is expensive, being over-cautious
     * about your own is not.
     */
    it('an ABSENT addressedToMe never produces a carry-out imperative', () => {
      const [line] = lines(directive({ recordedBy: PEER, addressedToMe: undefined }));
      expect(line).not.toContain('YOURS');
      expect(line).toContain('NOT yours to resolve');
    });

    it('a row whose recordedBy IS me but whose addressing was not decided still falls to NOT-mine', () => {
      // Guards against a future "helpful" fallback that re-derives addressing in
      // the renderer from recordedBy. The renderer has no ownerId; a fallback
      // there would be guessing, and guessing in this direction is the bug.
      const [line] = lines(directive({ recordedBy: ME, addressedToMe: undefined }));
      expect(line).not.toContain('YOURS');
    });
  });

  describe('D-007 — a settled directive renders in NO imperative bucket', () => {
    it('a DONE directive produces no row, even while its capture still reads pending', () => {
      // The measured #86/#87 shape: dispositionStatus done while captureStatus
      // is still pending, which made the banner nag [DUE] forever while
      // orders:resolve-pending refused the row as not_pending.
      expect(
        lines(
          directive({
            captureStatus: 'pending',
            status: status('done', { terminalSource: 'disposition', captureLagging: true }),
          }),
        ),
      ).toEqual([]);
    });

    it('a DECLINED directive produces no row', () => {
      expect(
        lines(directive({ status: status('declined', { terminalSource: 'capture-dismissed' }) })),
      ).toEqual([]);
    });

    it('CALIBRATION — the same fixture WITHOUT a terminal status does render', () => {
      // Without this, the two assertions above would also pass if the class had
      // stopped rendering entirely, which is the failure an empty-expectation
      // test cannot distinguish from the behaviour it means to assert.
      expect(lines(directive({ status: status('unclaimed') }))).toHaveLength(1);
    });
  });

  describe('provenance labelling', () => {
    it('an AGENT-asserted row is marked owner-candidate, never promoted to owner speech', () => {
      expect(lines(directive({ capturedByHook: false }))[0]).toContain('owner-candidate');
    });

    it('a HOOK-captured row carries no such qualifier', () => {
      expect(lines(directive({ capturedByHook: true }))[0]).not.toContain('owner-candidate');
    });
  });

  describe('a malformed row degrades, and must never take the banner down', () => {
    /**
     * projectOrientationRows has NO per-segment error isolation: it iterates
     * `for (const text of render(state, committed))`, so a throw inside ANY
     * segment propagates and blanks the ENTIRE orientation block — every class,
     * every row, for that agent, on every turn.
     *
     * This is not hypothetical. It is how the fixture strand below was found
     * (`Cannot read properties of undefined (reading 'length')`), and
     * WI-10002437 measured 41 damaged directive rows in the live workspace, so
     * a row with a missing recordedBy is reachable from real data.
     */
    it('a row with NO recordedBy renders as unattributable instead of throwing', () => {
      const malformed = { ...directive(), addressedToMe: undefined } as OrientationOwnerDirective;
      delete (malformed as Partial<OrientationOwnerDirective>).recordedBy;

      expect(() => lines(malformed)).not.toThrow();
      const [line] = lines(malformed);
      expect(line).toContain('unknown');
      // An unattributable row can NEVER be claimed as mine: `unknown` is not a
      // session id, so it cannot collide with a real ownerId.
      expect(line).not.toContain('YOURS');
    });

    it('a row with NO verbatimText still renders, labelled, rather than throwing', () => {
      const malformed = { ...directive() } as OrientationOwnerDirective;
      delete (malformed as Partial<OrientationOwnerDirective>).verbatimText;

      expect(() => lines(malformed)).not.toThrow();
      expect(lines(malformed)[0]).toContain('(no text recorded)');
    });

    it('CALIBRATION — one malformed row does not suppress a well-formed sibling', () => {
      // The property that actually matters. If the throw ever returns, this is
      // the assertion that states the cost: the good row disappears too.
      const malformed = { ...directive({ id: 1 }) } as OrientationOwnerDirective;
      delete (malformed as Partial<OrientationOwnerDirective>).recordedBy;

      const rendered = lines(malformed, directive({ id: 2, verbatimText: 'well formed' }));
      expect(rendered).toHaveLength(2);
      expect(rendered[1]).toContain('well formed');
    });
  });

  /**
   * PERMANENT CONTROL — proves these assertions are sensitive to the field the
   * whole split turns on. A renderer that stopped reading `addressedToMe` would
   * still emit well-formed, plausible lines for both cases; the only thing that
   * catches it is that the two must DIFFER.
   */
  it('would catch a renderer that ignored addressedToMe (permanent control)', () => {
    const mine = lines(directive({ recordedBy: ME, addressedToMe: true }))[0];
    const foreign = lines(directive({ recordedBy: PEER, addressedToMe: false }))[0];

    expect(mine).not.toEqual(foreign);
    // And specifically in the imperative, not merely in the quoted text or the
    // handle — a difference that lived only in the `by` handle would satisfy a
    // naive inequality while both rows still told the reader to act.
    expect(mine).toContain('YOURS');
    expect(foreign).not.toContain('YOURS');
  });
});
