/** adjacency-cross-feed (ambient-semantic-push P-013): sustained-adjacency
 *  detection (similar WITHOUT duplicate — the band under P-004) + the shared-
 *  topic rendezvous + the ~1-line on-topic journal cross-post. */
import { describe, it, expect } from 'vitest';
import type { CollisionLike } from './ambient-push';
import {
  adjacencyTick,
  validateAdjacencyParams,
  sharedTopicName,
  crossFeedPush,
  DEFAULT_ADJACENCY_PARAMS,
  type AdjacencyParams,
  type AdjacencyState,
  type AdjacencyNotice,
} from './adjacency-cross-feed';

type Sample = { score: number } | { absent: true };

function runPeer(sid: string, samples: Sample[], opts: { params?: AdjacencyParams; terms?: string[] } = {}) {
  let states: AdjacencyState[] = [];
  const notices: AdjacencyNotice[] = [];
  const terms = (opts.terms ?? ['WI-4790', 'compaction']).map((t) => ({ term: t }));
  samples.forEach((s, i) => {
    const snapshot: CollisionLike[] = 'absent' in s ? [] : [{ sessionId: sid, overlap: { score: s.score, sharedTerms: terms } }];
    const r = adjacencyTick({ states, snapshot, tick: i, params: opts.params });
    states = r.states;
    notices.push(...r.notices);
  });
  return { states, notices };
}

const present = (score: number, n: number): Sample[] => Array.from({ length: n }, () => ({ score }));
const absent = (n: number): Sample[] => Array.from({ length: n }, () => ({ absent: true as const }));

describe('validateAdjacencyParams + sharedTopicName', () => {
  it('accepts the defaults; flags a missing band', () => {
    expect(validateAdjacencyParams(DEFAULT_ADJACENCY_PARAMS)).toEqual([]);
    expect(validateAdjacencyParams({ ...DEFAULT_ADJACENCY_PARAMS, enterThreshold: 0.6 }).some((m) => /band/.test(m))).toBe(true);
  });

  it('derives a deterministic, symmetric topic name from the shared terms', () => {
    const terms = [{ term: 'WI-4790' }, { term: 'psu-launcher.mjs' }, { term: 'compaction' }, { term: 'extra' }];
    expect(sharedTopicName(terms)).toBe('adj:wi-4790+psu-launcher.mjs+compaction'); // top 3, lowercased
    expect(sharedTopicName([])).toBe('adj:unnamed');
  });
});

describe('P-013 — banded adjacency detection', () => {
  it('sustained in-band overlap enters an adjacency (with the dwell); spikes do nothing', () => {
    expect(runPeer('p', present(0.35, 2)).notices).toHaveLength(0); // dwell 3
    const { states, notices } = runPeer('p', present(0.35, 3));
    const entered = notices.filter((n) => n.kind === 'adjacency-entered');
    expect(entered).toHaveLength(1);
    expect(entered[0].topic).toBe('adj:wi-4790+compaction');
    expect(states.find((s) => s.sessionId === 'p')!.adjacent).toBe(true);
  });

  it('DUPLICATE-territory overlap builds no adjacency streak (that is P-004 collision, not adjacency)', () => {
    // 0.9 ≥ duplicateThreshold 0.55 every tick → never adjacent.
    const { notices } = runPeer('p', present(0.9, 10));
    expect(notices).toHaveLength(0);
  });

  it('an adjacency that escalates into duplicate territory exits with the escalation reason (handover to P-004)', () => {
    const { states, notices } = runPeer('p', [...present(0.35, 3), ...present(0.9, 1)]);
    const exited = notices.find((n) => n.kind === 'adjacency-exited')!;
    expect(exited.reason).toMatch(/escalated-to-collision/);
    expect(states.find((s) => s.sessionId === 'p')!.adjacent).toBe(false);
  });

  it('drift + staleness exit like the sibling folds; re-entry is cheap', () => {
    const drifted = runPeer('p', [...present(0.35, 3), ...present(0.05, 6)]); // exitDwell 6
    expect(drifted.notices.find((n) => n.kind === 'adjacency-exited')!.reason).toMatch(/drifted/);
    const stale = runPeer('p', [...present(0.35, 3), ...absent(4)]); // stalenessTicks 4
    expect(stale.notices.find((n) => n.kind === 'adjacency-exited')!.reason).toMatch(/staleness/);
    const reentry = runPeer('p', [...present(0.35, 3), ...present(0.05, 6), ...present(0.35, 3)]);
    expect(reentry.notices.filter((n) => n.kind === 'adjacency-entered')).toHaveLength(2);
  });

  it('mid-gap overlap (≥ exit, < enter) holds an adjacency without re-earning (hysteresis gap)', () => {
    const { states, notices } = runPeer('p', [...present(0.35, 3), ...present(0.2, 20)]); // 0.2 ∈ [exit 0.15, enter 0.25)
    expect(states.find((s) => s.sessionId === 'p')!.adjacent).toBe(true);
    expect(notices.filter((n) => n.kind === 'adjacency-exited')).toHaveLength(0);
  });

  it('does not mutate its input (pure)', () => {
    const initial: AdjacencyState[] = [
      { sessionId: 'p', adjacent: true, inBandStreak: 3, belowExitStreak: 0, ticksSinceSeen: 0, lastScore: 0.35, lastSharedTerms: ['x'], enteredAtTick: 0 },
    ];
    const snapshot = JSON.parse(JSON.stringify(initial));
    adjacencyTick({ states: initial, snapshot: [], tick: 1 });
    expect(initial).toEqual(snapshot);
  });
});

describe('P-013 — the ~1-line on-topic journal cross-post', () => {
  it('renders an on-topic note as a bounded topic-sub push, provenance-stamped, source-attributed', () => {
    const push = crossFeedPush({
      note: 'landed the WI-4790 advisory-lock fix; compaction now settles cleanly',
      sessionId: 'su-abc',
      topic: 'adj:wi-4790+compaction',
      topicTerms: ['WI-4790', 'compaction'],
    })!;
    expect(push).not.toBeNull();
    expect(push.matcherKind).toBe('topic-sub');
    expect(push.severity).toBe('info');
    expect(push.provenance).toBe('data-not-directive');
    expect(push.handle.kind).toBe('topic');
    expect(push.handle.ref).toBe('adj:wi-4790+compaction');
    expect(push.sourceSessionId).toBe('su-abc');
    expect(push.teaser).toContain('su-abc');
    expect(push.score).toBe(1); // matched 2/2 topic terms
  });

  it('an OFF-topic note is never cross-posted; the excerpt is bounded to ~1 line', () => {
    expect(crossFeedPush({ note: 'reviewing the mac vm sudo runbook', sessionId: 's', topic: 'adj:x', topicTerms: ['WI-4790'] })).toBeNull();
    expect(crossFeedPush({ note: '', sessionId: 's', topic: 'adj:x', topicTerms: ['WI-4790'] })).toBeNull();
    const long = 'WI-4790 ' + 'went deep on the advisory lock chain today '.repeat(20);
    const push = crossFeedPush({ note: long, sessionId: 's', topic: 'adj:x', topicTerms: ['WI-4790'], maxNoteChars: 80 })!;
    // teaser = "[topic] sid: <excerpt≤80>" and makePush hard-caps at 200.
    expect(push.teaser.length).toBeLessThanOrEqual(200);
    expect(push.teaser).toContain('…');
  });
});
