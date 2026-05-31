/**
 * R8-A: Tests for the writeProvenance pure helper extracted from
 * /features/import. Covers the four observability paths added by F2:
 *   1. happy path — every feature updates
 *   2. trigger race — UPDATE matches 0 rows → consolidated_row_missing
 *   3. per-row exception — error captured per-feature, others continue
 *   4. PG connect error — every feature surfaces 'pg_unavailable: <msg>'
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { writeProvenance, type ProvenanceFeature } from '../features';

// writeProvenance logs warnings on errors as part of its observability
// contract. Tests verify the error data structure; suppress the warn
// noise here so vitest-fail-on-console doesn't fail the suite.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

const FEATURES: ProvenanceFeature[] = [
  { id: 'F-AUTO-AAA', source_plan_slug: 'p-2026-05-25', source_plan_item_ids: ['P-001'] },
  { id: 'F-AUTO-BBB', source_plan_slug: 'p-2026-05-25', source_plan_item_ids: ['P-002'] },
];

describe('writeProvenance — happy path', () => {
  it('counts every successful UPDATE and returns empty errors', async () => {
    const updater = vi.fn(async () => 1);
    const r = await writeProvenance(FEATURES, 'myharn', updater);
    expect(r.written).toBe(2);
    expect(r.errors).toEqual([]);
    expect(updater).toHaveBeenCalledTimes(2);
  });

  it('passes feature + harness through to the updater', async () => {
    const calls: Array<{ id: string; slug: string }> = [];
    await writeProvenance(
      FEATURES,
      'myharn',
      async (f, slug) => {
        calls.push({ id: f.id, slug });
        return 1;
      },
    );
    expect(calls).toEqual([
      { id: 'F-AUTO-AAA', slug: 'myharn' },
      { id: 'F-AUTO-BBB', slug: 'myharn' },
    ]);
  });

  it('carries the promote wave through to the updater', async () => {
    const waved: ProvenanceFeature[] = [
      { id: 'F-W', source_plan_slug: 'p', source_plan_item_ids: ['P-001'], wave: 'tier1' },
    ];
    let seenWave: string | null | undefined = 'UNSET';
    await writeProvenance(waved, 'h', async (f) => {
      seenWave = f.wave;
      return 1;
    });
    expect(seenWave).toBe('tier1');
  });
});

describe('writeProvenance — trigger-race / consolidated row missing', () => {
  it('surfaces consolidated_row_missing when UPDATE matches 0 rows', async () => {
    const updater = vi.fn(async () => 0);
    const r = await writeProvenance(FEATURES, 'h', updater);
    expect(r.written).toBe(0);
    expect(r.errors).toEqual([
      { feature_id: 'F-AUTO-AAA', error: 'consolidated_row_missing' },
      { feature_id: 'F-AUTO-BBB', error: 'consolidated_row_missing' },
    ]);
  });

  it('mixes success and missing in one batch', async () => {
    let i = 0;
    const updater = async () => (i++ === 0 ? 1 : 0);
    const r = await writeProvenance(FEATURES, 'h', updater);
    expect(r.written).toBe(1);
    expect(r.errors).toEqual([
      { feature_id: 'F-AUTO-BBB', error: 'consolidated_row_missing' },
    ]);
  });
});

describe('writeProvenance — per-row exception', () => {
  it('captures the error and continues with remaining features', async () => {
    let i = 0;
    const updater = async () => {
      i++;
      if (i === 1) throw new Error('connection terminated');
      return 1;
    };
    const r = await writeProvenance(FEATURES, 'h', updater);
    expect(r.written).toBe(1);
    expect(r.errors).toEqual([
      { feature_id: 'F-AUTO-AAA', error: 'connection terminated' },
    ]);
  });

  it('handles non-Error throws by stringifying', async () => {
    const updater = async () => {
      throw 'plain string error';
    };
    const r = await writeProvenance([FEATURES[0]], 'h', updater);
    expect(r.errors).toEqual([
      { feature_id: 'F-AUTO-AAA', error: 'plain string error' },
    ]);
  });
});

describe('writeProvenance — PG connect failure', () => {
  it('surfaces pg_unavailable for every feature when pgConnectError is set', async () => {
    const r = await writeProvenance(FEATURES, 'h', null, 'org PG offline');
    expect(r.written).toBe(0);
    expect(r.errors).toEqual([
      { feature_id: 'F-AUTO-AAA', error: 'pg_unavailable: org PG offline' },
      { feature_id: 'F-AUTO-BBB', error: 'pg_unavailable: org PG offline' },
    ]);
  });

  it('returns empty when no features have provenance (no work to do)', async () => {
    const r = await writeProvenance([], 'h', null, null);
    expect(r).toEqual({ written: 0, errors: [] });
  });
});

describe('writeProvenance — null updater (no provenance attempted)', () => {
  it('returns empty errors when updater is null and no pg error', async () => {
    const r = await writeProvenance(FEATURES, 'h', null);
    expect(r.written).toBe(0);
    expect(r.errors).toEqual([]);
  });
});
