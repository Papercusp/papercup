import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SOCIAL_CURSOR_BOUNDARY_FIELDS,
  SOCIAL_CURSOR_INSTANT_FIELDS,
  SOCIAL_CURSOR_POSITION_FIELDS,
  socialCursorFreshness,
} from './cursor-freshness';

const NOW = Date.parse('2026-08-23T20:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* The four states, against the REAL cursor shapes each adapter persists.      */
/* -------------------------------------------------------------------------- */

describe('socialCursorFreshness — real adapter cursor shapes', () => {
  it('reads a watermark cursor as synced and computes its age', () => {
    // threads / facebook-pages / youtube-comments all persist this shape.
    const result = socialCursorFreshness(
      { watermark: '2026-08-23T19:00:00.000Z', boundaryIds: ['a', 'b'] },
      NOW,
    );
    expect(result.state).toBe('synced');
    expect(result.at).toBe('2026-08-23T19:00:00.000Z');
    expect(result.ageMs).toBe(3_600_000);
  });

  it('reads instagram’s drifted boundary-field spelling as synced', () => {
    // InstagramWatermark uses `seenAtWatermark`, not `boundaryIds` (WI-41027).
    // The boundary field must not affect the verdict either way.
    const result = socialCursorFreshness(
      { watermark: '2026-08-23T19:30:00.000Z', seenAtWatermark: ['c'] },
      NOW,
    );
    expect(result.state).toBe('synced');
    expect(result.ageMs).toBe(1_800_000);
  });

  it('reads youtube activities’ publishedAfter as the instant', () => {
    const result = socialCursorFreshness(
      { publishedAfter: '2026-08-23T18:00:00.000Z', boundaryIds: [] },
      NOW,
    );
    expect(result.state).toBe('synced');
    expect(result.at).toBe('2026-08-23T18:00:00.000Z');
    expect(result.ageMs).toBe(7_200_000);
  });

  it('accepts the ISO 8601 BASIC offset instagram actually emits', () => {
    // Instagram documents `2017-05-19T23:27:28+0000` — no colon in the offset.
    // A cursor spelled that way must not read as unparseable.
    const result = socialCursorFreshness({ watermark: '2026-08-23T19:00:00+0000' }, NOW);
    expect(result.state).toBe('synced');
    expect(result.ageMs).toBe(3_600_000);
  });

  it('reads reddit’s fullname cursor as position-only, NOT never-synced', () => {
    // This is the case the four-state model exists for: reddit is working
    // perfectly and can never report a time.
    const result = socialCursorFreshness({ newestFullname: 't3_abc123' }, NOW);
    expect(result.state).toBe('position-only');
    expect(result.position).toBe('newestFullname=t3_abc123');
    expect(result.ageMs).toBeNull();
    expect(result.at).toBeNull();
  });

  it('reads a bluesky cursor with no lastEventAt as position-only', () => {
    const result = socialCursorFreshness({ seq: 12345 }, NOW);
    expect(result.state).toBe('position-only');
    expect(result.position).toBe('seq=12345');
  });

  it('treats an explicitly null lastEventAt as absent, not as a bad instant', () => {
    // `lastEventAt?: string | null` — a null must degrade to position-only
    // rather than being reported as an unparseable instant.
    const result = socialCursorFreshness({ seq: 7, lastEventAt: null }, NOW);
    expect(result.state).toBe('position-only');
  });

  it('promotes a bluesky cursor to synced once lastEventAt is recorded', () => {
    const result = socialCursorFreshness(
      { seq: 7, lastEventAt: '2026-08-23T19:45:00.000Z' },
      NOW,
    );
    expect(result.state).toBe('synced');
    expect(result.ageMs).toBe(900_000);
    // The position is still reported alongside the instant.
    expect(result.position).toBe('seq=7');
  });

  it('reads a mastodon minId cursor as position-only', () => {
    const result = socialCursorFreshness({ minId: '109834' }, NOW);
    expect(result.state).toBe('position-only');
    expect(result.position).toBe('minId=109834');
  });

  it('reads the cold-start empty object as never-synced', () => {
    // source-store persists `input.cursor ?? {}` on create, so `{}` is the
    // literal cold shape — it must not read as `unrecognized`.
    expect(socialCursorFreshness({}, NOW).state).toBe('never-synced');
    expect(socialCursorFreshness(null, NOW).state).toBe('never-synced');
    expect(socialCursorFreshness(undefined, NOW).state).toBe('never-synced');
  });

  it('reads an unknown cursor shape as unrecognized and names its fields', () => {
    const result = socialCursorFreshness({ someNewField: 'x', other: 2 }, NOW);
    expect(result.state).toBe('unrecognized');
    expect(result.detail).toContain('other, someNewField');
  });

  it('reads a known instant field holding garbage as unrecognized, not synced', () => {
    const result = socialCursorFreshness({ watermark: 'not-a-timestamp' }, NOW);
    expect(result.state).toBe('unrecognized');
    expect(result.detail).toContain('watermark');
  });

  it('reports a negative age rather than clamping provider clock skew', () => {
    const result = socialCursorFreshness({ watermark: '2026-08-23T20:05:00.000Z' }, NOW);
    expect(result.state).toBe('synced');
    expect(result.ageMs).toBe(-300_000);
  });

  it('is a pure function of nowMs', () => {
    const cursor = { watermark: '2026-08-23T19:00:00.000Z' };
    expect(socialCursorFreshness(cursor, NOW).ageMs).toBe(3_600_000);
    expect(socialCursorFreshness(cursor, NOW + 1000).ageMs).toBe(3_601_000);
  });

  it('ignores an array, which is an object but never a cursor', () => {
    expect(socialCursorFreshness([1, 2, 3], NOW).state).toBe('never-synced');
  });
});

/* -------------------------------------------------------------------------- */
/* DRIFT PIN — the classifier must cover every real cursor interface.          */
/* -------------------------------------------------------------------------- */

interface ParsedCursorInterface {
  file: string;
  name: string;
  fields: string[];
}

/**
 * Parse every `export interface *Cursor` / `*Watermark` in the social dir.
 *
 * This reads the ADAPTERS rather than a hand-kept list, because the failure this
 * guards against is precisely someone adding a ninth cursor shape and this
 * module degrading it to `unrecognized` — a silent "never synced" in the pane.
 */
function parseCursorInterfaces(): ParsedCursorInterface[] {
  // Overridable so falsifiability can be proven against a COPY outside the
  // repo (mutation-probe tier 2) instead of mutating this shared, swept tree.
  const dir = process.env.SOCIAL_CURSOR_DIR ?? __dirname;
  const parsed: ParsedCursorInterface[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.fixture.ts')) continue;
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^export interface (\w*(?:Cursor|Watermark))\s*\{/.exec(lines[i] ?? '');
      if (!match) continue;
      const fields: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j] ?? '';
        if (/^\}/.test(line)) break;
        const field = /^\s{2}(\w+)\??:/.exec(line);
        if (field?.[1]) fields.push(field[1]);
      }
      parsed.push({ file, name: match[1] as string, fields });
    }
  }
  return parsed;
}

describe('cursor-freshness drift pin', () => {
  const parsed = parseCursorInterfaces();

  it('finds the social cursor interfaces (positive control)', () => {
    // If this instrument ever stops finding interfaces, the coverage assertion
    // below would pass vacuously — so prove the parser works before trusting it.
    expect(parsed.length).toBeGreaterThanOrEqual(8);
    const names = parsed.map((entry) => entry.name);
    expect(names).toContain('SocialWatermarkCursor');
    expect(names).toContain('RedditCursor');
    expect(names).toContain('InstagramWatermark');
    expect(names).toContain('BlueskyCursor');
    for (const entry of parsed) expect(entry.fields.length).toBeGreaterThan(0);
  });

  it('classifies every field of every real cursor interface', () => {
    const known = new Set<string>([
      ...SOCIAL_CURSOR_INSTANT_FIELDS,
      ...SOCIAL_CURSOR_POSITION_FIELDS,
      ...SOCIAL_CURSOR_BOUNDARY_FIELDS,
    ]);
    const unclassified = parsed.flatMap((entry) =>
      entry.fields
        .filter((field) => !known.has(field))
        .map((field) => `${entry.file}:${entry.name}.${field}`),
    );
    expect(
      unclassified,
      'a social cursor field is not classified by cursor-freshness.ts — add it to the ' +
        'INSTANT / POSITION / BOUNDARY list, or the admin pane will report this ' +
        "platform as 'never synced' forever",
    ).toEqual([]);
  });

  it('gives every cursor interface a non-never-synced verdict from a representative value', () => {
    // Coverage is not the same as correctness: prove each real shape actually
    // resolves to a usable verdict, not merely that its field names are listed.
    const representative: Record<string, unknown> = {
      watermark: '2026-08-23T19:00:00.000Z',
      publishedAfter: '2026-08-23T19:00:00.000Z',
      lastEventAt: '2026-08-23T19:00:00.000Z',
      minId: '1',
      seq: 1,
      newestFullname: 't3_a',
      boundaryIds: [],
      seenAtWatermark: [],
    };
    for (const entry of parsed) {
      const cursor: Record<string, unknown> = {};
      for (const field of entry.fields) cursor[field] = representative[field];
      const verdict = socialCursorFreshness(cursor, NOW);
      expect(
        ['synced', 'position-only'],
        `${entry.name} resolved to ${verdict.state}`,
      ).toContain(verdict.state);
    }
  });
});
