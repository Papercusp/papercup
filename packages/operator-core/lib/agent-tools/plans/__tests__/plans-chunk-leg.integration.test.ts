/**
 * plans:search's chunk-aware semantic leg against a real Postgres + pgvector
 * (generic-rag-chunking P-009, D-014, D-026).
 *
 * queryTopPlansReal ranks each plan by the nearer of its own vector (title +
 * first 2,000 characters) and its window chunks in harness_shared.text_chunks,
 * and names the section the winning window fell in. The fixtures are real
 * harness_plans + text_chunks rows under a throwaway harness.
 *
 * Vectors are unit vectors in the plane of the first two of the 768 prose
 * dimensions, given by an angle in degrees from the query, so every expected
 * ranking can be read off the angles (cosine distance = 1 - cos(angle)).
 *
 *   - a plan whose only near match is a chunk past the 2,000-character cut
 *     ranks first, and reports the section that chunk fell in;
 *   - without its chunks it drops below a plan whose own vector is nearer
 *     (the control: the chunk rows are what lift it);
 *   - a tie between a plan's vector and its chunk reports no section;
 *   - the archived filter applies inside the chunk leg too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { PROSE_VECTOR_DIMS, PROSE_VECTOR_STORAGE_PROFILE } from '../../../search/prose-vector-dims';
import { PLANS_CHUNK_SURFACE } from '../../../search/chunks/registry';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';
import { planWindowMidpoint, queryTopPlansReal } from '../semantic-leg';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plans-chunk-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;
const PROFILE = PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds[0]!;
const MODE = PROFILE.startsWith('gemma') ? 'gemma' : 'openai';
const IDENTITY = { profileId: PROFILE, legacyMode: MODE };

const unit = (deg: number): number[] => {
  const v = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
  const r = (deg * Math.PI) / 180;
  v[0] = Math.cos(r);
  v[1] = Math.sin(r);
  return v;
};
const lit = (deg: number): string => `[${unit(deg).join(',')}]`;
const similarity = (deg: number): number => Math.cos((deg * Math.PI) / 180);

const SLUG_TAIL = 'zzz-chunk-tail-match';
const SLUG_NEAR = 'zzz-chunk-near-parent';
const SLUG_TIE = 'zzz-chunk-tie';
const SLUG_ARCHIVED = 'zzz-chunk-archived';

/**
 * A plan whose sections sit at known offsets: '## D-777 Zebra' starts before the
 * midpoint of window 2 (3,250) and '## D-778 Later' after it, so window 2 is
 * attributed to D-777 and a scan that ran past the midpoint would say D-778.
 */
function tailPlan(): string {
  const head = `# Tail match plan\n\n## Now\n${'intro '.repeat(300)}\n`;
  const zebraAt = 2800;
  const beforeZebra = head + 'x'.repeat(Math.max(0, zebraAt - head.length - 1)) + '\n';
  const zebra = `## D-777 Zebra\n${'the zebra decision '.repeat(40)}\n`;
  const later = `## D-778 Later\n${'later text '.repeat(200)}\n`;
  return beforeZebra + zebra + later;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

async function setPlanVector(slug: string, deg: number, opts: { archived?: boolean; title?: string } = {}) {
  await admin`
    UPDATE harness_shared.harness_plans
       SET embedding = ${lit(deg)}::vector, embedding_profile = ${PROFILE}, embedding_mode = ${MODE},
           title = ${opts.title ?? slug}, archived = ${opts.archived ?? false}
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
}

async function addChunk(slug: string, chunkIdx: number, deg: number) {
  await admin`
    INSERT INTO harness_shared.text_chunks
      (surface, parent_key, chunk_idx, header, content, parent_sha, chunk_sha, splitter_version,
       embedding, embedding_profile, embedding_mode)
    VALUES (${PLANS_CHUNK_SURFACE.surface}, ${[WS, HARNESS, slug]}::text[], ${chunkIdx}, ${slug},
            ${`chunk ${chunkIdx} of ${slug}`}, 'parent-sha', ${`${slug}-${chunkIdx}`}, 'test',
            ${lit(deg)}::vector, ${PROFILE}, ${MODE})`;
}

async function dropChunks(slug: string) {
  await admin`
    DELETE FROM harness_shared.text_chunks
     WHERE surface = ${PLANS_CHUNK_SURFACE.surface} AND parent_key = ${[WS, HARNESS, slug]}::text[]`;
}

const search = (opts: { includeArchived?: boolean; limit?: number } = {}) =>
  queryTopPlansReal(unit(0), MODE, { harnessSlug: HARNESS, limit: opts.limit ?? 10, ...opts }, IDENTITY);

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, WS, HARNESS, SLUG_TAIL, tailPlan());
  await seedPlan(admin, WS, HARNESS, SLUG_NEAR, '# Near parent plan\n\n## Now\nshort plan\n');
  await seedPlan(admin, WS, HARNESS, SLUG_TIE, '# Tie plan\n\n## Only\nshort plan\n');
  await seedPlan(admin, WS, HARNESS, SLUG_ARCHIVED, '# Archived plan\n\n## Gone\nshort plan\n');
  // Query angle 0. Tail plan: own vector far (80°), window 2 near (5°), window 0 mid (60°).
  await setPlanVector(SLUG_TAIL, 80);
  await addChunk(SLUG_TAIL, 0, 60);
  await addChunk(SLUG_TAIL, 2, 5);
  // Near-parent plan: own vector at 30°, no chunks.
  await setPlanVector(SLUG_NEAR, 30);
  // Tie plan: own vector and its only chunk both at 45°.
  await setPlanVector(SLUG_TIE, 45);
  await addChunk(SLUG_TIE, 0, 45);
  // Archived plan: the nearest chunk of all (1°), but archived.
  await setPlanVector(SLUG_ARCHIVED, 85, { archived: true });
  await addChunk(SLUG_ARCHIVED, 0, 1);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.text_chunks
                 WHERE surface = ${PLANS_CHUNK_SURFACE.surface} AND parent_key[2] = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('plans:search chunk-aware semantic leg (P-009)', () => {
  it('the fixture puts D-777 before window 2\'s midpoint and D-778 after it', () => {
    const content = tailPlan();
    expect(content.length).toBeGreaterThan(2000); // past the parent vector's cut
    expect(content.indexOf('## D-777 Zebra')).toBeLessThan(planWindowMidpoint(2));
    expect(content.indexOf('## D-778 Later')).toBeGreaterThan(planWindowMidpoint(2));
  });

  it('a plan matched only past the cut ranks first and names the section its window fell in', async () => {
    const hits = await search();
    expect(hits.map((h) => h.slug)).toEqual([SLUG_TAIL, SLUG_NEAR, SLUG_TIE]);
    const tail = hits[0]!;
    expect(tail.matchedSection).toBe('D-777 Zebra');
    // pgvector stores float4 components, so similarity matches float64 math to ~1e-6.
    expect(tail.similarity).toBeCloseTo(similarity(5), 5);
    expect(tail.harness).toBe(HARNESS);
    expect(tail.title).toBe(SLUG_TAIL);
    // The plan's own vector won: no section.
    expect(hits[1]!.matchedSection).toBeUndefined();
    expect(hits[1]!.similarity).toBeCloseTo(similarity(30), 5);
  });

  it('a tie between a plan\'s own vector and its chunk goes to the plan: no section', async () => {
    const tie = (await search()).find((h) => h.slug === SLUG_TIE)!;
    expect(tie.similarity).toBeCloseTo(similarity(45), 5);
    expect(tie.matchedSection).toBeUndefined();
  });

  it('the archived filter applies inside the chunk leg, before its LIMIT', async () => {
    // With the filter applied after the LIMIT, the archived plan's 1° chunk would
    // take the only slot and the leg would return nothing.
    expect((await search({ limit: 1 })).map((h) => h.slug)).toEqual([SLUG_TAIL]);
    const withArchived = await search({ includeArchived: true });
    expect(withArchived[0]!.slug).toBe(SLUG_ARCHIVED);
    expect(withArchived[0]!.archived).toBe(true);
  });

  it('a chunk embedded in another space is not read', async () => {
    const other = PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds.find((p) => p !== PROFILE);
    if (!other) return; // one accepted profile: nothing to separate
    const hits = await queryTopPlansReal(unit(0), MODE, { harnessSlug: HARNESS, limit: 10 }, {
      profileId: other,
      legacyMode: null,
    });
    expect(hits).toEqual([]);
  });

  it('control: without its chunks, the tail plan falls below the plan whose own vector is nearer', async () => {
    await dropChunks(SLUG_TAIL);
    try {
      const hits = await search();
      expect(hits.map((h) => h.slug)).toEqual([SLUG_NEAR, SLUG_TIE, SLUG_TAIL]);
      const tail = hits.find((h) => h.slug === SLUG_TAIL)!;
      expect(tail.similarity).toBeCloseTo(similarity(80), 5);
      expect(tail.matchedSection).toBeUndefined();
    } finally {
      await addChunk(SLUG_TAIL, 0, 60);
      await addChunk(SLUG_TAIL, 2, 5);
    }
  });
});
