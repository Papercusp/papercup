/**
 * ask-knowledge-tier.ts — the knowledge-FIRST tier (D-001), enforced in the
 * coord:ask tool SHAPE (not just prompting — prompts drift, affordances do not).
 * Before any peer is interrupted, the ask runs existing knowledge:
 *   1. search:semantic — hybrid BM25 + embeddings over escalations / brainstorm
 *      / turns / harness_decisions (the operator's indexed prose surfaces).
 *   2. mem0 — the user's persistent memories, fanned over the same pseudo-user
 *      keys answer-capture writes to (user / workspace:<id> / harness:<slug>), so
 *      a previously-CAPTURED answer (D-004) is found here.
 * A hit returns the answer inline (no peer interrupted); a miss opens a
 * conversation. Each candidate CITES its source so the asker can judge a hit
 * (D-001) — the tier returns candidates, the asker decides.
 *
 * Pure-ish: all IO is try/caught and degrades to "this surface returned nothing"
 * (a missing embedder / pgvector / mem0 must not make the ask fail) — same
 * posture as runHybridSearch's per-source degradation.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from '../search/sources';
import { buildQueryEmbedder } from '../search/embedder';
import { getMemoryBackend, type MemoryBackend } from '../../memory/backend';

/** Injectable IO for the tier — defaults to the prod org handle + the
 *  configured MemoryBackend (generalize-memory-backend-swappable D-003).
 *  The tests inject a throwaway sql + a stub backend. */
export interface KnowledgeTierDeps {
  sql?: Sql;
  backend?: MemoryBackend;
}

export interface KnowledgeCandidate {
  /** Which surface produced it (for the asker to judge — D-001). */
  source: 'search:semantic' | 'mem0';
  /** A stable reference for dedup + provenance. */
  ref: string;
  /** Finer label: the search source name (escalations/decisions/…) or 'mem0'. */
  label: string;
  /** The matched text (first ~200 chars / the memory body). */
  excerpt: string;
  /** Ranker-native or fused score (NOT comparable across sources — for ordering only). */
  score: number;
}

export interface KnowledgeTierResult {
  candidates: KnowledgeCandidate[];
  /** Which surfaces were actually queried (the rest degraded/were absent). */
  searched: string[];
  embedder_available: boolean;
}

export interface KnowledgeTierInput {
  query: string;
  workspaceId?: string | null;
  /** The asker's owner id — included as a mem0 read key (their own memories). */
  asker_id?: string;
  /** Restrict search:semantic to one harness + read that harness's mem0 scope. */
  harness_slug?: string | null;
  limit?: number;
}

export async function runKnowledgeTier(
  input: KnowledgeTierInput,
  deps: KnowledgeTierDeps = {},
): Promise<KnowledgeTierResult> {
  const limit = input.limit ?? 5;
  const sql = deps.sql ?? getOrgPg().sql;
  const memoryClient = deps.getMemoryClient ?? getMemoryClient;
  const candidates: KnowledgeCandidate[] = [];
  const searched: string[] = [];
  let embedderAvailable = false;

  // 1. search:semantic (hybrid) over the indexed prose surfaces.
  try {
    const embedder = await buildQueryEmbedder();
    const { results, embedderAvailable: ea } = await runHybridSearch(SEARCH_SOURCES, {
      sql,
      query: input.query,
      workspaceId: input.workspaceId ?? '',
      scopeFilter: input.harness_slug ?? null,
      limit,
      mode: 'hybrid',
      embedder,
    });
    embedderAvailable = ea;
    searched.push('search:semantic');
    for (const h of results) {
      candidates.push({
        source: 'search:semantic',
        ref: `${h.source}:${h.source_id}`,
        label: h.source,
        excerpt: (h.excerpt || h.highlight || '').slice(0, 240),
        score: h.score,
      });
    }
  } catch {
    /* search surface degraded — proceed with whatever mem0 returns */
  }

  // 2. mem0 — fan over the same keys answer-capture writes under.
  try {
    const client = await memoryClient();
    if (client) {
      searched.push('mem0');
      const keys = new Set<string>();
      if (input.asker_id) keys.add(input.asker_id);
      keys.add(`workspace:${input.workspaceId ?? 'default'}`);
      if (input.harness_slug) keys.add(`harness:${input.harness_slug}`);
      const pulls = await Promise.all(
        [...keys].map((k) =>
          client.search(input.query, { filters: { user_id: k }, limit }).catch(() => ({ results: [] })),
        ),
      );
      for (const r of pulls) {
        for (const m of (r.results ?? []) as Array<{ id: string; memory?: string; text?: string; score?: number }>) {
          candidates.push({
            source: 'mem0',
            ref: `mem0:${m.id}`,
            label: 'mem0',
            excerpt: (m.memory ?? m.text ?? '').slice(0, 240),
            score: m.score ?? 0,
          });
        }
      }
    }
  } catch {
    /* mem0 unavailable — proceed with search:semantic candidates */
  }

  // Dedupe by ref, keep highest score, top-N.
  const byRef = new Map<string, KnowledgeCandidate>();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (!byRef.has(c.ref)) byRef.set(c.ref, c);
  }
  return { candidates: [...byRef.values()].slice(0, limit), searched, embedder_available: embedderAvailable };
}
