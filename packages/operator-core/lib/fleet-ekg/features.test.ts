/**
 * features.test.ts — the EKG's pure per-session embedding (P-030 / FB-10).
 * Pins categorization, the event floor, and every named numeric feature on
 * hand-built event streams (no PG, no clock).
 */
import { describe, expect, it } from 'vitest';
import {
  categorize,
  embedSession,
  MIN_SESSION_EVENTS,
  NUMERIC_FEATURE_KEYS,
  type SessionEvents,
} from './features';

const T0 = 1_750_000_000_000;

function session(events: { tool: string; status?: string | null; at?: number }[], over: Partial<SessionEvents> = {}): SessionEvents {
  return {
    ownerId: 'su-1',
    sessionId: 'sess-1',
    agent: 'claude',
    harnessSlug: null,
    events: events.map((e, i) => ({ toolName: e.tool, status: e.status === undefined ? 'ok' : e.status, atMs: e.at ?? T0 + i * 1000 })),
    ...over,
  };
}

const tenReads = () => Array.from({ length: 10 }, () => ({ tool: 'Read' }));

describe('categorize', () => {
  it('maps native + MCP tool names to behavioral categories', () => {
    expect(categorize('Bash')).toBe('bash');
    expect(categorize('Read')).toBe('read');
    expect(categorize('Grep')).toBe('read');
    expect(categorize('Edit')).toBe('edit');
    expect(categorize('Write')).toBe('edit');
    expect(categorize('TaskUpdate')).toBe('task');
    expect(categorize('TodoWrite')).toBe('task');
    expect(categorize('Agent')).toBe('agent');
    expect(categorize('ToolSearch')).toBe('search');
    expect(categorize('mcp__papercusp-su__locks_acquire')).toBe('locks');
    expect(categorize('mcp__papercusp-su__coord_send')).toBe('coord');
    expect(categorize('mcp__papercusp-su__events_await')).toBe('coord');
    expect(categorize('mcp__papercusp-su__plans_get')).toBe('mcp');
    expect(categorize('SomethingNovel')).toBe('other');
  });
});

describe('embedSession', () => {
  it('returns null below the event floor', () => {
    expect(embedSession(session(tenReads().slice(0, MIN_SESSION_EVENTS - 1)))).toBeNull();
    expect(embedSession(session(tenReads()))).not.toBeNull();
  });

  it('emits every registered numeric feature, finite', () => {
    const v = embedSession(session(tenReads()))!;
    for (const key of NUMERIC_FEATURE_KEYS) {
      expect(v.features[key], key).toBeTypeOf('number');
      expect(Number.isFinite(v.features[key]), key).toBe(true);
    }
  });

  it('computes bounds, counts, mix, and bigrams', () => {
    const v = embedSession(
      session([
        { tool: 'Read' },
        { tool: 'Read' },
        { tool: 'Edit' },
        { tool: 'Bash' },
        { tool: 'Bash' },
        { tool: 'Read' },
        { tool: 'Edit' },
        { tool: 'Bash' },
        { tool: 'Read' },
        { tool: 'mcp__papercusp-su__coord_send' },
      ]),
    )!;
    expect(v.eventCount).toBe(10);
    expect(v.startedAtMs).toBe(T0);
    expect(v.endedAtMs).toBe(T0 + 9000);
    expect(v.toolMix).toEqual({ read: 4, edit: 2, bash: 3, coord: 1 });
    expect(v.bigrams['read>read']).toBe(1);
    expect(v.bigrams['read>edit']).toBe(2);
    expect(v.bigrams['bash>bash']).toBe(1);
    // 9 transitions total.
    expect(Object.values(v.bigrams).reduce((a, b) => a + b, 0)).toBe(9);
  });

  it('errorRate counts only reported outcomes (null status excluded)', () => {
    const v = embedSession(
      session([
        ...Array.from({ length: 6 }, () => ({ tool: 'Bash', status: 'ok' })),
        { tool: 'Bash', status: 'error' },
        { tool: 'Bash', status: 'error' },
        { tool: 'Bash', status: null },
        { tool: 'Bash', status: null },
      ]),
    )!;
    expect(v.features.errorRate).toBeCloseTo(2 / 8);
  });

  it('repeatRate and retryAfterErrorRate read the grind rhythm', () => {
    const v = embedSession(
      session([
        { tool: 'Bash', status: 'error' },
        { tool: 'Bash', status: 'ok' }, // retried after error
        { tool: 'Read' },
        { tool: 'Edit', status: 'error' },
        { tool: 'Read' }, // NOT retried
        { tool: 'Bash' },
        { tool: 'Bash' },
        { tool: 'Bash' },
        { tool: 'Read' },
        { tool: 'Read' },
      ]),
    )!;
    // Same-tool transitions: 1→2 (Bash), 6→7, 7→8 (Bash), 9→10 (Read) = 4 of 9.
    expect(v.features.repeatRate).toBeCloseTo(4 / 9);
    expect(v.features.retryAfterErrorRate).toBeCloseTo(1 / 2);
  });

  it('pacing features measure gaps; constant pace has zero burstiness', () => {
    const steady = embedSession(session(tenReads()))!;
    expect(steady.features.medianGapMs).toBe(1000);
    expect(steady.features.p90GapMs).toBeCloseTo(1000);
    expect(steady.features.burstiness).toBe(0);
    expect(steady.features.durationMs).toBe(9000);

    const bursty = embedSession(
      session(tenReads().map((e, i) => ({ ...e, at: T0 + (i < 5 ? i * 10 : 5 * 10 + (i - 5) * 60_000) }))),
    )!;
    expect(bursty.features.burstiness).toBeGreaterThan(1);
  });

  it('sorts out-of-order events before deriving gaps', () => {
    const shuffled = session(tenReads());
    shuffled.events.reverse();
    const v = embedSession(shuffled)!;
    expect(v.startedAtMs).toBe(T0);
    expect(v.endedAtMs).toBe(T0 + 9000);
    expect(v.features.medianGapMs).toBe(1000);
  });
});
