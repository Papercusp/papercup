import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractAddedIds,
  persistAnchorsSql,
  _resetForTests,
  type SqlTag,
} from './persist-anchors';
import type { Anchor } from './anchors';

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ANOTHER_UUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('extractAddedIds', () => {
  it('returns ids for ADD events only', () => {
    expect(
      extractAddedIds({
        results: [
          { id: VALID_UUID, event: 'ADD' },
          { id: ANOTHER_UUID, event: 'UPDATE' },
          { id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', event: 'NONE' },
        ],
      }),
    ).toEqual([VALID_UUID]);
  });

  it('returns empty for non-uuid ids', () => {
    expect(
      extractAddedIds({
        results: [{ id: 'not-a-uuid', event: 'ADD' }],
      }),
    ).toEqual([]);
  });

  it('returns empty for missing/null/non-object input', () => {
    expect(extractAddedIds(null)).toEqual([]);
    expect(extractAddedIds(undefined)).toEqual([]);
    expect(extractAddedIds({})).toEqual([]);
    expect(extractAddedIds({ results: null })).toEqual([]);
    expect(extractAddedIds('garbage')).toEqual([]);
  });

  it('is case-insensitive on event names', () => {
    expect(
      extractAddedIds({
        results: [
          { id: VALID_UUID, event: 'add' },
          { id: ANOTHER_UUID, event: 'Add' },
        ],
      }),
    ).toEqual([VALID_UUID, ANOTHER_UUID]);
  });

  it('skips rows with missing id', () => {
    expect(
      extractAddedIds({
        results: [
          { event: 'ADD' },
          { id: VALID_UUID, event: 'ADD' },
        ],
      }),
    ).toEqual([VALID_UUID]);
  });
});

describe('persistAnchorsSql', () => {
  beforeEach(() => _resetForTests());

  function makeSqlMock(opts: {
    throws?: Error;
  } = {}): { sql: SqlTag; calls: Array<{ template: TemplateStringsArray; values: unknown[] }> } {
    const calls: Array<{ template: TemplateStringsArray; values: unknown[] }> = [];
    const sql: SqlTag = (async <T = unknown>(
      template: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> => {
      calls.push({ template, values });
      if (opts.throws) throw opts.throws;
      return undefined as T;
    }) as SqlTag;
    return { sql, calls };
  }

  it('returns true and no-ops for empty anchors', async () => {
    const { sql, calls } = makeSqlMock();
    expect(await persistAnchorsSql(sql, VALID_UUID, [])).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('inserts each anchor for a valid memory_id', async () => {
    const { sql, calls } = makeSqlMock();
    const anchors: Anchor[] = [
      { kind: 'file', value: 'apps/operator/lib/foo.ts' },
      { kind: 'plan', value: 'my-plan-2026-05-25' },
    ];
    expect(await persistAnchorsSql(sql, VALID_UUID, anchors)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].values).toEqual([
      VALID_UUID,
      ['file', 'plan'],
      ['apps/operator/lib/foo.ts', 'my-plan-2026-05-25'],
    ]);
  });

  it('skips invalid memory_id (returns true, no INSERT)', async () => {
    const { sql, calls } = makeSqlMock();
    const anchors: Anchor[] = [{ kind: 'file', value: 'x' }];
    expect(await persistAnchorsSql(sql, 'not-a-uuid', anchors)).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('returns false and caches table-missing on relation-does-not-exist', async () => {
    const { sql } = makeSqlMock({
      throws: new Error('relation "harness_shared.memory_anchors" does not exist'),
    });
    const anchors: Anchor[] = [{ kind: 'file', value: 'x' }];
    expect(await persistAnchorsSql(sql, VALID_UUID, anchors)).toBe(false);

    // Subsequent call short-circuits — even with a working sql tag.
    const { sql: sql2, calls: calls2 } = makeSqlMock();
    expect(await persistAnchorsSql(sql2, ANOTHER_UUID, anchors)).toBe(false);
    expect(calls2.length).toBe(0);
  });

  it('swallows transient PG errors and returns false (no cache poison)', async () => {
    const { sql } = makeSqlMock({ throws: new Error('connection reset') });
    const anchors: Anchor[] = [{ kind: 'file', value: 'x' }];
    expect(await persistAnchorsSql(sql, VALID_UUID, anchors)).toBe(false);

    // Cache stays clean — next call retries.
    const { sql: sql2, calls: calls2 } = makeSqlMock();
    expect(await persistAnchorsSql(sql2, ANOTHER_UUID, anchors)).toBe(true);
    expect(calls2.length).toBe(1);
  });
});
