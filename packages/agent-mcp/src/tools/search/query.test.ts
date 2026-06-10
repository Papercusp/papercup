/**
 * search:query — PURE unit tests for the post-query shaping/sorting logic,
 * exercised directly.
 *
 * Focus (no live PG):
 *   - cross-kind `hits.sort` by score descending.
 *   - `slice(limit)` truncation across kinds.
 *   - `degraded` present ONLY when ≥1 kind fell back to ILIKE.
 *   - `wantKind` filter (args.kinds restricts which kinds run).
 *   - per-kind FTS-throws → ILIKE-fallback branch (and the
 *     `<kind>_using_ilike_fallback` reason it pushes).
 *
 * The `ctx.tx` tagged-template mock dispatches by inspecting the SQL text:
 *   - contains `plainto_tsquery` → an FTS query (may be scripted to throw).
 *   - contains `ILIKE`          → the catch-block fallback query.
 * Each is keyed by the table name in the SQL so a per-kind script can target it.
 */

import { describe, expect, it, vi } from 'vitest';
import tool from './query';

type Rows = unknown[];

interface KindScript {
  /** FTS result; if `'throw'`, the FTS query rejects → ILIKE fallback runs. */
  fts: Rows | 'throw';
  /** ILIKE fallback rows (used only when fts==='throw'); `'throw'` makes
   *  the fallback fail too → the kind degrades alone (audit P-048). */
  ilike?: Rows | 'throw';
}

/** table-name fragment → kind, so the mock can route a query to its script. */
const TABLE_KIND: Array<[string, string]> = [
  ['harness_features_consolidated', 'tasks'],
  ['goals', 'goals'],
  ['projects', 'projects'],
  ['audit_log', 'audit'],
];

function kindForSql(sql: string): string | null {
  for (const [frag, kind] of TABLE_KIND) {
    if (sql.includes(frag)) return kind;
  }
  return null;
}

function makeTx(scripts: Record<string, KindScript>) {
  const tx = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const sql = strings.join(' ');
    const kind = kindForSql(sql);
    const script = kind ? scripts[kind] : undefined;
    if (!script) return Promise.resolve([]);
    const isFts = sql.includes('plainto_tsquery');
    if (isFts) {
      if (script.fts === 'throw') return Promise.reject(new Error('column "_search" does not exist'));
      return Promise.resolve(script.fts);
    }
    // ILIKE fallback
    if (script.ilike === 'throw') return Promise.reject(new Error('relation does not exist'));
    return Promise.resolve(script.ilike ?? []);
  };
  return tx;
}

const CTX = (tx: unknown) => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: tx as never,
  log: vi.fn(),
});

describe('search:query — cross-kind sort by score desc', () => {
  it('orders hits from all kinds by descending score', async () => {
    const tx = makeTx({
      tasks: { fts: [{ harness_slug: 'h', feature_id: 'F-1', title: 'low task', summary: '', rank: 0.1 }] },
      goals: { fts: [{ id: 'g1', title: 'high goal', rank: 0.9 }] },
      projects: { fts: [{ id: 'p1', slug: 'proj', name: 'mid project', rank: 0.5 }] },
      audit: { fts: [{ id: 'a1', subject: 'subj', action: 'act', rank: 0.3 }] },
    });
    const res = await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never);
    const scores = (res.data as Array<{ score: number }>).map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBe(0.9);
    expect((res.data as Array<{ kind: string }>)[0].kind).toBe('goals');
    expect(res.degraded).toBeUndefined();
  });
});

describe('search:query — slice(limit) truncation', () => {
  it('truncates the merged hit list to args.limit', async () => {
    const goalRows = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, title: `g${i}`, rank: 1 - i * 0.1 }));
    const taskRows = Array.from({ length: 5 }, (_, i) => ({
      harness_slug: 'h',
      feature_id: `F-${i}`,
      title: `t${i}`,
      summary: '',
      rank: 0.5 - i * 0.05,
    }));
    const tx = makeTx({ goals: { fts: goalRows }, tasks: { fts: taskRows } });
    const res = await tool.handler({ query: 'x', limit: 3 } as never, CTX(tx) as never);
    expect((res.data as unknown[]).length).toBe(3);
    // The 3 highest scores survive (goal rows score highest).
    expect((res.data as Array<{ id: string }>).map((h) => h.id)).toEqual(['g0', 'g1', 'g2']);
  });
});

describe('search:query — wantKind filter', () => {
  it('only runs the kinds named in args.kinds', async () => {
    const visited: string[] = [];
    const tx = (strings: TemplateStringsArray) => {
      const k = kindForSql(strings.join(' '));
      if (k) visited.push(k);
      // return a hit so we also confirm only goals appears in data
      if (k === 'goals') return Promise.resolve([{ id: 'g1', title: 'g', rank: 0.4 }]);
      return Promise.resolve([]);
    };
    const res = await tool.handler({ query: 'x', kinds: ['goals'], limit: 25 } as never, CTX(tx) as never);
    expect(new Set(visited)).toEqual(new Set(['goals']));
    expect((res.data as Array<{ kind: string }>).every((h) => h.kind === 'goals')).toBe(true);
  });
});

describe('search:query — FTS throws → ILIKE fallback per kind', () => {
  it('falls back to ILIKE for the failing kind and records a degraded reason', async () => {
    const tx = makeTx({
      // tasks FTS throws → fallback rows w/ score 1
      tasks: {
        fts: 'throw',
        ilike: [{ harness_slug: 'h', feature_id: 'F-9', title: 'fallback task', summary: '' }],
      },
      // goals FTS succeeds → no degraded reason for goals
      goals: { fts: [{ id: 'g1', title: 'ok goal', rank: 0.2 }] },
    });
    const res = await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('tasks_using_ilike_fallback');
    expect(res.degradedReasons).not.toContain('goals_using_ilike_fallback');
    // The fallback task hit carries the hard-coded score 1 (highest), so it sorts first.
    const taskHit = (res.data as Array<{ kind: string; score: number }>).find((h) => h.kind === 'tasks');
    expect(taskHit?.score).toBe(1);
  });

  it('degraded is absent when every kind uses FTS successfully', async () => {
    const tx = makeTx({ goals: { fts: [{ id: 'g1', title: 'g', rank: 0.5 }] } });
    const res = await tool.handler({ query: 'x', kinds: ['goals'], limit: 25 } as never, CTX(tx) as never);
    expect(res.degraded).toBeUndefined();
    expect((res as { degradedReasons?: unknown }).degradedReasons).toBeUndefined();
  });

  it('audit fallback uses score 0.5 (its distinct ILIKE constant)', async () => {
    const tx = makeTx({
      audit: { fts: 'throw', ilike: [{ id: 'a1', subject: 's', action: 'act' }] },
    });
    const res = await tool.handler({ query: 'x', kinds: ['audit'], limit: 25 } as never, CTX(tx) as never);
    const auditHit = (res.data as Array<{ kind: string; score: number; snippet: string }>)[0];
    expect(auditHit.kind).toBe('audit');
    expect(auditHit.score).toBe(0.5);
    expect(auditHit.snippet).toBe('act: s');
    expect(res.degradedReasons).toContain('audit_using_ilike_fallback');
  });
});

describe('search:query — per-kind isolation when BOTH legs fail (audit P-048)', () => {
  it('a kind whose FTS and ILIKE both throw degrades alone; other kinds still answer', async () => {
    const tx = makeTx({
      tasks: { fts: 'throw', ilike: 'throw' }, // dead kind
      goals: { fts: [{ id: 'g1', title: 'still here', rank: 0.7 }] },
    });
    // Pre-fix this REJECTED the whole handler (the fallback was unwrapped).
    const res = await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('tasks_unavailable');
    const kinds = (res.data as Array<{ kind: string }>).map((h) => h.kind);
    expect(kinds).toContain('goals');
    expect(kinds).not.toContain('tasks');
  });

  it('an explicit messages request reports messages_not_implemented instead of a silent empty', async () => {
    const tx = makeTx({});
    const res = await tool.handler({ query: 'x', kinds: ['messages'], limit: 25 } as never, CTX(tx) as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('messages_not_implemented');
    expect(res.data).toEqual([]);
  });

  it('default all-kinds search does NOT flag messages (only an explicit ask does)', async () => {
    const tx = makeTx({ goals: { fts: [{ id: 'g1', title: 'g', rank: 0.5 }] } });
    const res = await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never);
    expect((res as { degradedReasons?: string[] }).degradedReasons ?? []).not.toContain(
      'messages_not_implemented',
    );
  });
});
