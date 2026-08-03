/**
 * Unit tests for cell-thread.ts (P-006 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * The read path runs through an injected window reader, so this suite needs no
 * database. What is worth pinning here is almost entirely SILENT-FAILURE shaped:
 * every bug this module can have renders as a calm, plausible sentence rather
 * than an error, so the tests are weighted toward the three states that must
 * never collapse into one another (measured silence / nothing to read / could not
 * read) and toward the counts that stop an excerpt reading as the whole story.
 */
import { describe, it, expect } from 'vitest';
import {
  CELL_THREAD_BODY_CHARS,
  CELL_THREAD_RECENT_LIMIT,
  cellThreadIsCoherent,
  measuredThread,
  noSubjectThread,
  readCellThread,
  silentThread,
  toCellThreadMessage,
  toTopicPointers,
  unmeasuredThread,
  type CellThread,
} from './cell-thread';

function post(body: string, at = '2026-08-03T02:19:52.918Z', author: string | null = 'su-4a6e2255') {
  return { author_id: author, body, created_ts: at };
}

describe('message projection', () => {
  it('carries the timestamp and author on every message (D-005)', () => {
    const m = toCellThreadMessage(post('short', '2026-08-01T10:00:00.000Z', 'su-abc'));
    expect(m.at).toBe('2026-08-01T10:00:00.000Z');
    expect(m.author).toBe('su-abc');
    // A message without a timestamp silently inherits the freshness of the cell
    // embedding it — the specific lie D-005 exists to prevent.
    expect(m.at).not.toBeUndefined();
  });

  it('keeps a substrate post\'s null author rather than inventing one', () => {
    expect(toCellThreadMessage(post('x', undefined, null)).author).toBeNull();
  });

  it('does not truncate a body at the boundary, and reports it untruncated', () => {
    const body = 'x'.repeat(CELL_THREAD_BODY_CHARS);
    const m = toCellThreadMessage(post(body));
    expect(m.truncated).toBe(false);
    expect(m.text).toHaveLength(CELL_THREAD_BODY_CHARS);
    expect(m.chars).toBe(CELL_THREAD_BODY_CHARS);
  });

  it('truncates one char past the boundary and SAYS SO, with the full length', () => {
    const body = 'y'.repeat(CELL_THREAD_BODY_CHARS + 1);
    const m = toCellThreadMessage(post(body));
    expect(m.truncated).toBe(true);
    expect(m.text).toHaveLength(CELL_THREAD_BODY_CHARS);
    // `chars` is the ORIGINAL length, not the excerpt's — the reader has to be
    // able to tell how much they are not seeing.
    expect(m.chars).toBe(CELL_THREAD_BODY_CHARS + 1);
  });

  it('truncates a realistically-sized post — the MEDIAN case, not an edge case', () => {
    // Measured 2026-08-03 over 8,479 posts in this workspace: median body 767
    // chars. If truncation were rare this flag could be cosmetic; it is not.
    const m = toCellThreadMessage(post('z'.repeat(767)));
    expect(m.truncated).toBe(true);
    expect(m.chars).toBe(767);
  });
});

describe('the three states that must never collapse', () => {
  it('distinguishes measured silence from an unreadable thread', () => {
    const silent = silentThread();
    const broken = unmeasuredThread('store down');

    // Both render zero messages. Only one of them is a fact.
    expect(silent.recent).toEqual([]);
    expect(broken.recent).toEqual([]);

    expect(silent.total).toBe(0);
    expect(silent.unknown).toBeNull();

    expect(broken.total).toBeNull();
    expect(broken.unknown?.code).toBe('resolver-failed');
  });

  it('distinguishes "nothing to read" (final) from "could not read" (retryable)', () => {
    // not-applicable is FINAL: retrying changes nothing, there is no lever.
    expect(noSubjectThread('nothing owns it').unknown?.code).toBe('not-applicable');
    // resolver-failed is RETRY-OR-ESCALATE: the value may well exist.
    expect(unmeasuredThread('timeout').unknown?.code).toBe('resolver-failed');
  });

  it('never reports an unmeasured thread as a zero count', () => {
    for (const t of [unmeasuredThread('a'), noSubjectThread('b')]) {
      // `0` would read as "nobody has said anything", which is the reassuring
      // misreading of a failure — the exact P-004 defect, one level down.
      expect(t.total).not.toBe(0);
      expect(t.total).toBeNull();
      expect(t.shown).toBeNull();
    }
  });
});

describe('counts frame the messages (D-005)', () => {
  it('reports shown as the window size and total as the whole thread', () => {
    const t = measuredThread([post('a'), post('b')], 47);
    expect(t.shown).toBe(2);
    expect(t.total).toBe(47);
    // The point of the pair: 2 of 47 must not read as "there are 2".
    expect(t.total).toBeGreaterThan(t.shown!);
  });

  it('holds shown === recent.length by construction', () => {
    expect(measuredThread([post('a'), post('b'), post('c')], 3).shown).toBe(3);
  });
});

describe('cellThreadIsCoherent — messages never appear without counts', () => {
  it('accepts every well-formed state', () => {
    expect(cellThreadIsCoherent(measuredThread([post('a')], 9))).toBe(true);
    expect(cellThreadIsCoherent(silentThread())).toBe(true);
    expect(cellThreadIsCoherent(unmeasuredThread('x'))).toBe(true);
    expect(cellThreadIsCoherent(noSubjectThread('x'))).toBe(true);
  });

  it('rejects messages carried alongside a null count', () => {
    const bad: CellThread = { ...unmeasuredThread('x'), recent: [toCellThreadMessage(post('a'))] };
    expect(cellThreadIsCoherent(bad)).toBe(false);
  });

  it('rejects a count that disagrees with the messages it frames', () => {
    const bad: CellThread = { ...measuredThread([post('a')], 5), shown: 3 };
    expect(cellThreadIsCoherent(bad)).toBe(false);
  });

  it('rejects a total smaller than the window it claims to contain', () => {
    const bad: CellThread = { ...measuredThread([post('a'), post('b')], 1) };
    expect(cellThreadIsCoherent(bad)).toBe(false);
  });
});

describe('topic pointers (D-004)', () => {
  it('scopes every pointer to the INCIDENT start, not the tag time', () => {
    const ptrs = toTopicPointers(['gate', 'papercusp-improvement'], '2026-08-03T02:19:52.918Z');
    expect(ptrs).toHaveLength(2);
    // Same `since` on both: it is a property of the incident, not of the edge.
    expect(new Set(ptrs.map((p) => p.since))).toEqual(new Set(['2026-08-03T02:19:52.918Z']));
    expect(ptrs[0]).toEqual({ slug: 'gate', ref: 'topic:gate', since: '2026-08-03T02:19:52.918Z' });
  });

  it('returns no pointers for an untagged item rather than inventing an area', () => {
    // The live WI-7282, minted by the P-003 bridge, carries NO topic tag — only
    // the `about -> event` edge. Fabricating a plausible `gate` pointer here
    // would be the module asserting something nobody wrote.
    expect(toTopicPointers([], '2026-08-03T02:19:52.918Z')).toEqual([]);
  });
});

describe('readCellThread', () => {
  const window = (over: Partial<{ posts: ReturnType<typeof post>[]; total: number; topics: string[]; createdAt: string }> = {}) =>
    (async () => ({
      posts: over.posts ?? [post('hello')],
      total: over.total ?? 1,
      topics: over.topics ?? [],
      createdAt: over.createdAt ?? '2026-08-03T02:19:52.918Z',
    })) as never;

  it('reports not-applicable when nothing owns the condition', async () => {
    // The most common state on a HEALTHY gate — it must not read as a failure.
    const t = await readCellThread(null, { getWorkItemThreadWindow: window() });
    expect(t.unknown?.code).toBe('not-applicable');
    expect(t.recent).toEqual([]);
  });

  it('reports MEASURED SILENCE for an owned item nobody has commented on', async () => {
    // The default state of a bridge-minted item: threads are created on first
    // post, so a fresh incident has no thread row at all.
    const t = await readCellThread('WI-7282', { getWorkItemThreadWindow: window({ posts: [], total: 0 }) });
    expect(t.unknown).toBeNull();
    expect(t.total).toBe(0);
    expect(t.shown).toBe(0);
  });

  it('projects real posts with their counts and topic pointers', async () => {
    const t = await readCellThread('WI-7282', {
      getWorkItemThreadWindow: window({ posts: [post('a'), post('b')], total: 12, topics: ['gate'] }),
    });
    expect(t.shown).toBe(2);
    expect(t.total).toBe(12);
    expect(t.topics[0].ref).toBe('topic:gate');
    expect(cellThreadIsCoherent(t)).toBe(true);
  });

  it('fails SOFT to unmeasured when the reader throws — never to silence', async () => {
    const t = await readCellThread('WI-7282', {
      getWorkItemThreadWindow: (async () => {
        throw new Error('connection refused');
      }) as never,
    });
    expect(t.unknown?.code).toBe('resolver-failed');
    expect(t.unknown?.detail).toContain('connection refused');
    expect(t.total).toBeNull();
  });

  it('treats a missing work-item as unmeasured, not as an empty thread', async () => {
    // The condition claims an owner the store cannot produce — that is a
    // contradiction worth surfacing, not a quiet zero.
    const t = await readCellThread('WI-9999', { getWorkItemThreadWindow: (async () => null) as never });
    expect(t.unknown?.code).toBe('resolver-failed');
  });

  it('asks for the documented window size by default', async () => {
    let asked = -1;
    await readCellThread('WI-7282', {
      getWorkItemThreadWindow: (async (_id: string, limit: number) => {
        asked = limit;
        return { posts: [], total: 0, topics: [], createdAt: '2026-08-03T00:00:00.000Z' };
      }) as never,
    });
    expect(asked).toBe(CELL_THREAD_RECENT_LIMIT);
  });
});
