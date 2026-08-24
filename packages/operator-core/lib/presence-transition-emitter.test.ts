/**
 * Unit tests for the PURE half of the P-039 presence-transition emitter
 * (context-injection-audit-2026-07-28, D-012). No PG, no coord rail — the whole
 * point of keeping the detector and the intersection arithmetic pure.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPresenceEdges,
  indexPresenceObservations,
  selectPresenceNotices,
  type Commitment,
  type PresenceEdge,
  type PresenceObservation,
} from './presence-transition-emitter';

const obs = (agentId: string, sessionState: string | null): PresenceObservation => ({ agentId, sessionState });
const prevOf = (...o: PresenceObservation[]) => indexPresenceObservations(o);

describe('detectPresenceEdges', () => {
  it('fires on a crossing into ended', () => {
    const edges = detectPresenceEdges(prevOf(obs('a', 'live')), [obs('a', 'ended')]);
    expect(edges).toEqual([{ agentId: 'a', to: 'ended', from: 'live' }]);
  });

  it('fires on a crossing into suspect', () => {
    const edges = detectPresenceEdges(prevOf(obs('a', 'live')), [obs('a', 'suspect')]);
    expect(edges).toEqual([{ agentId: 'a', to: 'suspect', from: 'live' }]);
  });

  it('rule 1 — a first sighting is never a crossing, however dead it looks', () => {
    // The restart guard: without this, the first sweep after any operator restart
    // alerts on every historically-dead row it happens to still see.
    expect(detectPresenceEdges(prevOf(), [obs('a', 'ended')])).toEqual([]);
  });

  it('rule 2 — does not re-fire while it STAYS in the same alert state', () => {
    expect(detectPresenceEdges(prevOf(obs('a', 'ended')), [obs('a', 'ended')])).toEqual([]);
    expect(detectPresenceEdges(prevOf(obs('a', 'suspect')), [obs('a', 'suspect')])).toEqual([]);
  });

  it('suspect → ended DOES fire — an escalation from unconfirmed to confirmed', () => {
    const edges = detectPresenceEdges(prevOf(obs('a', 'suspect')), [obs('a', 'ended')]);
    expect(edges).toEqual([{ agentId: 'a', to: 'ended', from: 'suspect' }]);
  });

  it('ignores healthy and non-alert states, including draining', () => {
    const prev = prevOf(obs('a', 'live'), obs('b', 'live'), obs('c', 'live'));
    const edges = detectPresenceEdges(prev, [obs('a', 'parked'), obs('b', 'draining'), obs('c', 'recorded')]);
    expect(edges).toEqual([]);
  });

  it('an agent that DISAPPEARS is not a death — the row may simply be TTL-reaped', () => {
    expect(detectPresenceEdges(prevOf(obs('a', 'live')), [])).toEqual([]);
  });

  it('an unknown (null) state never fires — a degraded read is silent, not a false alarm', () => {
    expect(detectPresenceEdges(prevOf(obs('a', 'live')), [obs('a', null)])).toEqual([]);
  });

  it('orders deterministically by agentId', () => {
    const prev = prevOf(obs('c', 'live'), obs('a', 'live'), obs('b', 'live'));
    const edges = detectPresenceEdges(prev, [obs('c', 'ended'), obs('a', 'ended'), obs('b', 'ended')]);
    expect(edges.map((e) => e.agentId)).toEqual(['a', 'b', 'c']);
  });
});

describe('selectPresenceNotices', () => {
  const dead: PresenceEdge = { agentId: 'peer', to: 'ended', from: 'live' };
  const suspect: PresenceEdge = { agentId: 'peer', to: 'suspect', from: 'live' };
  const c = (over: Partial<Commitment> = {}): Commitment => ({
    receiverId: 'me',
    subjectId: 'peer',
    kind: 'awaiting-reply',
    ...over,
  });

  it('THE ACCEPTANCE CRITERION (D-012): an unrelated transition produces no line at all', () => {
    // A crossing with zero intersecting commitments is the silent case — this is
    // what makes the emitter self-budgeting rather than a roster broadcast.
    expect(selectPresenceNotices([dead], [])).toEqual([]);
    // …and a commitment on a DIFFERENT agent than the one that crossed.
    expect(selectPresenceNotices([dead], [c({ subjectId: 'someone-else' })])).toEqual([]);
  });

  it('THE ACCEPTANCE CRITERION (D-012): an intersecting transition reaches the blocked agent', () => {
    const notices = selectPresenceNotices([dead], [c()]);
    expect(notices).toHaveLength(1);
    expect(notices[0].receiverId).toBe('me');
    expect(notices[0].subjectId).toBe('peer');
    expect(notices[0].summary).toContain('is DEAD');
    expect(notices[0].summary).toContain('awaiting their reply');
  });

  it('collapses several commitments on one dying peer into ONE line', () => {
    const notices = selectPresenceNotices([dead], [
      c({ kind: 'awaiting-reply', detail: 'msg-1' }),
      c({ kind: 'blocked-on-lock', detail: 'src/a.ts' }),
      c({ kind: 'awaiting-held-item', detail: 'WI-1' }),
    ]);
    expect(notices).toHaveLength(1);
    const { summary, commitments } = notices[0];
    expect(commitments).toHaveLength(3);
    // One line, but it must name everything the receiver is now stuck on.
    expect(summary).toContain('awaiting their reply');
    expect(summary).toContain('queued behind their lock');
    expect(summary).toContain('WI-1');
  });

  it('never alerts an agent about ITSELF', () => {
    const notices = selectPresenceNotices(
      [{ agentId: 'me', to: 'ended', from: 'live' }],
      [c({ receiverId: 'me', subjectId: 'me' })],
    );
    expect(notices).toEqual([]);
  });

  it('a suspect line must never read as a confirmed death', () => {
    const notices = selectPresenceNotices([suspect], [c()]);
    expect(notices[0].summary).toContain('NOT RESPONDING (unconfirmed');
    expect(notices[0].summary).not.toContain('is DEAD');
    // …and it must tell the reader the wait may still be worth keeping.
    expect(notices[0].summary).toContain('re-check before abandoning');
  });

  it('a confirmed death tells the reader to stop BLOCKING, per commitment class', () => {
    expect(selectPresenceNotices([dead], [c({ kind: 'blocked-on-lock' })])[0].summary).toContain(
      'do not block on them releasing that lock',
    );
    expect(selectPresenceNotices([dead], [c({ kind: 'awaiting-held-item' })])[0].summary).toContain(
      'do not block on that await firing from them',
    );
    expect(selectPresenceNotices([dead], [c({ kind: 'awaiting-reply' })])[0].summary).toContain(
      'do not keep blocking on that reply',
    );
  });

  // EI-21337853199637756. An alert asserted "that reply is not coming" at 12:06Z and the
  // reply arrived from the SAME ownerId at 12:33:54Z, 27 minutes later. `ended` is derived
  // from the owner's most-recent RECORDED SESSION, but a carry-respawn / `--resume` /
  // relaunch brings the identical ownerId back and it can still answer — and in the filed
  // case the verdict came from the heuristic path, not positive session-log death evidence
  // (that owner had no adv_sessions row at all at alert time). Telling the receiver to stop
  // BLOCKING is always sound; telling them a thing will never arrive is not knowable here.
  it('never asserts NON-ARRIVAL — an ended verdict is not a statement about the future', () => {
    const kinds: Commitment['kind'][] = ['awaiting-reply', 'blocked-on-lock', 'awaiting-held-item'];
    const summaries = kinds.map((kind) => selectPresenceNotices([dead], [c({ kind })])[0].summary);

    // Positive control FIRST: prove the selector actually produced advice for every kind,
    // so the absence assertions below cannot pass vacuously on empty/missing summaries.
    expect(summaries).toHaveLength(kinds.length);
    for (const s of summaries) expect(s).toMatch(/do not (keep )?block/i);

    // The forbidden class: any claim about what will or will not happen next.
    const assertsNonArrival = (s: string) =>
      /is not coming/i.test(s) ||
      /will never/i.test(s) ||
      /never fire/i.test(s) ||
      /will not be released/i.test(s);

    // FALSIFIABILITY CONTROL, kept permanently rather than proven by mutating the
    // shared tree (a probe that edits a tracked file can be committed by the git-sync
    // sweep even when nothing goes wrong). These are the verbatim PRE-FIX strings; the
    // SAME predicate that clears the live summaries must REJECT every one of them, or
    // the assertion below is a regex that matches nothing and would pass on anything.
    const PRE_FIX_REMEDIES = [
      'that reply is not coming — do not keep waiting on it',
      'that await will never fire from them — reclaim the item or re-place the work',
      'their lock will not be released by them — expect a reaper release, or take it up',
    ];
    for (const s of PRE_FIX_REMEDIES) expect(assertsNonArrival(s)).toBe(true);

    for (const s of summaries) expect(assertsNonArrival(s)).toBe(false);
  });

  it('fans out to every distinct blocked agent, one line each', () => {
    const notices = selectPresenceNotices([dead], [
      c({ receiverId: 'r1' }),
      c({ receiverId: 'r2' }),
      c({ receiverId: 'r1', kind: 'blocked-on-lock' }),
    ]);
    expect(notices.map((n) => n.receiverId)).toEqual(['r1', 'r2']);
  });

  it('names the SUBJECT in the text — the rendered line carries only the SENDER handle', () => {
    const notices = selectPresenceNotices(
      [{ agentId: 'su-be34c423-61a9-47ad-9c60-3ee66ea81dfd', to: 'ended', from: 'live' }],
      [c({ subjectId: 'su-be34c423-61a9-47ad-9c60-3ee66ea81dfd' })],
    );
    // Without this the reader cannot tell WHO died — the [coord+N] line's own
    // handle is the system emitter's, not the dead peer's.
    expect(notices[0].summary).toContain('be34c');
  });

  it('is a no-op on empty input', () => {
    expect(selectPresenceNotices([], [c()])).toEqual([]);
    expect(selectPresenceNotices([dead], [])).toEqual([]);
  });
});
