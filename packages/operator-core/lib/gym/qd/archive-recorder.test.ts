import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { makeLoopQdSeams } from './archive-recorder';
import { QdArchive, InMemoryArchiveStore } from './archive';
import type { ArchiveCandidateRecord } from './niche';
import type { VariantOverlay } from '../variant-overlay';

// sql is unused when an archive is injected — the seams run entirely in-memory.
const NO_SQL = {} as unknown as Sql;

function rec(
  variantId: string,
  overlay: VariantOverlay,
  parentOverlay: VariantOverlay | null,
  fitness: number,
): ArchiveCandidateRecord {
  return { variantId, overlay, parentOverlay, fitness };
}

describe('makeLoopQdSeams', () => {
  it('records each variant and scores its distance-from-archive novelty (P-010 + P-011 share one archive)', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { recordArchive, noveltyForVariant } = makeLoopQdSeams(NO_SQL, { workspaceId: 'w', harnessSlug: 'h' }, { archive });

    // baseline: empty overlay → the degenerate niche (local|mixed|low).
    await recordArchive(rec('baseline', { promptOverrides: {} }, null, 7.0));
    // a candidate touching the worker role → a DIFFERENT niche (local|execution|low).
    await recordArchive(rec('cand-1', { promptOverrides: { worker: 'x'.repeat(50) } }, { promptOverrides: {} }, 7.5));

    // Both recorded → novelty is the archive's noveltyScore over the cached descriptor, in [0,1].
    const nvBaseline = await noveltyForVariant('baseline');
    const nvCand = await noveltyForVariant('cand-1');
    for (const nv of [nvBaseline, nvCand]) {
      expect(nv).toBeGreaterThanOrEqual(0);
      expect(nv).toBeLessThanOrEqual(1);
    }
    // Two elites in distinct niches ⇒ each is a positive distance from the other (excludeSelf).
    expect(nvBaseline).toBeGreaterThan(0);
    expect(nvCand).toBeGreaterThan(0);
  });

  it('returns maximal novelty (1) for a variant that was never recorded', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { noveltyForVariant } = makeLoopQdSeams(NO_SQL, { workspaceId: 'w', harnessSlug: 'h' }, { archive });
    expect(await noveltyForVariant('never-seen')).toBe(1);
  });

  it('upserts insert-if-better into the shared archive (one elite per niche, highest fitness wins)', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { recordArchive } = makeLoopQdSeams(NO_SQL, { workspaceId: 'w', harnessSlug: 'h' }, { archive });
    const overlay: VariantOverlay = { promptOverrides: { worker: 'x'.repeat(50) } };
    const parent: VariantOverlay = { promptOverrides: {} };
    await recordArchive(rec('lo', overlay, parent, 5.0));
    await recordArchive(rec('hi', overlay, parent, 9.0)); // same niche, higher fitness → replaces
    const elites = await archive.listElites();
    expect(elites).toHaveLength(1);
    expect(elites[0]!.candidateId).toBe('hi');
    expect(elites[0]!.fitness).toBe(9.0);
  });

  it('stamps the elite updatedAt from the injected clock', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { recordArchive } = makeLoopQdSeams(NO_SQL, { workspaceId: 'w', harnessSlug: 'h', now: () => 4242 }, { archive });
    await recordArchive(rec('only', { promptOverrides: { worker: 'y'.repeat(50) } }, { promptOverrides: {} }, 6.0));
    const elites = await archive.listElites();
    expect(elites[0]!.updatedAt).toBe(4242);
  });
});

/** Tagged-template sql fake capturing interpolated values per call (for the federation seam,
 *  which routes through markEliteFederatable(inject=sql)). */
function fakeSql(rowsToReturn: unknown[] = []): { sql: Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rowsToReturn);
  };
  return { sql: fn as unknown as Sql, calls };
}

const WORKER_OVERLAY: VariantOverlay = { promptOverrides: { worker: 'x'.repeat(50) } };
const EMPTY_OVERLAY: VariantOverlay = { promptOverrides: {} };

describe('makeLoopQdSeams — federateAcceptedElite (F1-4/P-014 elite publisher)', () => {
  it('stamps the accepted candidate\'s niche row federatable via the seam sql (no-signer tier-1)', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { sql, calls } = fakeSql([{ niche_key: 'n' }]);
    const seams = makeLoopQdSeams(sql, { workspaceId: 'papercusp-workspace', harnessSlug: 'h' }, { archive });
    await seams.recordArchive(rec('cand-1', WORKER_OVERLAY, EMPTY_OVERLAY, 7.5)); // caches the descriptor
    await seams.federateAcceptedElite('cand-1', { outcome: 'won' });
    // markEliteFederatable ran its single no-signer UPDATE with (workspaceId, harnessSlug, nicheKey).
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('papercusp-workspace');
    expect(calls[0][1]).toBe('h');
    expect(typeof calls[0][2]).toBe('string'); // the derived niche_key
    expect((calls[0][2] as string).length).toBeGreaterThan(0);
  });

  it('is a no-op (no sql) for a variant that was never recorded (no cached descriptor)', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { sql, calls } = fakeSql([{ niche_key: 'n' }]);
    const seams = makeLoopQdSeams(sql, { workspaceId: 'papercusp-workspace', harnessSlug: 'h' }, { archive });
    await seams.federateAcceptedElite('never-recorded', { outcome: 'won' });
    expect(calls).toHaveLength(0);
  });

  it('does NOT stamp a non-eligible outcome (markEliteFederatable D-002 guard, no sql)', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { sql, calls } = fakeSql([{ niche_key: 'n' }]);
    const seams = makeLoopQdSeams(sql, { workspaceId: 'papercusp-workspace', harnessSlug: 'h' }, { archive });
    await seams.recordArchive(rec('cand-1', WORKER_OVERLAY, EMPTY_OVERLAY, 7.5));
    await seams.federateAcceptedElite('cand-1', { outcome: 'lost', grade: 2 });
    expect(calls).toHaveLength(0);
  });

  it('THROWS (WI-1564 strand-guard) under a non-federating workspace — the loop calls it best-effort', async () => {
    const archive = new QdArchive(new InMemoryArchiveStore());
    const { sql } = fakeSql([{ niche_key: 'n' }]);
    const seams = makeLoopQdSeams(sql, { workspaceId: 'default', harnessSlug: 'h' }, { archive });
    await seams.recordArchive(rec('cand-1', WORKER_OVERLAY, EMPTY_OVERLAY, 7.5));
    await expect(seams.federateAcceptedElite('cand-1', { outcome: 'won' })).rejects.toThrow(/WI-1564/);
  });
});
