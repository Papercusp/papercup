/**
 * Unit tests for the EI-316 mirror-duplicate detector: which titles embed a live
 * work-item id, the open-vs-terminal gate, and the fail-open-on-lookup-error.
 */
import { describe, expect, it, vi } from 'vitest';
import { extractWorkItemIds, findMirroredOpenItem } from './mirror-guard';

describe('extractWorkItemIds', () => {
  it('pulls WI- and EI- ids out of a title, deduped + upper-cased', () => {
    expect(extractWorkItemIds('WI-118: Single-module REST API server')).toEqual(['WI-118']);
    expect(extractWorkItemIds('relates to wi-12 and EI-9 and WI-12')).toEqual(['WI-12', 'EI-9']);
  });

  it('ignores titles with no embedded id (and the non-matched F- legacy family)', () => {
    expect(extractWorkItemIds('Single-page kanban UI')).toEqual([]);
    expect(extractWorkItemIds('port F-AUTO-MQ8UL9 to the new surface')).toEqual([]);
    // a bare number or a different prefix is not an id
    expect(extractWorkItemIds('bump to 118 widgets, PR-118')).toEqual([]);
  });
});

describe('findMirroredOpenItem', () => {
  const lookup = (table: Record<string, string>) => async (id: string) =>
    table[id] ? { id, state: table[id] } : null;

  it('flags a title embedding an id that resolves to an OPEN item (the mirror case)', async () => {
    const hit = await findMirroredOpenItem('WI-118: Single-module REST API server', lookup({ 'WI-118': 'validating' }));
    expect(hit).toEqual({ id: 'WI-118', state: 'validating' });
  });

  it('does NOT flag when the referenced id is in a TERMINAL state (work already done)', async () => {
    for (const term of ['passed', 'done', 'resolved', 'closed', 'dropped', 'deprecated', 'PASSED']) {
      expect(await findMirroredOpenItem(`follow-up to WI-50`, lookup({ 'WI-50': term }))).toBeNull();
    }
  });

  it('does NOT flag when the referenced id does not exist', async () => {
    expect(await findMirroredOpenItem('mentions WI-999 which is gone', lookup({}))).toBeNull();
  });

  it('does NOT flag a title with no embedded id', async () => {
    const fn = vi.fn();
    expect(await findMirroredOpenItem('Single-page kanban UI', fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the FIRST open referenced id when several are embedded', async () => {
    const hit = await findMirroredOpenItem('WI-1 done, WI-2 open', lookup({ 'WI-1': 'passed', 'WI-2': 'wip' }));
    expect(hit).toEqual({ id: 'WI-2', state: 'wip' });
  });

  it('fails OPEN: a lookup error never blocks the create', async () => {
    const throwing = async () => {
      throw new Error('pg down');
    };
    expect(await findMirroredOpenItem('WI-118: thing', throwing)).toBeNull();
  });
});
