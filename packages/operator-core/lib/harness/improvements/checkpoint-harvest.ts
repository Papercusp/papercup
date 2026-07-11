/**
 * checkpoint-harvest.ts — P-020 (su-ideate-learning-substrate-2026-07-10):
 * auto-file lane:observation rows from the insight-bearing free-text agents
 * ALREADY write at BOUNDARIES — a `loop:checkpoint`'s `insight` field and a
 * work-item completion record's `coordNotes` (the design-note residual the
 * structured fields can't hold) — with ZERO new workflow.
 *
 * D-017 rationale: the boundary artifacts DO carry the durable content, yet
 * deliberate lane filings run only ~1.4/agent/week — so HARVEST what's already
 * written instead of asking for more (the explicitly-rejected alternative is a
 * volume quota, which just produces noise the digest must then de-noise).
 *
 * D-016 conventions every new leg copies:
 *   - FAIL-OPEN is the prime directive — a harvest miss must NEVER break or slow
 *     the checkpoint / completion write it rides (the caller fires-and-forgets it);
 *   - env kill switch: PAPERCUSP_SU_CHECKPOINT_HARVEST=off (flag-ON default);
 *   - VITEST-inert unless deps are injected (the semantic prescreen lazy-loads an
 *     ONNX model via findSemanticDupes — the WI-3792 load-scar class);
 *   - never hardcode the embedder — the semantic leg rides the shared 551-vector
 *     work-item dupe guard, which already reads embedding_mode / EMBEDDER_DIM.
 *
 * The harvested row is source-tagged `payload.origin='checkpoint-harvest'`,
 * `created_by` = the checkpointing/completing agent, `filedByRole` preserved.
 *
 * COALESCE (so repeated insights don't pile): the carry-note `insight` commonly
 * persists VERBATIM across consecutive cold wakes, so a naive harvest would file
 * N near-identical rows. The prescreen compares the new insight against THIS
 * agent's OWN recent harvest observations two ways:
 *   1. LEXICAL titleSimilarity — catches the exact/near consecutive-wake repeat
 *      that the ASYNC embedding backfill has not yet vectorised (the dominant
 *      case, and the one a purely-semantic guard would miss precisely because the
 *      freshest rows are the least likely to be embedded yet);
 *   2. SEMANTIC widening via the shared 551-vector guard (findSemanticDupes),
 *      SCOPED to this agent's recent harvest ids — catches a re-WORDED repeat.
 * A hit on either coalesces (skips the file). Both fail open (a dep miss ⇒ file).
 */
import { getOrgPg } from '@papercusp/db-org';
import { captureImprovement, type CaptureImprovementInput, type CaptureImprovementResult } from './capture-core';
import { titleSimilarity } from './digest';
import { findSemanticDupes, type SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';

/** payload.origin source-tag stamped on every harvested observation (P-020). */
export const HARVEST_ORIGIN = 'checkpoint-harvest';
/** Kill switch (flag-ON default): PAPERCUSP_SU_CHECKPOINT_HARVEST=off disables all harvest. */
export const HARVEST_KILL_ENV = 'PAPERCUSP_SU_CHECKPOINT_HARVEST';
/** Bound the observation title (the one-line "what") and body (the full insight). */
export const MAX_TITLE_CHARS = 120;
export const MAX_INSIGHT_CHARS = 1400;
/** titleSimilarity at/above this against a recent harvest row ⇒ coalesce (a repeat). */
export const COALESCE_LEXICAL = 0.82;
/** How far back / how many of the agent's own harvest rows the coalesce prescreen loads. */
export const RECENT_LOOKBACK_DAYS = 14;
export const RECENT_LIMIT = 40;

/** Which boundary produced the insight (stamped at payload.harvestSource). */
export type HarvestSource = 'loop-checkpoint' | 'work-item-completion';

export interface HarvestInsightInput {
  /** The raw insight free-text (loop:checkpoint.insight or a completion's coordNotes). */
  insight: string;
  /** The checkpointing / completing agent's ownerId — the observation's created_by. */
  createdBy: string;
  /** Which boundary this came from. */
  source: HarvestSource;
  /** The filer's resolved fine role (preserved at payload.filedByRole). */
  filedByRole?: string;
  /** The pot the observation came from (payload.observation.sourceHive), when scoped. */
  sourceHive?: string;
  /** An attribution ref for payload.observation.refs (e.g. 'loop:checkpoint' | 'wi:<id>'). */
  ref?: string;
  /** Harness scope for the capture + the recency lookup (omit for the unscoped '*' session). */
  harness?: string;
}

/** A recent harvest observation by this agent — the coalesce comparison set. */
export interface RecentHarvest {
  id: string;
  title: string;
}

/** Injectable seams (tests + any future space) — all fail-open at the call sites. */
export interface HarvestDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  /** This agent's recent harvest observations (newest first), for the coalesce prescreen. */
  loadRecent: (createdBy: string, harness?: string) => Promise<RecentHarvest[]>;
  /** The shared 551-vector guard — semantic widening of the coalesce (fail-open null). */
  findSemanticDupes?: (input: { title: string; summary?: string; harness?: string }) => Promise<SemanticDupeResult | null>;
}

export interface HarvestResult {
  filed: boolean;
  reason?: 'disabled' | 'vitest-inert' | 'blank' | 'coalesced' | 'not-created' | 'error';
  /** The filed observation's id (when filed). */
  issueId?: string;
  /** The recent harvest id this insight coalesced into (when reason==='coalesced'). */
  coalescedWith?: string;
}

/**
 * Bound a raw insight into an observation's { title, body } (PURE). The title is
 * the collapsed first line, truncated to MAX_TITLE_CHARS; the body is the whole
 * insight bounded to MAX_INSIGHT_CHARS, and is dropped when it carries nothing
 * beyond the title (a short single-line insight lives entirely in the title).
 * Returns null for a blank insight (nothing to harvest).
 */
export function boundInsight(raw: string): { title: string; body?: string } | null {
  const full = (raw ?? '').trim();
  if (!full) return null;
  const firstLine = (full.split(/\r?\n/, 1)[0] ?? '').replace(/\s+/g, ' ').trim();
  const base = firstLine || full.replace(/\s+/g, ' ').trim();
  const title = base.length > MAX_TITLE_CHARS ? `${base.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : base;
  const boundedBody = full.length > MAX_INSIGHT_CHARS ? `${full.slice(0, MAX_INSIGHT_CHARS - 1).trimEnd()}…` : full;
  const body = boundedBody !== title ? boundedBody : undefined;
  return { title, ...(body ? { body } : {}) };
}

/**
 * The recent harvest row this title lexically repeats (PURE): the highest
 * titleSimilarity at/above `threshold`, or null if none reach it. Catches the
 * verbatim consecutive-wake repeat with no embedding dependency.
 */
export function pickLexicalCoalesce(
  title: string,
  recent: readonly RecentHarvest[],
  threshold: number = COALESCE_LEXICAL,
): string | null {
  let best: { id: string; sim: number } | null = null;
  for (const r of recent) {
    const sim = titleSimilarity(title, r.title);
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: r.id, sim };
  }
  return best?.id ?? null;
}

/**
 * The first HARD semantic hit that is one of THIS agent's recent harvest rows
 * (PURE): the guard ranks the new insight against all OPEN work-items, so scope
 * its verdict to the harvest set before coalescing — an unrelated open work-item
 * clearing the hard bar must never suppress a genuine insight.
 */
export function pickSemanticCoalesce(
  hard: ReadonlyArray<{ id: string }>,
  recentIds: ReadonlySet<string>,
): string | null {
  for (const h of hard) if (recentIds.has(h.id)) return h.id;
  return null;
}

async function loadRecentHarvestReal(createdBy: string, _harness?: string): Promise<RecentHarvest[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ issue_id: string; title: string }>>`
    SELECT issue_id, COALESCE(title, '') AS title
      FROM harness_shared.engineer_issues
     WHERE created_by = ${createdBy}
       AND payload->>'origin' = ${HARVEST_ORIGIN}
       AND created_at > now() - (${RECENT_LOOKBACK_DAYS} * INTERVAL '1 day')
     ORDER BY created_at DESC
     LIMIT ${RECENT_LIMIT}`;
  return rows.map((r) => ({ id: r.issue_id, title: r.title }));
}

const realDeps: HarvestDeps = {
  capture: captureImprovement,
  loadRecent: loadRecentHarvestReal,
  findSemanticDupes,
};

/**
 * Harvest one boundary insight into the observation lane (IMPURE leg). Never
 * throws — every failure mode returns a { filed:false, reason } verdict so the
 * fire-and-forget caller (loop:checkpoint / work_items:complete) is untouched.
 * Coalesces a repeat of the agent's own recent harvest instead of piling rows.
 */
export async function harvestInsight(input: HarvestInsightInput, deps?: HarvestDeps): Promise<HarvestResult> {
  try {
    if (process.env[HARVEST_KILL_ENV] === 'off') return { filed: false, reason: 'disabled' };
    // Inert under vitest unless a test injects deps: the semantic prescreen (and the
    // real capture path) lazy-loads an ONNX model unrelated tests must never pay.
    if (process.env.VITEST && !deps) return { filed: false, reason: 'vitest-inert' };
    const d = deps ?? realDeps;

    const createdBy = (input.createdBy ?? '').trim();
    const bounded = boundInsight(input.insight);
    if (!bounded || !createdBy) return { filed: false, reason: 'blank' };

    // Coalesce prescreen — this agent's OWN recent harvest observations.
    const recent = await d.loadRecent(createdBy, input.harness).catch(() => [] as RecentHarvest[]);
    const lex = pickLexicalCoalesce(bounded.title, recent);
    if (lex) return { filed: false, reason: 'coalesced', coalescedWith: lex };
    if (recent.length > 0) {
      const sem = await (d.findSemanticDupes ?? findSemanticDupes)({
        title: bounded.title,
        ...(bounded.body ? { summary: bounded.body } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
      }).catch(() => null);
      if (sem) {
        const hit = pickSemanticCoalesce(sem.hard, new Set(recent.map((r) => r.id)));
        if (hit) return { filed: false, reason: 'coalesced', coalescedWith: hit };
      }
    }

    const observation =
      input.ref || input.sourceHive
        ? {
            observation: {
              ...(input.ref ? { refs: [input.ref] } : {}),
              ...(input.sourceHive ? { sourceHive: input.sourceHive } : {}),
            },
          }
        : {};
    const res = await d.capture({
      title: bounded.title,
      kind: 'change',
      ...(bounded.body ? { body: bounded.body } : {}),
      severity: 'nit',
      lane: 'observation',
      createdBy,
      ...(input.filedByRole ? { filedByRole: input.filedByRole } : {}),
      ...(input.harness ? { scope: `harness:${input.harness}` } : {}),
      payloadExtra: { origin: HARVEST_ORIGIN, harvestSource: input.source, ...observation },
    });
    if (!res.created) return { filed: false, reason: 'not-created' };
    return { filed: true, ...(res.issue?.id ? { issueId: res.issue.id } : {}) };
  } catch {
    return { filed: false, reason: 'error' };
  }
}
