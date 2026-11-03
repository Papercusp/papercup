import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { runAdmissionReviews } from './work-item-admission-review';

type Candidate = {
  feature_id: string;
  request: unknown;
  attemptedAtMs: number | null;
  receiptId: string | null;
};

describe('admission review queue fairness', () => {
  it('advances past repeatedly refused requests without creating receipts', async () => {
    const candidates: Candidate[] = Array.from({ length: 39 }, (_, index) => ({
      feature_id: `EI-review-${String(index + 1).padStart(2, '0')}`,
      // Missing requestId is malformed and must stay fail-closed. It also models
      // an eligible row that remains outstanding after preflight refuses it.
      request: { version: 1, purpose: 'admission-review' },
      attemptedAtMs: null,
      receiptId: null,
    }));
    let clock = 1_800_000_000_000;

    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join('?').replace(/\s+/g, ' ').trim();
      if (query.startsWith("SELECT feature_id, payload->'_admissionReviewRequest' AS request")) {
        const orderBy = query.indexOf('ORDER BY');
        const markerOrder = query.indexOf("payload->>'_admissionReviewLastAttemptAtMs'");
        expect(orderBy).toBeGreaterThanOrEqual(0);
        expect(markerOrder).toBeGreaterThan(orderBy);
        expect(query).toContain('NULLS FIRST');
        expect(query).toContain('feature_id LIMIT 20');

        return candidates
          .filter(candidate => candidate.receiptId === null)
          .sort((a, b) => {
            if (a.attemptedAtMs === null && b.attemptedAtMs !== null) return -1;
            if (a.attemptedAtMs !== null && b.attemptedAtMs === null) return 1;
            return (a.attemptedAtMs ?? 0) - (b.attemptedAtMs ?? 0) ||
              a.feature_id.localeCompare(b.feature_id);
          })
          .slice(0, 20)
          .map(({ feature_id, request }) => ({ feature_id, request }));
      }

      if (query.startsWith('UPDATE harness_shared.work_items') &&
          query.includes('_admissionReviewLastAttemptAtMs')) {
        const candidate = candidates.find(row => values.includes(row.feature_id));
        expect(candidate).toBeDefined();
        expect(values).toContain(JSON.stringify(candidate!.request));
        candidate!.attemptedAtMs = clock++;
        return [{ feature_id: candidate!.feature_id }];
      }

      throw new Error(`unexpected admission-review SQL: ${query}`);
    }), {
      typed: vi.fn((value: string) => value),
    }) as unknown as Sql;

    const options = { workspaceId: 'ws-test', harnessSlug: 'papercusp', runId: 'review-rotation' };
    const llmCall = vi.fn() as never;
    const first = await runAdmissionReviews(options, sql, llmCall);
    const second = await runAdmissionReviews(options, sql, llmCall);

    expect(first.result).toBeNull();
    expect(second.result).toBeNull();
    expect(first.guardRefusals).toHaveLength(20);
    expect(second.guardRefusals).toHaveLength(20);
    expect(first.guardRefusals.map(row => row.itemId)).toEqual(
      candidates.slice(0, 20).map(row => row.feature_id),
    );
    expect(second.guardRefusals.map(row => row.itemId)).toEqual(
      [...candidates.slice(20).map(row => row.feature_id), candidates[0]!.feature_id],
    );
    expect(second.guardRefusals.some(row => row.itemId === 'EI-review-34')).toBe(true);
    expect(candidates.every(row => row.attemptedAtMs !== null)).toBe(true);
    expect(candidates.every(row => row.receiptId === null)).toBe(true);
  });
});
