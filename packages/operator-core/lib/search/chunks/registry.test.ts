import { describe, expect, it } from 'vitest';
import { resolveChunkSurface, splitterVersionOf } from '@papercusp/search';
import {
  CHUNK_SURFACES,
  CONSULT_QUESTIONS_CHUNK_SURFACE,
  consultSettledPredicate,
  OPERATOR_TURNS_CHUNK_SURFACE,
  WORK_ITEMS_CHUNK_SURFACE,
  PLANS_CHUNK_SURFACE,
  REPORTS_CHUNK_SURFACE,
  surfaceStoreTable,
  TEXT_CHUNKS_TABLE,
} from './registry';
import { runChunkSyncTick } from './tick';

describe('chunk surface registry', () => {
  it('every entry is valid, so a registry mistake fails here instead of at sync time', () => {
    for (const s of CHUNK_SURFACES) expect(() => resolveChunkSurface(s), s.surface).not.toThrow();
  });

  it('surface names are unique (they partition the shared chunk table)', () => {
    const names = CHUNK_SURFACES.map((s) => s.surface);
    expect(new Set(names).size).toBe(names.length);
  });

  it('knowledge indexes extend canonical parents in the shared chunk store rather than registering parallel stores', () => {
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'plan')).toEqual([PLANS_CHUNK_SURFACE]);
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'report')).toEqual([REPORTS_CHUNK_SURFACE]);
    expect(PLANS_CHUNK_SURFACE.parent.table).toBe('harness_shared.harness_plans');
    expect(REPORTS_CHUNK_SURFACE.parent.table).toBe('harness_shared.report_library');
    for (const surface of [PLANS_CHUNK_SURFACE,REPORTS_CHUNK_SURFACE]) {
      expect(surfaceStoreTable(surface)).toBe('harness_shared.text_chunks');
      expect(() => resolveChunkSurface(surface)).not.toThrow();
    }
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'plan' || s.searchSource === 'report')
      .map(s=>s.surface).sort()).toEqual(['plans','report']);
  });

  it('every entry reads its version from the parent, so detection never hashes parent text in SQL', () => {
    for (const s of CHUNK_SURFACES) expect(s.versionSql, s.surface).toBeTruthy();
  });

  it('splitter versions are distinct per splitter shape (a registry edit re-cuts)', () => {
    const a = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 8 });
    const b = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 32 });
    expect(a).not.toBe(b);
  });

  it('plans are registered with the D-014 bench arm at the D-029 margin (P-009, P-015)', () => {
    expect(CHUNK_SURFACES).toContain(PLANS_CHUNK_SURFACE);
    const s = PLANS_CHUNK_SURFACE;
    expect(s.surface).toBe('plans');
    expect(s.parent).toEqual({
      table: 'harness_shared.harness_plans',
      key: ['workspace_id', 'harness_slug', 'plan_slug'],
    });
    // D-014: 1,500-character windows, 250 overlap, up to 32 windows.
    // D-029: chunk margin 0.02 (the live R-2 re-run failed at D-014's margin 0).
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(32);
    expect(s.completeBody).toBe(true);
    expect(s.chunkMargin).toBe(0.02);
    // The plan's own vector is the gist leg (D-005 readers stay on it).
    expect(s.parentVector).toEqual({
      column: 'embedding',
      profileColumn: 'embedding_profile',
      modeColumn: 'embedding_mode',
    });
    // The same chunks serve general search and its coverage gate.
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    expect(s.searchSource).toBe('plan');
  });

  it('operator turns are registered with the D-017 bench arm (P-010)', () => {
    expect(CHUNK_SURFACES).toContain(OPERATOR_TURNS_CHUNK_SURFACE);
    const s = OPERATOR_TURNS_CHUNK_SURFACE;
    expect(s.surface).toBe('operator_turns');
    expect(s.parent).toEqual({ table: 'harness_shared.operator_turns', key: [{ column: 'id', type: 'uuid' }] });
    // D-017: 1,500/250 windows, up to 8, chunk margin 0.06.
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(8);
    expect(s.chunkMargin).toBe(0.06);
    expect(s.parentVector).toEqual({
      column: 'text_embedding',
      profileColumn: 'text_embedding_profile',
      modeColumn: 'text_embedding_mode',
    });
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    // Its chunks feed the search:semantic 'turns' source, so the coverage gate counts them there.
    expect(s.searchSource).toBe('turns');
  });

  it('R-40: every registered collection carries its P-001 verdict (D-014 to D-017)', () => {
    // Pinned from the decisions, not read back from the registry: a registry edit
    // that drifts from its bench verdict fails here.
    const VERDICTS: Record<string, { maxChunks: number; chunkMargin: number; decision: string }> = {
      // The margin is D-029's (P-015 live re-run), which amends D-014's margin 0.
      plans: { maxChunks: 32, chunkMargin: 0.02, decision: 'D-014 + D-029' },
      work_items: { maxChunks: 4, chunkMargin: 0, decision: 'D-015' },
      consult_questions: { maxChunks: 8, chunkMargin: 0.04, decision: 'D-016' },
      operator_turns: { maxChunks: 8, chunkMargin: 0.06, decision: 'D-017' },
    };
    // Reports have their own complete-body contract, outside the earlier bench.
    const shared = CHUNK_SURFACES.filter((s) => surfaceStoreTable(s) === TEXT_CHUNKS_TABLE && s.surface !== 'report');
    expect(shared.map((s) => s.surface).sort()).toEqual(Object.keys(VERDICTS).sort());
    for (const s of shared) {
      const v = VERDICTS[s.surface]!;
      expect(s.splitter, `${s.surface} ${v.decision}`).toEqual({ kind: 'window', size: 1500, overlap: 250 });
      expect(s.maxChunks, `${s.surface} ${v.decision}`).toBe(v.maxChunks);
      expect(s.chunkMargin ?? 0, `${s.surface} ${v.decision}`).toBe(v.chunkMargin);
    }
  });

  it('work items and consult questions chunk their long text against their own parent vector (P-011, P-012)', () => {
    expect(WORK_ITEMS_CHUNK_SURFACE.parent).toEqual({ table: 'harness_shared.work_items', key: ['harness_slug', 'feature_id'] });
    expect(WORK_ITEMS_CHUNK_SURFACE.textSql).toBe('p.summary');
    expect(WORK_ITEMS_CHUNK_SURFACE.searchSource).toBe('work_item');
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.parent).toEqual({
      table: 'harness_shared.consult_state',
      key: ['workspace_id', 'conversation_id'],
    });
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.textSql).toBe('p.question');
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.parentVector).toEqual({
      column: 'query_embedding',
      profileColumn: 'query_embedding_profile',
      modeColumn: 'query_embedding_mode',
    });
    // Escalations are not registered (D-018).
    expect(CHUNK_SURFACES.map((s) => s.surface)).not.toContain('escalations');
  });

  it("consult questions chunk only the reader's settled population (D-048)", () => {
    // The same text peersKnowLookup filters its slice with, derived from one function.
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.eligibleSql).toBe(consultSettledPredicate('p'));
    expect(consultSettledPredicate('cs')).toBe(
      "cs.state = 'closed_answered' AND (cs.outcome->>'source' IS DISTINCT FROM 'archive')",
    );
    expect(() => consultSettledPredicate("p; DROP TABLE x")).toThrow(/not a plain identifier/);
  });

  it('plan templates are never chunked (they are never searched)', () => {
    expect(PLANS_CHUNK_SURFACE.eligibleSql).toMatch(/\bp\.template_slug IS NULL\b/);
    expect(PLANS_CHUNK_SURFACE.textSql).toBe('p.content');
    expect(PLANS_CHUNK_SURFACE.headerSql).toBe('p.title');
  });

  it('the tick is inert under vitest unless a SQL handle is injected', async () => {
    expect(await runChunkSyncTick()).toEqual({ skipped: 'vitest' });
  });
});
