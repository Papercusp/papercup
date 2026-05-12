'use client';

import { useState, useCallback, FormEvent } from 'react';

interface MemoryHit {
  id: string;
  memory: string;
  score?: number;
  scope: 'user' | 'workspace';
  metadata?: Record<string, unknown>;
}
interface ProseHit {
  source: 'escalations' | 'brainstorm' | 'turns';
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight: string;
  rank: number;
}

const SOURCE_COLOR: Record<ProseHit['source'], string> = {
  escalations: '#f59e0b',
  brainstorm:  '#3b82f6',
  turns:       '#10b981',
};

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'bm25' | 'hybrid'>('bm25');
  const [memories, setMemories] = useState<MemoryHit[]>([]);
  const [prose, setProse] = useState<ProseHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const onSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await fetch(`/api/user/search?q=${encodeURIComponent(q)}&limit=10&mode=${mode}`);
      const j = await r.json();
      setMemories(j.memories ?? []);
      setProse(j.prose ?? []);
    } finally {
      setLoading(false);
    }
  }, [q, mode]);

  return (
    <div style={{ padding: 32, maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h1 style={{ marginBottom: 8 }}>Search workspace</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Searches your personal memories (mem0) and the workspace prose
          (operator turns, escalations, brainstorm notes) in one place.
          Memories use semantic similarity; prose uses keyword match (BM25).
        </p>
      </header>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What do you remember about…"
          autoFocus
          style={{ flex: 1, minWidth: 240, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14 }}
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'bm25' | 'hybrid')}
          title="bm25: keyword-only (fast, deterministic). hybrid: combines keyword + semantic via RRF (needs embedder)."
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14 }}
        >
          <option value="bm25">bm25</option>
          <option value="hybrid">hybrid</option>
        </select>
        <button type="submit" disabled={loading || !q.trim()} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-hover)', cursor: 'pointer', fontSize: 14, opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searched && !loading && memories.length === 0 && prose.length === 0 && (
        <p style={{ color: 'var(--text-secondary)' }}>No results.</p>
      )}

      {memories.length > 0 && (
        <section>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Memories ({memories.length})
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {memories.map((m) => (
              <li key={m.id} style={{ padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                  {m.scope === 'workspace' && (
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: '#3b82f6', color: '#fff', fontSize: 11 }}>shared</span>
                  )}
                  {typeof m.score === 'number' && (
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>score {m.score.toFixed(2)}</span>
                  )}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.memory}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prose.length > 0 && (
        <section>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Prose ({prose.length})
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {prose.map((h) => (
              <li key={`${h.source}:${h.source_id}`} style={{ padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: SOURCE_COLOR[h.source], color: '#fff', fontSize: 11, fontWeight: 600 }}>{h.source}</span>
                  {h.harness_slug && (
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--surface-hover)', fontSize: 11 }}>{h.harness_slug}</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>rank {h.rank.toFixed(3)}</span>
                </div>
                <div
                  style={{ wordBreak: 'break-word' }}
                  dangerouslySetInnerHTML={{ __html: h.highlight }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
