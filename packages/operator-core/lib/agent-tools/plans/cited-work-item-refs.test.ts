/**
 * cited-work-item-refs.test.ts — EI-22173576329267385: extracting WI-/EI- refs
 * cited in plan-item prose and resolving their CURRENT state.
 *
 * `extractWorkItemRefs` is pure text parsing (no I/O). `getWorkItemRefStates`
 * batch-queries `harness_shared.work_items`; the db-org mock below throws on
 * any query this file did not explicitly route (EI-14882 — a catch-all mock
 * would silently answer a second query with the first query's fixture).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { rows: { feature_id: string; status: string | null }[] } = { rows: [] };
  return { state };
});

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  const { mockSqlThrowOnUnmatched } = await import('@papercusp/test-config/mock-sql');
  return {
    ...actual,
    getOrgPg: () => ({
      sql: mockSqlThrowOnUnmatched(
        [
          {
            match: /FROM harness_shared\.work_items/,
            label: 'harness_shared.work_items',
            rows: () => H.state.rows,
          },
        ],
        { name: 'cited-work-item-refs db-org mock' },
      ),
    }),
  };
});

import { extractWorkItemRefs, getWorkItemRefStates } from './cited-work-item-refs';

beforeEach(() => {
  H.state.rows = [];
});

describe('extractWorkItemRefs', () => {
  it('returns [] for empty/falsy text', () => {
    expect(extractWorkItemRefs('')).toEqual([]);
    expect(extractWorkItemRefs(undefined as unknown as string)).toEqual([]);
    expect(extractWorkItemRefs(null as unknown as string)).toEqual([]);
  });

  it('returns [] when no ref is present', () => {
    expect(extractWorkItemRefs('nothing to see here, just prose')).toEqual([]);
  });

  it('extracts a single WI- ref', () => {
    expect(extractWorkItemRefs('closed by WI-7135')).toEqual(['WI-7135']);
  });

  it('extracts a single EI- ref', () => {
    expect(extractWorkItemRefs('see EI-22173576329267385 for detail')).toEqual([
      'EI-22173576329267385',
    ]);
  });

  it('extracts multiple distinct refs in first-seen order', () => {
    expect(extractWorkItemRefs('WI-1 came first, then EI-2, then EI-2 again, then WI-3')).toEqual([
      'WI-1',
      'EI-2',
      'WI-3',
    ]);
  });

  it('dedupes a repeated ref to one entry', () => {
    expect(extractWorkItemRefs('WI-7135 ... WI-7135 ... WI-7135')).toEqual(['WI-7135']);
  });

  it('is word-bounded — does not match a ref glued to a preceding word char', () => {
    // No boundary between "X" and "WI", so this must NOT match — the whole
    // point of \b is to never clip a longer identifier or match mid-token.
    expect(extractWorkItemRefs('see XWI-7135 for context')).toEqual([]);
  });

  it('is case-sensitive — lowercase "wi-" / "ei-" is not a citation', () => {
    expect(extractWorkItemRefs('a wi-123 and ei-456 mention, lowercase')).toEqual([]);
  });

  it('does not clip a longer numeric id short', () => {
    // A naive non-bounded pattern could match "WI-713" inside "WI-7135" text
    // that also contains a shorter substring elsewhere; \d+ is already greedy,
    // but this guards against any future change to the regex weakening that.
    expect(extractWorkItemRefs('WI-71350000 only')).toEqual(['WI-71350000']);
  });
});

describe('getWorkItemRefStates', () => {
  it('returns an empty map for an empty ref list, without querying', async () => {
    const out = await getWorkItemRefStates([]);
    expect(out.size).toBe(0);
  });

  it('resolves a terminal state (done) as terminal:true', async () => {
    H.state.rows = [{ feature_id: 'WI-7135', status: 'done' }];
    const out = await getWorkItemRefStates(['WI-7135']);
    expect(out.get('WI-7135')).toEqual({ ref: 'WI-7135', state: 'done', terminal: true });
  });

  it('resolves a non-terminal state (open) as terminal:false', async () => {
    H.state.rows = [{ feature_id: 'EI-22173576329267385', status: 'open' }];
    const out = await getWorkItemRefStates(['EI-22173576329267385']);
    expect(out.get('EI-22173576329267385')).toEqual({
      ref: 'EI-22173576329267385',
      state: 'open',
      terminal: false,
    });
  });

  it('resolves a dropped work-item as terminal:true too (any-family terminal, not just done)', async () => {
    H.state.rows = [{ feature_id: 'WI-1', status: 'dropped' }];
    const out = await getWorkItemRefStates(['WI-1']);
    expect(out.get('WI-1')?.terminal).toBe(true);
  });

  it('treats a matched row with a NULL status column as state:null, terminal:false', async () => {
    H.state.rows = [{ feature_id: 'WI-2', status: null }];
    const out = await getWorkItemRefStates(['WI-2']);
    expect(out.get('WI-2')).toEqual({ ref: 'WI-2', state: null, terminal: false });
  });

  it('surfaces a ref with NO matching row as state:null, terminal:false — never silently dropped', async () => {
    // EI-22173576329267385 interface doc: "Surfaced as-is — an unresolved ref
    // is itself a signal (the citation may be wrong), not something to hide."
    // items-shape.ts already renders state:null as "unknown"; this is the half
    // of the contract that has to actually populate the map entry.
    H.state.rows = [];
    const out = await getWorkItemRefStates(['WI-99999999']);
    expect(out.has('WI-99999999')).toBe(true);
    expect(out.get('WI-99999999')).toEqual({ ref: 'WI-99999999', state: null, terminal: false });
  });

  it('handles a mixed batch: resolved-terminal, resolved-non-terminal, and unresolved together', async () => {
    H.state.rows = [
      { feature_id: 'WI-1', status: 'done' },
      { feature_id: 'WI-2', status: 'wip' },
    ];
    const out = await getWorkItemRefStates(['WI-1', 'WI-2', 'WI-3']);
    expect(out.size).toBe(3);
    expect(out.get('WI-1')?.terminal).toBe(true);
    expect(out.get('WI-2')?.terminal).toBe(false);
    expect(out.get('WI-3')).toEqual({ ref: 'WI-3', state: null, terminal: false });
  });
});
