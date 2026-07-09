/**
 * session-anchor-window — pure window selection for the "jump to the match"
 * transcript backfill (agents-pill-inactive-search-2026-07-09 P-005/P-006).
 * Feeds synthetic AgentTimelineEntry streams through the collector; no files,
 * no SSE.
 */
import { describe, expect, it } from 'vitest';
import { AnchorWindowCollector, entryMatches } from './session-anchor-window';
import type { AgentTimelineEntry } from './endpoint-route/routes/harness/streams';

function entry(over: Partial<AgentTimelineEntry> = {}): AgentTimelineEntry {
  return { kind: 'text', ...over };
}

/** N filler entries that never match ("filler-i"), each timestamped. */
function fillers(n: number, startIdx = 0, baseMs = Date.UTC(2026, 0, 1)): AgentTimelineEntry[] {
  return Array.from({ length: n }, (_, i) =>
    entry({ text: `filler-${startIdx + i}`, ts: new Date(baseMs + (startIdx + i) * 1000).toISOString() }),
  );
}

describe('entryMatches', () => {
  it('matches text case-insensitively', () => {
    expect(entryMatches(entry({ text: 'Deploy the Gateway now' }), 'gateway')).toBe(true);
    expect(entryMatches(entry({ text: 'nothing here' }), 'gateway')).toBe(false);
  });

  it('matches the tool name and the tool-input JSON', () => {
    expect(entryMatches(entry({ kind: 'tool_use', toolName: 'GatewayProbe' }), 'gateway')).toBe(true);
    expect(entryMatches(entry({ kind: 'tool_use', toolInput: { url: 'https://Gateway.local' } }), 'gateway')).toBe(true);
  });

  it('never matches an empty term', () => {
    expect(entryMatches(entry({ text: 'anything' }), '')).toBe(false);
  });

  it('survives an unstringifiable toolInput (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(entryMatches(entry({ kind: 'tool_use', toolInput: circular }), 'self')).toBe(false);
  });
});

describe('AnchorWindowCollector — no anchorTs (last match wins)', () => {
  it('returns null when nothing matches', () => {
    const c = new AnchorWindowCollector({ find: 'needle' });
    for (const e of fillers(50)) c.push(e);
    expect(c.result()).toBeNull();
    expect(c.done).toBe(false);
  });

  it('selects the LAST match with before/after context and a correct anchorIndex', () => {
    const c = new AnchorWindowCollector({ find: 'needle', before: 3, after: 2 });
    const stream = [
      ...fillers(10, 0),
      entry({ text: 'early needle' }), // idx 10 — superseded by the later match
      ...fillers(10, 100),
      entry({ text: 'the FINAL Needle' }), // idx 21 — this one wins
      ...fillers(5, 200),
    ];
    for (const e of stream) c.push(e);
    const res = c.result();
    expect(res).not.toBeNull();
    expect(res!.entries).toHaveLength(3 + 1 + 2); // before + match + after
    expect(res!.anchorIndex).toBe(3);
    expect(res!.entries[res!.anchorIndex].text).toBe('the FINAL Needle');
    // Never early-stops without an anchorTs — the last match needs a full scan.
    expect(c.done).toBe(false);
  });

  it('captures a match at EOF even when trailing context is short', () => {
    const c = new AnchorWindowCollector({ find: 'needle', before: 2, after: 50 });
    for (const e of [...fillers(5), entry({ text: 'needle at the very end' })]) c.push(e);
    const res = c.result();
    expect(res).not.toBeNull();
    expect(res!.entries[res!.anchorIndex].text).toBe('needle at the very end');
    expect(res!.anchorIndex).toBe(2); // full `before`, truncated `after`
  });

  it('keeps memory bounded across a long non-matching scan', () => {
    const c = new AnchorWindowCollector({ find: 'needle', before: 50, after: 40 });
    for (const e of fillers(10_000)) c.push(e);
    // Private ring, asserted deliberately: the compaction contract is the point.
    const ring = (c as unknown as { ring: unknown[] }).ring;
    expect(ring.length).toBeLessThanOrEqual(150);
    expect(c.result()).toBeNull();
  });

  it('keeps memory bounded when an open match never completes its window', () => {
    const c = new AnchorWindowCollector({ find: 'needle', before: 10, after: 100_000 });
    c.push(entry({ text: 'needle once' }));
    for (const e of fillers(10_000)) c.push(e);
    const ring = (c as unknown as { ring: unknown[] }).ring;
    // The open window may legitimately retain up to before+after+1; with a huge
    // `after` the bound is dominated by entries seen, but must not exceed it.
    expect(ring.length).toBeLessThanOrEqual(10_001 + 11);
    const res = c.result();
    expect(res!.entries[res!.anchorIndex].text).toBe('needle once');
  });
});

describe('AnchorWindowCollector — anchorTs (first match at/after the ts)', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();

  it('locks the FIRST match at/after the anchor and early-stops after trailing context', () => {
    const c = new AnchorWindowCollector({ find: 'needle', anchorTs: t(100), before: 2, after: 3 });
    const stream = [
      entry({ text: 'needle too early', ts: t(10) }), // before anchor — fallback only
      ...fillers(5, 0, Date.UTC(2026, 0, 1) + 20_000),
      entry({ text: 'needle ON TIME', ts: t(100) }), // the anchored turn
      entry({ text: 'needle later', ts: t(110) }), // must NOT displace the lock
      ...fillers(10, 500, Date.UTC(2026, 0, 1) + 120_000),
    ];
    let pushed = 0;
    for (const e of stream) {
      if (c.done) break;
      c.push(e);
      pushed += 1;
    }
    expect(c.done).toBe(true);
    expect(pushed).toBeLessThan(stream.length); // early stop actually saved reads
    const res = c.result();
    expect(res!.entries[res!.anchorIndex].text).toBe('needle ON TIME');
    expect(res!.anchorIndex).toBe(2); // 2 `before` context entries kept
  });

  it('falls back to a before-anchor match when nothing matches at/after', () => {
    const c = new AnchorWindowCollector({ find: 'needle', anchorTs: t(1000), before: 1, after: 1 });
    const stream = [
      ...fillers(3, 0),
      entry({ text: 'needle before the anchor', ts: t(5) }),
      ...fillers(3, 100),
    ];
    for (const e of stream) c.push(e);
    expect(c.done).toBe(false); // never saw an at/after match — no early stop
    const res = c.result();
    expect(res!.entries[res!.anchorIndex].text).toBe('needle before the anchor');
  });

  it('ignores an unparseable anchorTs (behaves as last-match mode)', () => {
    const c = new AnchorWindowCollector({ find: 'needle', anchorTs: 'not-a-date', before: 1, after: 1 });
    for (const e of [entry({ text: 'needle one' }), ...fillers(3), entry({ text: 'needle two' })]) c.push(e);
    const res = c.result();
    expect(res!.entries[res!.anchorIndex].text).toBe('needle two');
  });
});
