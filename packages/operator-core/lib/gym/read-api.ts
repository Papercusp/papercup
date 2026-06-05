/**
 * Comparison read API (P-013) — the gym controller's read surface over the gym PG:
 * variant-A-vs-B per-task diff (compareVariants in store.ts), the Pareto frontier
 * view, cycle history, and real-anchor/monitor surfacing. Reads the GYM database
 * (controller-side), never the live operator DB.
 *
 * Pure cores here (vector building + frontier); the SQL readers are thin and bind
 * these to the gym PG. (P-024 dashboard / a `gym` CLI expose these later.)
 */
import { paretoFrontier } from './frontier';
import type { Sql } from 'postgres';

export interface ScoredTrainRow {
  variantId: string;
  taskId: string;
  composite: number;
}

export interface VariantVector {
  variantId: string;
  /** Composites aligned to the sorted train-task set (0 where a variant lacks a task). */
  vector: number[];
  /** Mean of the variant's PRESENT train composites. */
  trainAgg: number;
}

/** Turn scored train runs into per-variant vectors aligned on the sorted task set. */
export function buildVariantVectors(rows: readonly ScoredTrainRow[]): VariantVector[] {
  const taskIds = [...new Set(rows.map((r) => r.taskId))].sort();
  const byVariant = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byVariant.get(r.variantId);
    if (!m) {
      m = new Map();
      byVariant.set(r.variantId, m);
    }
    m.set(r.taskId, r.composite);
  }
  const out: VariantVector[] = [];
  for (const [variantId, scores] of byVariant) {
    const vector = taskIds.map((t) => scores.get(t) ?? 0);
    const present = [...scores.values()];
    const trainAgg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0;
    out.push({ variantId, vector, trainAgg });
  }
  return out;
}

/** Variant ids on the Pareto frontier over the aligned train vectors. */
export function frontierFromVectors(vectors: readonly VariantVector[]): string[] {
  return paretoFrontier(vectors.map((v) => ({ id: v.variantId, vector: v.vector }))).map((x) => x.id);
}

// --- thin gym-PG readers (integration layer; live-validated at P-014) ---

/** Read (variant, task, composite) for train-pool runs under one rubric, from the gym PG. */
export async function readScoredTrainRows(sql: Sql, rubricHash: string): Promise<ScoredTrainRow[]> {
  const rows = await sql<{ variant_id: string; task_id: string; composite: number }[]>`
    SELECT r.variant_id, r.task_id, s.composite
      FROM harness_gym.gym_runs r
      JOIN harness_gym.gym_tasks t ON t.task_id = r.task_id AND t.pool = 'train'
      JOIN harness_gym.gym_scores s ON s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}`;
  return rows.map((r) => ({ variantId: r.variant_id, taskId: r.task_id, composite: Number(r.composite) }));
}

export interface PoolAggregateRow {
  variantId: string;
  meanComposite: number;
  n: number;
}

/**
 * Per-variant mean composite for ONE pool (P-028 real-anchor / monitor surfacing, D-014).
 * Comparing the `real-anchor` trend against the `train` trend across variants IS the
 * falsifiability check: if the train aggregate climbs while the real-anchor stays flat, the
 * loop is optimizing a proxy. The real-anchor pool is scored but never optimized (it never
 * feeds the accept gate — `buildLoopDeps.evaluate` excludes it from the train/dev-anchor rollup).
 */
export async function readPoolAggregates(sql: Sql, pool: string, rubricHash: string): Promise<PoolAggregateRow[]> {
  const rows = await sql<{ variant_id: string; mean: number; n: number }[]>`
    SELECT r.variant_id, AVG(s.composite)::float8 AS mean, COUNT(*)::int AS n
      FROM harness_gym.gym_runs r
      JOIN harness_gym.gym_tasks t ON t.task_id = r.task_id AND t.pool = ${pool}
      JOIN harness_gym.gym_scores s ON s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}
     GROUP BY r.variant_id
     ORDER BY r.variant_id`;
  return rows.map((r) => ({ variantId: r.variant_id, meanComposite: Number(r.mean), n: Number(r.n) }));
}

export interface CycleHistoryRow {
  cycle: number;
  parentId: string | null;
  candidateId: string | null;
  decision: string | null;
}

export async function readCycleHistory(sql: Sql): Promise<CycleHistoryRow[]> {
  const rows = await sql<{ cycle: number; parent_id: string | null; candidate_id: string | null; decision: string | null }[]>`
    SELECT cycle, parent_id, candidate_id, decision FROM harness_gym.gym_cycles ORDER BY cycle`;
  return rows.map((r) => ({ cycle: Number(r.cycle), parentId: r.parent_id, candidateId: r.candidate_id, decision: r.decision }));
}

/** The Pareto frontier view: read scored train rows → vectors → frontier variant ids. */
export async function frontierView(sql: Sql, rubricHash: string): Promise<string[]> {
  return frontierFromVectors(buildVariantVectors(await readScoredTrainRows(sql, rubricHash)));
}

/**
 * Variant lineage (P-016): the ancestor chain from a variant up to its root, using the
 * gym_variants parent_id edges. `[self, parent, …, root]`. Cycle-safe (stops on revisit).
 */
export function variantLineage(
  variants: ReadonlyArray<{ variantId: string; parentId: string | null }>,
  id: string,
): string[] {
  const parentOf = new Map(variants.map((v) => [v.variantId, v.parentId]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return chain;
}
