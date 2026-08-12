import { describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  searchWorkItems: vi.fn(),
}));

import { searchWorkItems } from '../../work-items';
import search, { projectWorkItemSearchMatch, shapeWorkItemsSearch } from './search';

const searchMock = vi.mocked(searchWorkItems);

const workItem = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'EI-1',
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    title: 'A useful title',
    summary: 'A useful summary',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    parent: null,
    payload: { giant: 'do not send this on every search hit' },
    origin: 'local',
    auditVerdict: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  }) as never;

describe('work_items:search transaction scope', () => {
  it('opts out of the ambient workspace transaction because search owns its DB scopes', () => {
    expect((search as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('work_items:search bounded result projection', () => {
  it('returns a compact match row and leaves detail payloads to work_items:get', () => {
    const match = projectWorkItemSearchMatch(
      workItem({ title: 'T'.repeat(300), summary: 'S'.repeat(400), payload: { evidence: 'x'.repeat(20_000) } }),
    );

    expect(match).toMatchObject({
      id: 'EI-1',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      severity: 'minor',
      title_truncated: true,
      summary_truncated: true,
      title_full_chars: 300,
      summary_full_chars: 400,
    });
    expect(match.title.length).toBeLessThanOrEqual(180);
    expect(match.summary.length).toBeLessThanOrEqual(240);
    expect(match).not.toHaveProperty('payload');
    expect(JSON.stringify(match).length).toBeLessThan(1_000);
  });

  it('makes tier truncation explicit when a large result page is projected', () => {
    const data = {
      ok: true,
      count: 25,
      items: Array.from({ length: 25 }, (_, i) => projectWorkItemSearchMatch(workItem({ id: `EI-${i}` }))),
      legs: { degraded: false },
    };

    const shaped = shapeWorkItemsSearch(data, 'trimmed') as Record<string, unknown>;
    expect((shaped.items as unknown[]).length).toBe(20);
    expect(shaped).toMatchObject({ count: 25, returnedCount: 20, truncated: true });
    expect(shaped.note).toMatch(/narrow the query|work_items:get/);
  });

  it('returns structured data so the framework can shape the handler result', async () => {
    searchMock.mockResolvedValueOnce({
      items: [workItem({ summary: 'summary' })],
      legs: { degraded: false },
      applied: {},
    } as never);

    const result = (await search.handler({ query: 'summary', semantic: false } as never, {} as never)) as {
      data: { ok: boolean; count: number; items: Array<Record<string, unknown>>; legs: unknown };
    };
    expect(result.data).toMatchObject({ ok: true, count: 1, legs: { degraded: false } });
    expect(result.data.items[0]).not.toHaveProperty('payload');
    expect(result.data.items[0]).toMatchObject({ id: 'EI-1', title: 'A useful title' });
  });
});
