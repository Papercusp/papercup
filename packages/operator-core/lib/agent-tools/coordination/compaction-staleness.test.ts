/**
 * compaction-staleness — unit tests
 * (compaction-continuity-hardening-2026-07-07 P-004 / WI-2537).
 *
 * The boundary-timestamp parser is pure; the file reader is exercised on temp
 * files (including the tail-window edge); the warnings assembly runs through
 * its injectable seams (no PG). Load-bearing contracts: the LAST boundary
 * wins, only post-summary changes are flagged, every leg is independently
 * best-effort, and the list is bounded.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLastCompactBoundaryTs,
  readLastCompactBoundaryTs,
  buildStalenessWarnings,
  STALENESS_MAX_WARNINGS,
  type BuildStalenessWarningsOpts,
} from './compaction-staleness';

const T = Date.parse('2026-07-07T17:00:00.000Z');
const NOW = T + 10 * 60_000; // first orient ~10 minutes after the summary

function boundaryLine(ts: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 300000 },
    timestamp: ts,
  });
}

describe('parseLastCompactBoundaryTs', () => {
  it('returns the LAST boundary when the transcript holds several', () => {
    const text = [
      boundaryLine('2026-07-07T10:00:00.000Z'),
      '{"type":"assistant","message":{}}',
      boundaryLine('2026-07-07T17:00:00.000Z'),
      '{"type":"user","message":{}}',
    ].join('\n');
    expect(parseLastCompactBoundaryTs(text)).toBe(T);
  });

  it('matches the attachment-wrapped boundary shape too (marker substring, top-level timestamp)', () => {
    const line = JSON.stringify({
      type: 'attachment',
      attachment: { subtype: 'compact_boundary', content: 'Conversation compacted' },
      timestamp: '2026-07-07T17:00:00.000Z',
    });
    expect(parseLastCompactBoundaryTs(line)).toBe(T);
  });

  it('skips an unparseable (tail-truncated) boundary line and keeps scanning up', () => {
    const text = [
      boundaryLine('2026-07-07T17:00:00.000Z'),
      boundaryLine('2026-07-07T18:00:00.000Z').slice(40), // truncated head — not JSON
    ].join('\n');
    expect(parseLastCompactBoundaryTs(text)).toBe(T);
  });

  it('null when no boundary exists (a never-compacted transcript)', () => {
    expect(parseLastCompactBoundaryTs('{"type":"user"}\n{"type":"assistant"}')).toBeNull();
  });
});

describe('readLastCompactBoundaryTs', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the boundary from a real transcript file tail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stale-'));
    const f = join(dir, 't.jsonl');
    // Pad the head past the tail window so the read starts mid-file.
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1024) } });
    const head = Array.from({ length: 700 }, () => filler); // ~700KB > TAIL window
    writeFileSync(f, [...head, boundaryLine('2026-07-07T17:00:00.000Z'), filler].join('\n'));
    expect(await readLastCompactBoundaryTs(f)).toBe(T);
  });

  it('null for a file without a boundary', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stale-'));
    const f = join(dir, 't.jsonl');
    writeFileSync(f, '{"type":"user"}\n');
    expect(await readLastCompactBoundaryTs(f)).toBeNull();
  });
});

function seams(overrides: Partial<BuildStalenessWarningsOpts> = {}): BuildStalenessWarningsOpts {
  return {
    summaryAtMs: T,
    now: NOW,
    listOwnClaimsFn: async () => [
      { planSlug: 'my-plan', itemId: 'P-004', expiresTsMs: NOW + 20 * 60_000 }, // live
      { planSlug: 'my-plan', itemId: 'P-002', expiresTsMs: NOW - 5 * 60_000 }, // lapsed
    ],
    listPeerClaimsSinceFn: async () => [
      { planSlug: 'my-plan', itemId: 'P-007', owner: 'su-peer1', acquiredTsMs: T + 3 * 60_000 },
    ],
    listFleetPeersSinceFn: async () => [
      { ownerId: 'su-new', label: 'su · su-new', startedAtMs: T + 2 * 60_000 },
    ],
    listHeldChangedSinceFn: async () => [
      { id: 'WI-100', state: 'resolved', updatedAtMs: T + 60_000 },
    ],
    ...overrides,
  };
}

describe('buildStalenessWarnings', () => {
  it('flags lapsed own claims, changed held items, post-T peer claims, and fleet arrivals — in that order', async () => {
    const w = await buildStalenessWarnings('su-me', 'ws', seams());
    expect(w).toHaveLength(4);
    expect(w[0]).toContain('my-plan#P-002 LAPSED');
    expect(w[0]).toContain('re-claim');
    expect(w[1]).toContain('WI-100 CHANGED after the summary');
    expect(w[1]).toContain('state now: resolved');
    expect(w[2]).toContain('my-plan#P-007 was claimed by su-peer1 AFTER your summary');
    expect(w[3]).toContain('fleet peer su · su-new APPEARED after your summary');
    // The live claim is NOT flagged.
    expect(w.join('\n')).not.toContain('P-004');
  });

  it('passes the OWN claims\' plan slugs to the peer-claims reader (deduped)', async () => {
    let got: string[] | null = null;
    await buildStalenessWarnings(
      'su-me',
      'ws',
      seams({
        listPeerClaimsSinceFn: async (_o, _w, _s, slugs) => {
          got = slugs;
          return [];
        },
      }),
    );
    expect(got).toEqual(['my-plan']);
  });

  it('skips the peer-claims leg entirely when the caller holds no claims', async () => {
    let called = false;
    const w = await buildStalenessWarnings(
      'su-me',
      'ws',
      seams({
        listOwnClaimsFn: async () => [],
        listPeerClaimsSinceFn: async () => {
          called = true;
          return [];
        },
        listFleetPeersSinceFn: async () => [],
        listHeldChangedSinceFn: async () => [],
      }),
    );
    expect(called).toBe(false);
    expect(w).toEqual([]);
  });

  it('drops held rows at/older than the summary (defensive re-filter over the seam)', async () => {
    const w = await buildStalenessWarnings(
      'su-me',
      'ws',
      seams({
        listOwnClaimsFn: async () => [],
        listPeerClaimsSinceFn: async () => [],
        listFleetPeersSinceFn: async () => [],
        listHeldChangedSinceFn: async () => [
          { id: 'WI-OLD', state: 'open', updatedAtMs: T - 60_000 },
          { id: 'WI-NEW', state: 'open', updatedAtMs: T + 60_000 },
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('WI-NEW');
  });

  it('a throwing leg contributes nothing — the rest still land', async () => {
    const w = await buildStalenessWarnings(
      'su-me',
      'ws',
      seams({
        listOwnClaimsFn: async () => {
          throw new Error('pg down');
        },
        listHeldChangedSinceFn: async () => {
          throw new Error('pg down');
        },
        // Peer-claims leg is own-claims-dependent, so only fleet remains.
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('APPEARED after your summary');
  });

  it('is hard-capped at STALENESS_MAX_WARNINGS', async () => {
    const w = await buildStalenessWarnings(
      'su-me',
      'ws',
      seams({
        listOwnClaimsFn: async () =>
          Array.from({ length: 12 }, (_, i) => ({
            planSlug: 'p',
            itemId: `P-${i}`,
            expiresTsMs: NOW - 1,
          })),
      }),
    );
    expect(w.length).toBeLessThanOrEqual(STALENESS_MAX_WARNINGS);
  });
});
