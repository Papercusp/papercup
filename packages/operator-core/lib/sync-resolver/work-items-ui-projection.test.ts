// projectWorkItemsListForUi (precompute-sync-reads-phase2 P-006): drops the heavy
// per-row `summary` from the workItems.byHarness LIST at the sync boundary — the
// grid never renders/filters/searches it; DetailPanel loads it on demand via
// workItems.detail. Mirrors coord-ui-projection.test.ts.

import { describe, expect, it } from 'vitest';
import { projectWorkItemsListForUi } from './work-items-ui-projection';

describe('projectWorkItemsListForUi', () => {
  it('empties summary but keeps every other field verbatim', () => {
    const rows = [
      { id: 'WI-1', title: 'a', summary: 'x'.repeat(5000), kind: 'change', state: 'open', assignee: 'su', planSlug: 'p', spineRole: 'worker' },
    ];
    const out = projectWorkItemsListForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0].summary).toBe('');
    expect(out[0].id).toBe('WI-1');
    expect(out[0].title).toBe('a');
    expect(out[0].kind).toBe('change');
    expect(out[0].state).toBe('open');
    expect(out[0].assignee).toBe('su');
    expect(out[0].planSlug).toBe('p');
    expect(out[0].spineRole).toBe('worker');
  });

  it('preserves the list _meta on row[0] (the authoritative total)', () => {
    const rows = [
      { id: 'WI-1', summary: 'big', _meta: { total: 1821 } },
      { id: 'WI-2', summary: 'big2' },
    ];
    const out = projectWorkItemsListForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]._meta).toEqual({ total: 1821 });
    expect(out[0].summary).toBe('');
    expect(out[1].summary).toBe('');
    expect(out[1]._meta).toBeUndefined();
  });

  it('slims the wire dramatically for a big-summary row', () => {
    const rows = [{ id: 'WI-1', summary: 'y'.repeat(346_000) }];
    const before = JSON.stringify(rows).length;
    const after = JSON.stringify(projectWorkItemsListForUi(rows)).length;
    expect(after).toBeLessThan(before / 100); // ~346KB → a few dozen bytes
  });

  it('passes a non-array through defensively', () => {
    expect(projectWorkItemsListForUi(null)).toBeNull();
    expect(projectWorkItemsListForUi(undefined as unknown)).toBeUndefined();
  });
});
