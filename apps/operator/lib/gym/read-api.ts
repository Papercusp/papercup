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
