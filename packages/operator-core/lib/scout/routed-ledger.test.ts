/**
 * routed-ledger.test.ts — unit pins for gradeRoutedIdea (scout-idea-grading
 * C-2) over a stubbed PG seam: the result-shape mapping (applied /
 * owner-grade-sovereign / not-found), the grade validation, and the
 * fire-and-forget `learning.scout` invalidate firing ONLY on applied writes.
 *
 * The real precedence SQL (the `graded_by IS DISTINCT FROM 'owner'` guard
 * against live rows) is pinned in routed-ledger.integration.test.ts; this file
 * covers the seam's own logic without PG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Rows the UPDATE … RETURNING yields. */
  updateRows: [] as Array<{ idea_id: string }>,
  /** Rows the existence SELECT yields. */
  selectRows: [] as Array<{ idea_id: string }>,
  queries: [] as string[],
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const text = strings.join(' ');
      h.queries.push(text);
      if (text.includes('UPDATE harness_shared.scout_routed_ideas')) return Promise.resolve(h.updateRows);
      if (text.includes('SELECT idea_id')) return Promise.resolve(h.selectRows);
      return Promise.resolve([]);
    },
  }),
}));

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { gradeRoutedIdea } = await import('./routed-ledger');
const sse = await import('../sync-sse');
const invalidate = vi.mocked(sse.notifySyncInvalidate);

/** Let the seam's fire-and-forget lazy import + invalidate settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  h.updateRows = [];
  h.selectRows = [];
  h.queries = [];
  invalidate.mockClear();
});

describe('gradeRoutedIdea (C-2 seam logic)', () => {
  it('rejects non-integer / out-of-range grades before touching PG', async () => {
    for (const grade of [0, 6, 4.5, NaN]) {
      await expect(gradeRoutedIdea({ ideaId: 'i1', grade, gradedBy: 'owner' })).rejects.toThrow(/integer 1–5/);
    }
    expect(h.queries).toHaveLength(0);
  });

  it('applied write → { applied: true } and fires the learning.scout invalidate', async () => {
    h.updateRows = [{ idea_id: 'i1' }];
    const res = await gradeRoutedIdea({ ideaId: 'i1', grade: 4, feedback: 'sharp', gradedBy: 'Queen' });
    expect(res).toEqual({ applied: true });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('learning.scout'));
  });

  it('guarded UPDATE matching nothing + row exists → owner-grade-sovereign, NO invalidate', async () => {
    h.updateRows = [];
    h.selectRows = [{ idea_id: 'i1' }];
    const res = await gradeRoutedIdea({ ideaId: 'i1', grade: 2, gradedBy: 'Queen' });
    expect(res).toEqual({ applied: false, reason: 'owner-grade-sovereign' });
    await flush();
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('no row at all → not-found, NO invalidate', async () => {
    h.updateRows = [];
    h.selectRows = [];
    const res = await gradeRoutedIdea({ ideaId: 'i-missing', grade: 5, gradedBy: 'owner' });
    expect(res).toEqual({ applied: false, reason: 'not-found' });
    await flush();
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
