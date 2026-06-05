import { describe, it, expect, beforeEach } from 'vitest';
import {
  persistAnchorsSql,
  _resetForTests,
  type SqlTag,
} from './persist-anchors';
import type { Anchor } from './anchors';

// NOTE: extractAddedIds (mem0 add-result parsing) moved behind the
// Mem0Backend in @papercusp/memory (generalize-memory-backend-swappable
// D-002) — its tests live in libs/generic/memory/src/backend.test.ts.

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ANOTHER_UUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

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
