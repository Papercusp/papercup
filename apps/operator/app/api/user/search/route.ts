/**
 * /api/user/search — user-facing search across personal memories
 * (mem0) AND workspace prose (operator_turns/escalations/brainstorm
 * via BM25). Renders in /settings/user/search.
 *
 * Memories: direct mem0 client.search.
 * Prose: BM25 only (semantic embeddings are the agent's superpower —
 * keeping the user-facing path cheap + deterministic).
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getMemoryClient } from '@/lib/memory/mem0-client';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEADLINE_OPTS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … ", MaxWords=18, MinWords=5, ShortWord=2';

interface ProseHit {
  source: 'escalations' | 'brainstorm' | 'turns';
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight: string;
  rank: number;
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ q: '', memories: [], prose: [] });
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
  const mode = url.searchParams.get('mode') === 'hybrid' ? 'hybrid' : 'bm25';

  const [memories, prose] = await Promise.all([
    searchMemories(q, user.id, limit),
    mode === 'hybrid' ? searchProseHybrid(q, limit) : searchProse(q, limit),
  ]);
  return NextResponse.json({ q, mode, memories, prose });
}

const EMBEDDER_DIM = 384;

async function embedQuery(text: string): Promise<number[] | null> {
  let key = process.env.OPENAI_API_KEY ?? '';
  try {
    const { readCredentials } = await import('@/lib/credentials');
    const creds = await readCredentials();
    if (creds.openai_api_key) key = creds.openai_api_key;
  } catch { /* env fallback */ }
  if (!key) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: EMBEDDER_DIM,
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return j.data[0].embedding;
  } catch {
    return null;
  }
}

async function searchProseHybrid(q: string, limit: number): Promise<ProseHit[]> {
  const bm = await searchProse(q, limit * 2);
  const qVec = await embedQuery(q);
  if (!qVec) return bm.slice(0, limit);

  const { pgClientFields } = await import('@/lib/memory/mem0-connection');
  const fields = await pgClientFields();
  if (!fields) return bm.slice(0, limit);
  const ws = activeWorkspaceId();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const c = new Client(fields);
  await c.connect();
  const qVecLit = `[${qVec.join(',')}]`;
  const emb: ProseHit[] = [];
  try {
    const esc = await c.query(
      `SELECT harness_slug, phase, escalation, supervisor_notes,
              1 - (body_embedding <=> $1::vector) AS sim,
              ts_headline('english',
                COALESCE(escalation,'') || E'\n' || COALESCE(supervisor_notes,''),
                plainto_tsquery('english', $2), $3) AS highlight
         FROM harness_shared.harness_escalations
        WHERE workspace_id = $4 AND body_embedding IS NOT NULL
        ORDER BY body_embedding <=> $1::vector LIMIT $5`,
      [qVecLit, q, HEADLINE_OPTS, ws, limit * 2],
    );
    for (const r of esc.rows) {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      emb.push({
        source: 'escalations',
        source_id: `${r.harness_slug}:${r.phase}`,
        harness_slug: r.harness_slug,
        excerpt: body.slice(0, 200) + (body.length > 200 ? '…' : ''),
        highlight: r.highlight,
        rank: r.sim,
      });
    }
    const brn = await c.query(
      `SELECT harness_slug, phase, content,
              1 - (content_embedding <=> $1::vector) AS sim,
              ts_headline('english', content,
                plainto_tsquery('english', $2), $3) AS highlight
         FROM harness_shared.harness_brainstorm
        WHERE workspace_id = $4 AND content_embedding IS NOT NULL
        ORDER BY content_embedding <=> $1::vector LIMIT $5`,
      [qVecLit, q, HEADLINE_OPTS, ws, limit * 2],
    );
    for (const r of brn.rows) {
      emb.push({
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        harness_slug: r.harness_slug,
        excerpt: (r.content as string).slice(0, 200) + ((r.content as string).length > 200 ? '…' : ''),
        highlight: r.highlight,
        rank: r.sim,
      });
    }
    const trn = await c.query(
      `SELECT t.id, t.role, t.text,
              1 - (t.text_embedding <=> $1::vector) AS sim,
              ts_headline('english', t.text,
                plainto_tsquery('english', $2), $3) AS highlight
         FROM harness_shared.operator_turns t
         JOIN harness_shared.operator_conversations cn ON cn.id = t.conversation_id
        WHERE cn.workspace_id = $4 AND t.text_embedding IS NOT NULL
        ORDER BY t.text_embedding <=> $1::vector LIMIT $5`,
      [qVecLit, q, HEADLINE_OPTS, ws, limit * 2],
    );
    for (const r of trn.rows) {
      emb.push({
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${(r.text as string).slice(0, 200)}${(r.text as string).length > 200 ? '…' : ''}`,
        highlight: `[${r.role}] ${r.highlight}`,
        rank: r.sim,
      });
    }
  } finally {
    await c.end();
  }

  const { rrfCombine } = await import('@/lib/agent-tools/search/rrf');
  const bmRanked = bm.map((h) => ({ key: `${h.source}:${h.source_id}`, score: h.rank, row: h }));
  const embRanked = emb.map((h) => ({ key: `${h.source}:${h.source_id}`, score: h.rank, row: h }));
  const fused = rrfCombine([
    { name: 'bm25', list: bmRanked },
    { name: 'embeddings', list: embRanked },
  ]);
  return fused.slice(0, limit).map((f) => ({ ...f.row, rank: f.score }));
}

async function searchMemories(q: string, userId: string, limit: number) {
  const client = await getMemoryClient();
  if (!client) return [];
  try {
    const ws = activeWorkspaceId();
    const [userHits, sharedHits] = await Promise.all([
      client.search(q, { userId, limit }),
      client.search(q, { userId: `workspace:${ws}`, limit }),
    ]);
    const merged = [
      ...(userHits.results ?? []).map((r) => ({ ...r, scope: 'user' as const })),
      ...(sharedHits.results ?? []).map((r) => ({ ...r, scope: 'workspace' as const })),
    ];
    merged.sort((a, b) => ((b.score ?? 0) - (a.score ?? 0)));
    return merged.slice(0, limit);
  } catch {
    return [];
  }
}

async function searchProse(q: string, limit: number): Promise<ProseHit[]> {
  const { pgClientFields } = await import('@/lib/memory/mem0-connection');
  const fields = await pgClientFields();
  if (!fields) return [];
  const ws = activeWorkspaceId();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const c = new Client(fields);
  await c.connect();
  try {
    const hits: ProseHit[] = [];
    const esc = await c.query(
      `SELECT harness_slug, phase, escalation, supervisor_notes,
              ts_rank_cd(body_tsv, plainto_tsquery('english', $1)) AS rank,
              ts_headline('english',
                COALESCE(escalation, '') || E'\n' || COALESCE(supervisor_notes, ''),
                plainto_tsquery('english', $1), $3) AS highlight
         FROM harness_shared.harness_escalations
        WHERE workspace_id = $2
          AND body_tsv @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $4`,
      [q, ws, HEADLINE_OPTS, limit],
    );
    for (const r of esc.rows) {
      const body = `${r.escalation ?? ''}\n${r.supervisor_notes ?? ''}`.trim();
      hits.push({
        source: 'escalations',
        source_id: `${r.harness_slug}:${r.phase}`,
        harness_slug: r.harness_slug,
        excerpt: body.slice(0, 200) + (body.length > 200 ? '…' : ''),
        highlight: r.highlight,
        rank: r.rank,
      });
    }
    const brn = await c.query(
      `SELECT harness_slug, phase, content,
              ts_rank_cd(content_tsv, plainto_tsquery('english', $1)) AS rank,
              ts_headline('english', content,
                plainto_tsquery('english', $1), $3) AS highlight
         FROM harness_shared.harness_brainstorm
        WHERE workspace_id = $2
          AND content_tsv @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $4`,
      [q, ws, HEADLINE_OPTS, limit],
    );
    for (const r of brn.rows) {
      hits.push({
        source: 'brainstorm',
        source_id: `${r.harness_slug}:${r.phase}`,
        harness_slug: r.harness_slug,
        excerpt: (r.content as string).slice(0, 200) + ((r.content as string).length > 200 ? '…' : ''),
        highlight: r.highlight,
        rank: r.rank,
      });
    }
    const trn = await c.query(
      `SELECT t.id, t.role, t.text,
              ts_rank_cd(t.text_tsv, plainto_tsquery('english', $1)) AS rank,
              ts_headline('english', t.text,
                plainto_tsquery('english', $1), $3) AS highlight
         FROM harness_shared.operator_turns t
         JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
        WHERE c.workspace_id = $2
          AND t.text_tsv @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $4`,
      [q, ws, HEADLINE_OPTS, limit],
    );
    for (const r of trn.rows) {
      hits.push({
        source: 'turns',
        source_id: r.id,
        excerpt: `[${r.role}] ${(r.text as string).slice(0, 200)}${(r.text as string).length > 200 ? '…' : ''}`,
        highlight: `[${r.role}] ${r.highlight}`,
        rank: r.rank,
      });
    }
    hits.sort((a, b) => b.rank - a.rank);
    return hits.slice(0, limit);
  } finally {
    await c.end();
  }
}
