/**
 * learning-analyze-read.ts — the read behind the Learning tab's Analyze stage
 * (learning-tab-visibility-2026-07-18 P-009 / D-001).
 *
 * Per fired cycle, the pipeline's INTERMEDIATE artifacts (migration 623,
 * written best-effort at the tick seam by scout/stage-artifacts.ts):
 *
 *   1. **Ideation roster** — per-slot ideator outcomes (EI-13119) + the raw
 *      per-ideator ideas, each with the creative lens it rode.
 *   2. **Critique verdicts** — every scored idea's keep/moonshot/reject bucket,
 *      novelty/feasibility scores, and the critics' notes.
 *   3. **Fusions** — the debate/recombine proposals with their sourceIdeaIds
 *      chains, joined to the routed-ledger rows so a fusion traces into the
 *      artifact it became (the same rows the Ideas view lists).
 *
 * Joined to `scout_ticks` by cycle id for the cycle's economics (status, stop,
 * spend, funnel counts). Best-effort + 42P01-tolerant like the scout-read tick
 * half: a substrate without migration 623 renders the explain-empty state,
 * never a 500. Pure SQL over an injected `Sql` (mirrors learning-scout-read)
 * so the resolver test can stub the seam.
 */
import type { Sql } from 'postgres';
import type { Idea, Proposal, ScoredIdea } from '../scout/types';
import { isUndefinedTable, normalizeTickEconomics, type ScoutTickEconomics } from './learning-scout-read';

/** One ideator roster slot's outcome (ScoutCycleLike.ideators, EI-13119). */
export interface AnalyzeIdeatorSlot {
  lens: string;
  ok: boolean;
  /** Raw model outputs before the grounding/shape filter. */
  raw: number;
  /** Ideas that survived the filter. */
  produced: number;
  error?: string;
}

/** One routed-ledger row of the cycle, keyed by the IN-CYCLE idea/proposal id
 *  (the `${cycleId}:` ledger prefix stripped) — the fusion → artifact trace. */
export interface AnalyzeRoutedRef {
  ideaId: string;
  rail: string;
  routedRef: string;
  title: string | null;
}

/** One fired cycle's full stage artifacts + joined tick economics. */
export interface AnalyzeCycle {
  cycleId: string;
  /** ISO timestamp the artifacts row landed (≈ cycle completion). */
  at: string | null;
  /** Divergent generation: per-ideator raw ideas incl. lens (render what arrives). */
  ideas: Idea[];
  /** Adversarial critique verdicts (keep/moonshot/reject + notes). */
  scored: ScoredIdea[];
  /** Debate/recombine fusions (sourceIdeaIds chains). */
  proposals: Proposal[];
  /** Per-slot ideator outcomes. */
  ideatorSlots: AnalyzeIdeatorSlot[];
  /** The cycle's scout_ticks economics (null when the tick row is missing). */
  tick: ScoutTickEconomics | null;
  /** The cycle's routed-ledger rows — what the fusions became. */
  routed: AnalyzeRoutedRef[];
}

export interface AnalyzeSnapshot {
  cycles: AnalyzeCycle[];
  generatedAt: string;
}

/** Newest cycles returned per read — a handful of full pipelines is plenty for
 *  the view; the table itself is pruned to keep-30 (stage-artifacts.ts). */
const ANALYZE_CYCLE_LIMIT = 8;

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function readAnalyzeSnapshot(sql: Sql, workspaceId: string): Promise<AnalyzeSnapshot> {
  const generatedAt = new Date().toISOString();

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await sql`
      SELECT cycle_id, created_at, ideas, scored, proposals, ideator_slots
        FROM harness_shared.scout_cycle_stage_artifacts
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC
       LIMIT ${ANALYZE_CYCLE_LIMIT}
    `) as Array<Record<string, unknown>>;
  } catch (err) {
    // Migration 623 not applied on this substrate ⇒ the explain-empty state.
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] artifacts read failed:', err instanceof Error ? err.message : err);
    }
    return { cycles: [], generatedAt };
  }

  const cycles: AnalyzeCycle[] = rows.map((r) => ({
    cycleId: String(r.cycle_id ?? ''),
    at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at ? String(r.created_at) : null,
    ideas: asArray<Idea>(r.ideas),
    scored: asArray<ScoredIdea>(r.scored),
    proposals: asArray<Proposal>(r.proposals),
    ideatorSlots: asArray<AnalyzeIdeatorSlot>(r.ideator_slots),
    tick: null,
    routed: [],
  }));
  const cycleIds = cycles.map((c) => c.cycleId).filter((c) => c.length > 0);
  if (cycleIds.length === 0) return { cycles, generatedAt };

  // Tick-economics join (best-effort — scout_ticks may lag/miss on a substrate).
  try {
    const tickRows = (await sql`
      SELECT * FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND detail->>'cycleId' IN ${sql(cycleIds)}
    `) as Array<Record<string, unknown>>;
    const byCycle = new Map<string, ScoutTickEconomics>();
    for (const row of tickRows) {
      const econ = normalizeTickEconomics(row);
      if (econ.cycleId) byCycle.set(econ.cycleId, econ);
    }
    for (const c of cycles) c.tick = byCycle.get(c.cycleId) ?? null;
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] tick join failed:', err instanceof Error ? err.message : err);
    }
  }

  // Routed-ledger join (best-effort): what each cycle's fusions became. The
  // ledger's idea_id carries a `${cycleId}:` prefix (scorecard-blender-pipeline
  // P-003) — strip it so rows key by the in-cycle Proposal.id.
  try {
    const routedRows = (await sql`
      SELECT cycle_id, idea_id, rail, routed_ref, title
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${workspaceId}
         AND cycle_id IN ${sql(cycleIds)}
    `) as Array<Record<string, unknown>>;
    const byCycle = new Map<string, AnalyzeRoutedRef[]>();
    for (const row of routedRows) {
      const cid = typeof row.cycle_id === 'string' ? row.cycle_id : '';
      if (!cid) continue;
      const rawId = String(row.idea_id ?? '');
      const bucket = byCycle.get(cid) ?? [];
      bucket.push({
        ideaId: rawId.startsWith(`${cid}:`) ? rawId.slice(cid.length + 1) : rawId,
        rail: String(row.rail ?? ''),
        routedRef: String(row.routed_ref ?? ''),
        title: typeof row.title === 'string' && row.title ? row.title : null,
      });
      byCycle.set(cid, bucket);
    }
    for (const c of cycles) c.routed = byCycle.get(c.cycleId) ?? [];
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.analyze] routed join failed:', err instanceof Error ? err.message : err);
    }
  }

  return { cycles, generatedAt };
}
