/**
 * P-015 — the `lockTransitions` orientation class: `lock granted: <path>` when
 * a lock this owner QUEUED on becomes its own, and `blocked on <path> — held
 * by …` when it newly starts waiting. Never the full lock table.
 *
 * Its own file rather than a block inside `turn-start-orientation.test.ts`
 * because the bar the plan item sets is a THREE-STATE one — granted, blocked,
 * and the no-op steady state — and the third is the one a single happy-path
 * block never gets around to writing. The steady state is not an edge case
 * here; it is the class's defining behaviour. An agent holding a lock across
 * twenty turns must be told about it exactly ZERO times.
 *
 * Every case drives the REAL registry through `composeOrientationBlock`, so a
 * class that is implemented but never registered fails here rather than
 * passing against a directly-called renderer. That is deliberate: the renderer
 * was written and correct for a full turn before it was registered, and a
 * unit test of the function alone would have been green throughout.
 *
 * ⚠ vitest transforms via esbuild and does NOT typecheck; the compile-time half
 * of any claim here only fires under `lint:tsc`.
 */
import { describe, it, expect, vi } from 'vitest';

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: getLoopStatusMock }));

import {
  composeOrientationBlock,
  fingerprintOrientation,
  type OrientationLockTransition,
  type OrientationLockTransitions,
  type OrientationState,
} from './turn-start-orientation';

const EPOCH = 3;

/**
 * Path-shaped but deliberately NOT under `/home/<user>`: a hardcoded home path
 * in shipped source reds the identity-lint leg of the green checkpoint. Only
 * its stability matters — the domain is an opaque key that scopes a path.
 */
const DOMAIN = '/srv/demo-checkout/papercusp';
const OTHER_DOMAIN = '/srv/demo-second-checkout/papercusp';
const PATH = 'packages/operator-core/lib/demo-contested.ts';

const HOLDER = {
  owner: 'su-demo0000-0000-0000-0000-000000000000',
  ownerLabel: 'su · su-demo0',
  intent: 'rewriting the demo resolver',
  expiresTs: '2026-09-21T16:30:00.000Z',
};

function heldRow(path = PATH, coordinationDomain = DOMAIN): OrientationLockTransition {
  return { kind: 'granted', path, coordinationDomain };
}

function blockedRow(path = PATH, coordinationDomain = DOMAIN): OrientationLockTransition {
  return { kind: 'blocked', path, coordinationDomain, holder: { ...HOLDER } };
}

/** `h:`/`b:` identity tokens exactly as the resolver observes them. */
const h = (path = PATH, domain = DOMAIN) => `h:${domain}:${path}`;
const b = (path = PATH, domain = DOMAIN) => `b:${domain}:${path}`;

function observation(
  held: OrientationLockTransition[],
  blocked: OrientationLockTransition[],
): OrientationLockTransitions {
  return {
    held,
    blocked,
    observed: [
      ...held.map((row) => h(row.path, row.coordinationDomain)),
      ...blocked.map((row) => b(row.path, row.coordinationDomain)),
    ],
  };
}

/** Nothing held, nothing waited on — measured-empty, NOT unreadable. */
const QUIET = observation([], []);

/**
 * A change in a class OTHER than this one, so the block re-renders around a
 * lock position that did not move. Without it a "renders nothing" assertion is
 * vacuous: it would pass identically if the whole block had been suppressed.
 */
function inbox(summary: string) {
  return [{ msgId: `m-${summary.length}`, from: 'su-peer', summary }];
}

function stateWith(
  lockTransitions: OrientationLockTransitions | undefined,
  extra: Partial<OrientationState> = {},
): OrientationState {
  return {
    planDecisions: undefined,
    lockTransitions,
    coupledPeers: [],
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
    ...extra,
  };
}

/** Only the lines this class owns — grant rows, block rows, and its pointer. */
function lockLines(block: string): string[] {
  return block
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('- lock granted:') ||
        line.startsWith('- blocked on ') ||
        line.startsWith('- +') ||
        line.includes('more lock transition'),
    );
}

describe('P-015 lockTransitions — the three states the plan item names', () => {
  it('GRANTED: a lock this owner queued on, and then parked waiting for, is announced', () => {
    // Turn 1: waiting behind the holder. This is what makes the grant news.
    const queued = fingerprintOrientation(stateWith(observation([], [blockedRow()])), EPOCH);

    // Turn 2: the holder released and the ticket became ours while parked.
    const block = composeOrientationBlock({
      state: stateWith(observation([heldRow()], [])),
      committed: queued,
      epoch: EPOCH,
    });

    expect(lockLines(block)).toEqual([`- lock granted: ${PATH}`]);
  });

  it('BLOCKED: newly waiting renders the holder, their intent and the expiry', () => {
    const before = fingerprintOrientation(stateWith(QUIET), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(observation([], [blockedRow()])),
      committed: before,
      epoch: EPOCH,
    });

    // The three things that decide whether to wait, pivot, or ask — all present
    // on one line, because a block row that omits the expiry cannot be acted on.
    expect(lockLines(block)).toEqual([
      `- blocked on ${PATH} — held by su · su-demo0 (rewriting the demo resolver, expires 2026-09-21T16:30:00.000Z)`,
    ]);
  });

  it('NO-OP STEADY STATE: held last turn and still held says NOTHING, on a block that did re-render', () => {
    const holding = observation([heldRow()], []);
    const committed = fingerprintOrientation(stateWith(holding, { inboxRecent: inbox('first') }), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(holding, { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });

    // The block DID re-render — otherwise this case proves nothing at all.
    expect(block).not.toBe('');
    expect(lockLines(block)).toEqual([]);
  });
});

describe('P-015 lockTransitions — the conjunct that keeps "queued" true', () => {
  /**
   * THE CALIBRATION CASE. This differs from the GRANTED case above in exactly
   * ONE input — whether the prior cursor saw a `b:` token for the path — and
   * produces the OPPOSITE output. A renderer that simply emitted every held row
   * would pass the granted test and fail here, which is the only reason that
   * test means anything.
   *
   * The behaviour it pins: a lock this agent acquired INSTANTLY, via its own
   * `locks:acquire` call, was already reported to it by that call's own result.
   * Re-announcing it is noise, and it is noise on every single acquire.
   */
  it('a lock acquired instantly — never queued on — is NOT announced as granted', () => {
    const before = fingerprintOrientation(stateWith(QUIET), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(observation([heldRow()], [])),
      committed: before,
      epoch: EPOCH,
    });

    // The locks token moved ('' -> 'h:…'), so the block re-rendered and the
    // silence below is this class's decision, not a suppressed block.
    expect(block).not.toBe('');
    expect(lockLines(block)).toEqual([]);
  });

  it('announces a grant exactly ONCE — not again on the next unrelated re-render', () => {
    const queued = fingerprintOrientation(stateWith(observation([], [blockedRow()])), EPOCH);
    const granted = stateWith(observation([heldRow()], []));

    const first = composeOrientationBlock({ state: granted, committed: queued, epoch: EPOCH });
    expect(lockLines(first)).toEqual([`- lock granted: ${PATH}`]);

    // The cursor now carries `h:…` instead of `b:…`, so the grant is spent.
    const after = fingerprintOrientation(granted, EPOCH, queued);
    const second = composeOrientationBlock({
      state: stateWith(observation([heldRow()], []), { inboxRecent: inbox('a later, unrelated message') }),
      committed: after,
      epoch: EPOCH,
    });

    expect(second).not.toBe('');
    expect(lockLines(second)).toEqual([]);
  });

  it('attributes a blocker WITHIN a coordination domain, never across one', () => {
    // Same path, different checkout. Two checkouts are two different files, so
    // a hold in one domain must not present as a block in the other.
    const before = fingerprintOrientation(stateWith(observation([], [blockedRow(PATH, OTHER_DOMAIN)])), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(observation([heldRow(PATH, DOMAIN)], [])),
      committed: before,
      epoch: EPOCH,
    });

    // Queued in OTHER_DOMAIN, granted in DOMAIN: not the same lock, so not a
    // grant. A path-only join would render one here.
    expect(lockLines(block)).toEqual([]);
  });
});

describe('P-015 lockTransitions — unreadable is not "nothing changed"', () => {
  it('renders NOTHING when the lock read failed, rather than asserting an all-clear', () => {
    const committed = fingerprintOrientation(stateWith(observation([], [blockedRow()])), EPOCH);

    const block = composeOrientationBlock({
      state: stateWith(undefined, { inboxRecent: inbox('an unrelated peer message arrived') }),
      committed,
      epoch: EPOCH,
    });

    expect(block).not.toBe('');
    expect(lockLines(block)).toEqual([]);
  });

  it('PRESERVES the committed token on an unreadable read, so recovery is not a fake grant', () => {
    // The failure this prevents: a transient queue-read error clears the
    // cursor, and the next successful read sees a held lock with no `b:` token
    // in `seen`... which is silence, not a false grant — but the BLOCKED half
    // fails the other way, re-announcing every standing block as fresh.
    const committed = fingerprintOrientation(stateWith(observation([], [blockedRow()])), EPOCH);
    expect(committed.locks).toBe(b());

    const afterFailure = fingerprintOrientation(stateWith(undefined), EPOCH, committed);
    expect(afterFailure.locks).toBe(b());

    // Recovery: the same standing block is read successfully again. Because the
    // token survived the outage it is still `seen`, so it does NOT re-announce.
    const recovered = composeOrientationBlock({
      state: stateWith(observation([], [blockedRow()]), { inboxRecent: inbox('unrelated') }),
      committed: afterFailure,
      epoch: EPOCH,
    });
    expect(recovered).not.toBe('');
    expect(lockLines(recovered)).toEqual([]);
  });

  it('moves the token on a RELEASE, so a re-acquire is announced again', () => {
    // Property 2 of the token: encoding only transitions would leave a released
    // lock in the cursor forever and swallow the next grant.
    const queued = fingerprintOrientation(stateWith(observation([], [blockedRow()])), EPOCH);
    const held = fingerprintOrientation(stateWith(observation([heldRow()], [])), EPOCH, queued);
    expect(held.locks).toBe(h());

    const released = fingerprintOrientation(stateWith(QUIET), EPOCH, held);
    expect(released.locks).toBe('');
  });
});

describe('P-015 lockTransitions — bounded, and blocked-first', () => {
  it('renders blocked rows BEFORE granted ones: a block stops the next action', () => {
    const queued = fingerprintOrientation(
      stateWith(observation([], [blockedRow('a.ts')])),
      EPOCH,
    );

    const block = composeOrientationBlock({
      state: stateWith(observation([heldRow('a.ts')], [blockedRow('z.ts')])),
      committed: queued,
      epoch: EPOCH,
    });

    expect(lockLines(block)).toEqual([
      `- blocked on z.ts — held by su · su-demo0 (rewriting the demo resolver, expires ${HOLDER.expiresTs})`,
      '- lock granted: a.ts',
    ]);
  });

  it('caps the list and points at the recovery verb instead of reproducing locks:queue', () => {
    const before = fingerprintOrientation(stateWith(QUIET), EPOCH);
    const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((p) => blockedRow(p));

    const block = composeOrientationBlock({
      state: stateWith(observation([], many)),
      committed: before,
      epoch: EPOCH,
    });

    const lines = lockLines(block);
    // 3 rows + the pointer. The whole class exists to say "something changed
    // under you", not to become a second, worse `locks:queue`.
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('- +2 more lock transition(s) — locks:queue { paths }.');
  });

  it('never invents a holder when the queue read could not attribute one', () => {
    const before = fingerprintOrientation(stateWith(QUIET), EPOCH);
    const unattributed: OrientationLockTransition = {
      kind: 'blocked',
      path: PATH,
      coordinationDomain: DOMAIN,
    };

    const block = composeOrientationBlock({
      state: stateWith(observation([], [unattributed])),
      committed: before,
      epoch: EPOCH,
    });

    // "You are blocked here" is the load-bearing half and still renders.
    expect(lockLines(block)).toEqual([
      `- blocked on ${PATH} — holder not attributed; locks:queue { paths: ['${PATH}'] }.`,
    ]);
  });
});
