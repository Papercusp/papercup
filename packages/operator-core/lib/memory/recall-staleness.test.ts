/**
 * WI-36046 workstream A — the nightly anchor sweep's verdict reaching the AGENT.
 *
 * The property that actually matters here is not "the field is populated" but
 * "the warning SURVIVES the path a real consumer takes". `coord:orient` reduces
 * every recalled hit to `{ id, memory, score }` and then clips the body to
 * `MEMORY_TEXT_CAP`, so a design that put staleness in a sibling field would pass a
 * naive field-presence test and still deliver nothing to the most-called recall
 * surface we have. The orient-survival tests at the bottom are therefore the ones to
 * keep honest; the rest are ordinary unit coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  applyMemoryStaleness,
  loadMemoryStaleness,
  memoryStaleBanner,
  memoryStalenessIsNotable,
  STALENESS_ANCHOR_ROW_CAP,
  type MemoryStaleness,
} from './recall-staleness';
import { MEMORY_TEXT_CAP } from './recall-admission';

const stale = (anchors: Array<{ kind: string; value: string }>, at?: string): MemoryStaleness => ({
  stale: true,
  brokenAnchors: anchors,
  ...(at ? { lastCheckedAt: at } : {}),
});

/** A tagged-template stand-in for postgres.js that just yields fixed rows. */
function fakeSql(rows: unknown[]): never {
  return (() => Promise.resolve(rows)) as never;
}
/** …and one that fails the way a missing table / down PG does. */
function throwingSql(): never {
  return (() => {
    throw new Error('relation "harness_shared.memory_anchors" does not exist');
  }) as never;
}

describe('memoryStalenessIsNotable — absence of the field must MEAN something', () => {
  it('is false for undefined, so a hit with no verdict is never ambiguous', () => {
    expect(memoryStalenessIsNotable(undefined)).toBe(false);
  });

  it('is false for a verdict with no broken anchors (never emitted → absence means fine)', () => {
    expect(memoryStalenessIsNotable(stale([]))).toBe(false);
  });

  it('is true once any anchor is dead', () => {
    expect(memoryStalenessIsNotable(stale([{ kind: 'file', value: 'a.ts' }]))).toBe(true);
  });
});

describe('memoryStaleBanner', () => {
  it('names the dead anchors with their kind', () => {
    const b = memoryStaleBanner(stale([{ kind: 'file', value: 'packages/x.ts' }]));
    expect(b).toContain('⚠ STALE');
    expect(b).toContain('file:packages/x.ts');
  });

  it('collapses past the second anchor into a +N count rather than growing unbounded', () => {
    const b = memoryStaleBanner(
      stale([
        { kind: 'file', value: 'a.ts' },
        { kind: 'plan', value: 'b' },
        { kind: 'migration', value: 'c' },
        { kind: 'feature', value: 'd' },
      ]),
    );
    expect(b).toContain('file:a.ts');
    expect(b).toContain('plan:b');
    expect(b).toContain('+2');
    expect(b).not.toContain('migration:c');
  });

  it('truncates a long anchor value instead of letting one path blow the banner', () => {
    const long = `packages/operator-core/lib/${'deep/'.repeat(20)}thing.ts`;
    const b = memoryStaleBanner(stale([{ kind: 'file', value: long }]));
    expect(b).toContain('…');
    expect(b.length).toBeLessThan(long.length);
  });

  /**
   * These four values are VERBATIM from the live corpus (the 2026-08-08 sweep), and
   * they are here because a synthetic fixture did not catch this: an earlier
   * tail-only truncation looked fine on invented paths and, on the real data,
   * rendered a plan slug as its DATE (`…on-api-2026-06-14`) and a module as a
   * basename dozens of packages share (`…ess/src/schema.ts`). Keeping both ends is
   * the property; these are the cases that falsify a one-ended rule.
   */
  it.each([
    ['plan', 'experiment-registry-invocation-api-2026-06-14', 'experiment', '2026-06-14'],
    ['plan', 'impartial-benchmark-suite-2026-06-15', 'impartial', '2026-06-15'],
    ['file', 'libs/zero-harness/src/schema.ts', 'libs/zero', 'schema.ts'],
    ['file', 'libs/papercusp/packages/harness/blueprints/base/prompts/queen.base.md', 'libs/pape', 'queen.base.md'],
  ])('keeps BOTH ends identifying for the real anchor %s:%s', (kind, value, head, tail) => {
    const b = memoryStaleBanner(stale([{ kind, value }]));
    expect(b).toContain(head);
    expect(b).toContain(tail);
  });

  it('two anchors that share a long prefix stay distinguishable', () => {
    const b = memoryStaleBanner(
      stale([
        { kind: 'file', value: 'packages/operator-core/lib/memory/alpha.ts' },
        { kind: 'file', value: 'packages/operator-core/lib/memory/omega.ts' },
      ]),
    );
    expect(b).toContain('alpha.ts');
    expect(b).toContain('omega.ts');
  });

  /**
   * CALIBRATION for the survival tests below: the banner must fit well inside
   * orient's per-hit cap, or the warning arrives having eaten the memory it is
   * warning about. Worst realistic case = two long paths + an overflow count.
   */
  it('stays a minority of MEMORY_TEXT_CAP even at its worst', () => {
    const b = memoryStaleBanner(
      stale([
        { kind: 'file', value: 'packages/operator-core/lib/some/quite/long/path/module.ts' },
        { kind: 'migration', value: 'libs/papercusp/libs/db/sql/085-memory-anchors.sql' },
        { kind: 'plan', value: 'x' },
      ]),
    );
    expect(b.length).toBeLessThan(MEMORY_TEXT_CAP / 2);
  });
});

describe('applyMemoryStaleness', () => {
  const rows = [
    { id: 'm1', memory: 'the fix lives in packages/x.ts', score: 0.9 },
    { id: 'm2', memory: 'unrelated healthy fact', score: 0.8 },
  ];

  it('prepends the banner to the body AND attaches the structured field', () => {
    const out = applyMemoryStaleness(rows, new Map([['m1', stale([{ kind: 'file', value: 'packages/x.ts' }])]]));
    expect(out[0].memory).toMatch(/^⚠ STALE/);
    expect(out[0].memory).toContain('the fix lives in packages/x.ts');
    expect(out[0].staleness).toMatchObject({ stale: true, broken_anchors: [{ kind: 'file', value: 'packages/x.ts' }] });
  });

  it('leaves a healthy row completely untouched — no field, no banner', () => {
    const out = applyMemoryStaleness(rows, new Map([['m1', stale([{ kind: 'file', value: 'packages/x.ts' }])]]));
    expect(out[1]).toEqual(rows[1]);
    expect(out[1].staleness).toBeUndefined();
  });

  it('returns the input array by identity when there are no verdicts (zero cost on the happy path)', () => {
    const out = applyMemoryStaleness(rows, new Map());
    expect(out).toBe(rows);
  });

  it('carries lastCheckedAt through as last_checked_at when the sweep recorded one', () => {
    const out = applyMemoryStaleness(
      rows,
      new Map([['m1', stale([{ kind: 'plan', value: 'p' }], '2026-08-08T09:00:05.619Z')]]),
    );
    expect(out[0].staleness).toMatchObject({ last_checked_at: '2026-08-08T09:00:05.619Z' });
  });

  it('does not throw on a row whose memory was shaped away (tier clipping, odd backends)', () => {
    const odd: Array<{ id: string; score: number; memory?: string }> = [{ id: 'm1', score: 0.5 }];
    const out = applyMemoryStaleness(odd, new Map([['m1', stale([{ kind: 'file', value: 'a.ts' }])]]));
    expect(out[0].staleness).toBeDefined();
    expect(out[0].memory).toBeUndefined();
  });

  it('ignores a row with no usable id rather than mis-attributing a verdict', () => {
    const anon = [{ memory: 'no id here' }];
    const out = applyMemoryStaleness(anon, new Map([['m1', stale([{ kind: 'file', value: 'a.ts' }])]]));
    expect(out[0]).toEqual(anon[0]);
  });
});

describe('loadMemoryStaleness', () => {
  it('groups several dead anchors onto one memory', async () => {
    const out = await loadMemoryStaleness(
      fakeSql([
        { memory_id: 'm1', kind: 'file', value: 'a.ts', last_checked_at: '2026-08-08T09:00:00Z' },
        { memory_id: 'm1', kind: 'plan', value: 'p1', last_checked_at: '2026-08-08T09:00:00Z' },
        { memory_id: 'm2', kind: 'migration', value: '085', last_checked_at: '2026-08-08T09:00:00Z' },
      ]),
      ['m1', 'm2'],
    );
    expect(out.get('m1')?.brokenAnchors).toHaveLength(2);
    expect(out.get('m2')?.brokenAnchors).toHaveLength(1);
  });

  it('keeps the MOST RECENT check across a memory’s anchors', async () => {
    const out = await loadMemoryStaleness(
      fakeSql([
        { memory_id: 'm1', kind: 'file', value: 'a.ts', last_checked_at: '2026-07-01T00:00:00Z' },
        { memory_id: 'm1', kind: 'plan', value: 'p1', last_checked_at: '2026-08-08T09:00:00Z' },
      ]),
      ['m1'],
    );
    expect(out.get('m1')?.lastCheckedAt).toBe('2026-08-08T09:00:00.000Z');
  });

  it('normalizes the driver’s non-ISO timestamp form (the webview cannot parse it)', async () => {
    const out = await loadMemoryStaleness(
      fakeSql([{ memory_id: 'm1', kind: 'file', value: 'a.ts', last_checked_at: '2026-06-09 16:08:51.83-04' }]),
      ['m1'],
    );
    expect(out.get('m1')?.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('skips an anchor row with no value instead of emitting a bare kind', async () => {
    const out = await loadMemoryStaleness(
      fakeSql([{ memory_id: 'm1', kind: 'file', value: '  ', last_checked_at: null }]),
      ['m1'],
    );
    expect(out.has('m1')).toBe(false);
  });

  it('FAIL-OPEN: a missing table / down PG yields no verdicts and never throws', async () => {
    await expect(loadMemoryStaleness(throwingSql(), ['m1'])).resolves.toEqual(new Map());
  });

  it('does not query at all for an empty id list', async () => {
    let called = false;
    const spy = (() => {
      called = true;
      return Promise.resolve([]);
    }) as never;
    expect(await loadMemoryStaleness(spy, [])).toEqual(new Map());
    expect(called).toBe(false);
  });

  it('caps the anchor read so one pathological memory cannot unbound a recall', () => {
    expect(STALENESS_ANCHOR_ROW_CAP).toBeGreaterThan(20);
    expect(STALENESS_ANCHOR_ROW_CAP).toBeLessThanOrEqual(1000);
  });
});

/**
 * THE POINT OF THE WHOLE WORKSTREAM.
 *
 * These reproduce orient's fold exactly (orient.ts:918-922): keep only
 * { id, memory, score }, then clip the body to MEMORY_TEXT_CAP. Each carries its own
 * deliberately-wrong CONTROL, so the test cannot pass for the trivial reason that
 * everything survives a 200-char slice — the control shows what a sibling-field or
 * appended-banner design would have delivered to the agent, which is nothing.
 */
describe('survives the coord:orient fold (the property a sibling field would fail)', () => {
  const foldLikeOrient = (row: Record<string, unknown>) => ({
    id: row.id,
    memory: typeof row.memory === 'string' ? row.memory.slice(0, MEMORY_TEXT_CAP) : undefined,
    score: row.score,
  });

  const longBody = 'a durable fact about the build pipeline. '.repeat(20);
  const verdicts = new Map([['m1', stale([{ kind: 'file', value: 'packages/gone.ts' }])]]);

  it('the banner reaches the agent even after the fold drops fields and clips the body', () => {
    const [folded] = applyMemoryStaleness([{ id: 'm1', memory: longBody, score: 0.9 }], verdicts).map(foldLikeOrient);
    expect(folded.memory).toContain('⚠ STALE');
    expect(folded.memory).toContain('packages/gone.ts');
    expect(folded.memory!.length).toBeLessThanOrEqual(MEMORY_TEXT_CAP);
  });

  it('CONTROL — a sibling-field-only design delivers no warning through the same fold', () => {
    const siblingOnly = [{ id: 'm1', memory: longBody, score: 0.9, staleness: { stale: true } }];
    const [folded] = siblingOnly.map(foldLikeOrient);
    expect((folded as Record<string, unknown>).staleness).toBeUndefined();
    expect(folded.memory).not.toContain('STALE');
  });

  it('CONTROL — an APPENDED banner is clipped away entirely by the same fold', () => {
    const appended = [{ id: 'm1', memory: `${longBody}${memoryStaleBanner(stale([{ kind: 'file', value: 'packages/gone.ts' }]))}`, score: 0.9 }];
    const [folded] = appended.map(foldLikeOrient);
    expect(folded.memory).not.toContain('STALE');
  });

  it('still leaves real memory content after the banner, not just the warning', () => {
    const [folded] = applyMemoryStaleness([{ id: 'm1', memory: longBody, score: 0.9 }], verdicts).map(foldLikeOrient);
    const body = folded.memory!.slice(folded.memory!.indexOf("Verify, don't rely. ") + "Verify, don't rely. ".length);
    expect(body.length).toBeGreaterThan(60);
    expect(body).toContain('durable fact');
  });
});
