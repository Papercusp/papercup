/**
 * presence-cursor-overlay.test.ts — the P-002 presence overlay
 * (ambient-semantic-push-2026-07-14): projectPublishedCursor purity + the
 * best-effort/double-gated/fail-soft overlayPresenceCursors wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCursorRow } from '../../session-cursor-store';
import {
  projectPublishedCursor,
  overlayPresenceCursors,
  PUBLISHED_CURSOR_MAX_TERMS,
} from './presence-cursor-overlay';

const row = (over: Partial<SessionCursorRow> = {}): SessionCursorRow => ({
  session_id: 's1',
  workspace_id: 'default',
  owner_id: 'su-1',
  harness_slug: 'papercusp',
  turn_ts: '2026-07-14T10:00:00Z',
  note_count: 3,
  term_count: 2,
  terms: [
    { term: 'WI-4790', termClass: 'artifact-id', weight: 3.1234567 },
    { term: 'compaction', termClass: 'domain-term', weight: 1.0 },
  ],
  updated_at: '2026-07-14T10:00:00Z',
  ...over,
});

describe('projectPublishedCursor (pure)', () => {
  it('projects top terms with rounded weights, note count, and data-not-directive provenance', () => {
    const p = projectPublishedCursor(row());
    expect(p.provenance).toBe('data-not-directive');
    expect(p.noteCount).toBe(3);
    expect(p.updatedAt).toBe('2026-07-14T10:00:00Z');
    expect(p.terms).toEqual([
      { term: 'WI-4790', termClass: 'artifact-id', weight: 3.123 }, // rounded to 3dp
      { term: 'compaction', termClass: 'domain-term', weight: 1 },
    ]);
  });

  it('caps to maxTerms (default 8, keeping the strongest — terms are stored descending)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ term: `t${i}`, termClass: 'domain-term' as const, weight: 20 - i }));
    const capped = projectPublishedCursor(row({ terms: many }));
    expect(capped.terms).toHaveLength(PUBLISHED_CURSOR_MAX_TERMS);
    expect(capped.terms[0]!.term).toBe('t0'); // strongest kept
    const capped3 = projectPublishedCursor(row({ terms: many }), 3);
    expect(capped3.terms).toHaveLength(3);
  });

  it('tolerates an empty / malformed terms array', () => {
    expect(projectPublishedCursor(row({ terms: [] })).terms).toEqual([]);
    expect(projectPublishedCursor(row({ terms: undefined as never })).terms).toEqual([]);
  });
});

describe('overlayPresenceCursors (gating + wiring + fail-soft)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is a no-op when disabled — returns the SAME array, no store import/query', async () => {
    const active = [{ ownerId: 'su-1' }];
    const out = await overlayPresenceCursors(active, { enabled: false });
    expect(out).toBe(active); // same reference — nothing touched on the default path
  });

  it('is a no-op on an empty roster', async () => {
    const active: Array<{ ownerId?: unknown }> = [];
    expect(await overlayPresenceCursors(active, { enabled: true })).toBe(active);
  });

  it('stamps each active row with its owner cursor (by ownerId); unmatched rows untouched', async () => {
    vi.resetModules();
    vi.doMock('../../session-cursor-store', () => ({
      cursorsByOwner: async (_ids: string[]) => new Map<string, SessionCursorRow>([['su-1', row({ owner_id: 'su-1' })]]),
    }));
    const { overlayPresenceCursors: fn } = await import('./presence-cursor-overlay');
    const active = [
      { ownerId: 'su-1', intent: 'x' },
      { ownerId: 'su-2', intent: 'y' }, // no cursor for su-2
    ];
    const out = await fn(active, { enabled: true });
    expect((out[0] as { cursor?: { terms: unknown[] } }).cursor).toBeDefined();
    expect((out[0] as { cursor: { terms: Array<{ term: string }> } }).cursor.terms[0]!.term).toBe('WI-4790');
    expect((out[0] as { intent: string }).intent).toBe('x'); // existing fields preserved
    expect((out[1] as { cursor?: unknown }).cursor).toBeUndefined(); // su-2 untouched
  });

  it('fail-soft: a store error leaves the roster untouched', async () => {
    vi.resetModules();
    vi.doMock('../../session-cursor-store', () => ({
      cursorsByOwner: async () => { throw new Error('pg down'); },
    }));
    const { overlayPresenceCursors: fn } = await import('./presence-cursor-overlay');
    const active = [{ ownerId: 'su-1' }];
    const out = await fn(active, { enabled: true });
    expect(out).toEqual([{ ownerId: 'su-1' }]); // no cursor stamped, no throw
  });
});
