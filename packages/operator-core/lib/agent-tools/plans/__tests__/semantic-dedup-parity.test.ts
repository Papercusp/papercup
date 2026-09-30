/**
 * plans:new's near-duplicate classifier, pinned to the SHARED parity fixture
 * (shared-vector-search-libraries-2026-09-29 P-004, AUTO-BAR-R-7).
 *
 * The fixture lives with the library (libs/generic/search/src/__fixtures__/
 * near-duplicate-parity-cases.json) and its expected outputs were produced by
 * THIS classifier before P-004 moved the cut into @papercusp/search. The
 * library's own near-duplicate.test.ts asserts the same expectations, so the
 * two suites together say: the library and papercusp's classifier return the
 * same cut and the same kept/dropped partition on every pinned case.
 *
 * Written BEFORE the move on purpose. After plans:new is rewired onto the
 * library this file must still pass unchanged; a failure then means the
 * rewiring changed behaviour, not that the fixture is wrong.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

import { confirmSimilarPlans, type PlanConfirmDeps } from '../semantic-dedup';
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';

interface BackgroundSpec {
  seed?: number;
  n: number;
  lo?: number;
  hi?: number;
  constant?: number;
  extra?: string[];
}
interface ParityCase {
  name: string;
  background: BackgroundSpec;
  quantile?: number;
  absoluteOverride?: number;
  candidates: Array<{ key: string; similarity: number | null }>;
  expected: {
    verdict: boolean;
    calibration: { basis: string; cut: number; backgroundSamples: number; quantile?: number } | null;
    kept: Array<{ key: string; similarity?: number }>;
    dropped: Array<{ key: string; similarity: number }>;
    backgroundRead: boolean;
    backgroundLimit?: number;
    backgroundExclude?: string[];
  };
}

const FIXTURE_URL = new URL(
  '../../../../../../libs/generic/search/src/__fixtures__/near-duplicate-parity-cases.json',
  import.meta.url,
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as { cases: ParityCase[] };

/** The fixture's documented generator — the same one the library suite uses. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function backgroundOf(spec: BackgroundSpec): number[] {
  const out: number[] = [];
  if (spec.constant !== undefined) for (let i = 0; i < spec.n; i++) out.push(spec.constant);
  else {
    const r = mulberry32(spec.seed!);
    for (let i = 0; i < spec.n; i++) out.push(Math.round((spec.lo! + (spec.hi! - spec.lo!) * r()) * 1e6) / 1e6);
  }
  for (const x of spec.extra ?? []) out.push(Number(x));
  return out;
}

afterEach(() => {
  delete process.env.PAPERCUSP_PLAN_DUPE_CONFIRM;
  delete process.env.PAPERCUSP_PLAN_DUPE_QUANTILE;
});

async function runHost(c: ParityCase) {
  const sims = new Map<string, number>();
  for (const cand of c.candidates) if (cand.similarity !== null) sims.set(cand.key, cand.similarity);
  const reads = { background: 0, limit: undefined as number | undefined, exclude: undefined as string[] | undefined };
  const deps: PlanConfirmDeps = {
    resolveEmbedder: async () => ({
      mode: 'gemma',
      dims: PROSE_VECTOR_DIMS,
      profile: EMBEDDER_DIM_SPECS.gemma,
      embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
    }),
    querySimilarities: async () => sims,
    queryBackgroundSimilarities: async (_vec, _mode, exclude, limit) => {
      reads.background++;
      reads.limit = limit;
      reads.exclude = [...exclude];
      return backgroundOf(c.background);
    },
    loadCoverage: async () => new Map(),
  };
  if (c.quantile !== undefined) process.env.PAPERCUSP_PLAN_DUPE_QUANTILE = String(c.quantile);
  if (c.absoluteOverride !== undefined) process.env.PAPERCUSP_PLAN_DUPE_CONFIRM = String(c.absoluteOverride);
  const result = await confirmSimilarPlans(
    { title: 'proposed plan', body: null },
    c.candidates.map((x) => ({ slug: x.key })),
    {},
    deps,
  );
  return { result, reads };
}

const asKeyed = (rows: Array<{ slug: string; similarity?: number }>) =>
  rows.map((r) => (r.similarity === undefined ? { key: r.slug } : { key: r.slug, similarity: r.similarity }));

describe('confirmSimilarPlans — pinned to the shared near-duplicate parity fixture', () => {
  it('reads the fixture the library suite reads', () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(9);
    expect(FIXTURE.cases.some((c) => c.name === 'spread-256-q95-boundaries')).toBe(true);
  });

  for (const c of FIXTURE.cases) {
    it(`${c.name}: same cut, verdict and partition as the fixture`, async () => {
      const { result, reads } = await runHost(c);
      const e = c.expected;
      expect(result.verdict).toBe(e.verdict);
      if (e.calibration === null) {
        expect(result.calibration).toBeUndefined();
      } else {
        expect(result.calibration).toBeDefined();
        expect(Math.abs(result.calibration!.cut - e.calibration.cut)).toBeLessThanOrEqual(1e-9);
        expect(result.calibration!.basis).toBe(e.calibration.basis);
        expect(result.calibration!.backgroundSamples).toBe(e.calibration.backgroundSamples);
        expect(result.calibration!.quantile).toBe(e.calibration.quantile);
      }
      expect(asKeyed(result.kept)).toEqual(e.kept);
      expect(asKeyed(result.dropped)).toEqual(e.dropped);
      expect(reads.background > 0).toBe(e.backgroundRead);
      if (e.backgroundRead) {
        expect(reads.limit).toBe(e.backgroundLimit);
        expect(reads.exclude).toEqual(e.backgroundExclude);
      }
    });
  }
});
