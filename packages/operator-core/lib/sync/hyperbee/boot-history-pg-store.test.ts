/**
 * boot-history-pg-store unit tests (EI-18655247267756605). PG-free: a fake
 * `sql` tagged-template captures the query text + interpolated values instead
 * of hitting real Postgres — mirrors coord-quarantine-store.test.ts's
 * `fakeSql` pattern (that module is the closest sibling: same
 * insert-then-evict-past-a-per-scope-cap shape, migration 436 vs this one's
 * migration 660).
 *
 * NOTE on nested fragments: `listBootHistoryEventsPg`'s optional filters are
 * nested `sql\`...\`` expressions (postgres.js fragment composition). JS
 * evaluates those BEFORE the enclosing tagged template is invoked, so they
 * land as EARLIER calls in `calls[]` than the outer query — assertions below
 * check the flattened union of every captured call's values, not one call by
 * index, so they don't depend on that ordering.
 */
import { describe, expect, it } from 'vitest';
import { findOwnCompactionAnchorHintPg, insertBootHistoryEventPg, isVitestOrigin, listBootHistoryEventsPg } from './boot-history-pg-store';
import type { BootHistoryEntry } from './boot-history';

interface Call {
  strings: readonly string[];
  values: unknown[];
}

/** Captures each tagged-template invocation and resolves every call to `result`. */
function fakeSql(result: unknown) {
  const calls: Call[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(result);
  }) as unknown as { calls: Call[] };
  Object.defineProperty(fn, 'calls', { value: calls, enumerable: true });
  return fn as never;
}
function callsOf(sql: unknown): Call[] {
  return (sql as unknown as { calls: Call[] }).calls;
}
function allText(sql: unknown): string {
  return callsOf(sql)
    .map((c) => c.strings.join('?'))
    .join(' || ');
}
function allValues(sql: unknown): unknown[] {
  return callsOf(sql).flatMap((c) => c.values);
}

const entry: BootHistoryEntry = {
  ts: 1000,
  workspaceId: 'ws-1',
  harnessSlug: 'h1',
  kind: 'announce_admitted',
  message: 'log=5fe26c2e0135',
};

describe('insertBootHistoryEventPg', () => {
  it('inserts then evicts past the per-(workspace,harness) cap, in that order, with the right values', async () => {
    const sql = fakeSql([]);
    await insertBootHistoryEventPg(entry, sql);
    const calls = callsOf(sql);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.strings.join('?')).toContain('INSERT INTO harness_shared.boot_history_events');
    expect(calls[0]!.values).toEqual(
      expect.arrayContaining(['ws-1', 'h1', 'announce_admitted', 'log=5fe26c2e0135', 1000]),
    );
    expect(calls[1]!.strings.join('?')).toContain('DELETE FROM harness_shared.boot_history_events');
    expect(calls[1]!.values).toEqual(expect.arrayContaining(['ws-1', 'h1']));
  });

  it('stores a null message when the entry omits one', async () => {
    const sql = fakeSql([]);
    await insertBootHistoryEventPg({ ...entry, message: undefined }, sql);
    expect(callsOf(sql)[0]!.values).toContain(null);
  });

  // EI-18736339540215666 recurrence guard: a vitest fixture write must NEVER land as
  // origin='real' — that's exactly the false-confidence trap this migration fixes.
  it("stamps origin='test' by default (isVitestOrigin() is true under this very test run)", async () => {
    expect(isVitestOrigin()).toBe(true);
    const sql = fakeSql([]);
    await insertBootHistoryEventPg(entry, sql);
    expect(callsOf(sql)[0]!.values).toContain('test');
    expect(callsOf(sql)[0]!.values).not.toContain('real');
  });

  it('an explicit entry.origin overrides the VITEST-inferred default', async () => {
    const sql = fakeSql([]);
    await insertBootHistoryEventPg({ ...entry, origin: 'real' }, sql);
    expect(callsOf(sql)[0]!.values).toContain('real');
    expect(callsOf(sql)[0]!.values).not.toContain('test');
  });
});

describe('own compaction anchor history hints', () => {
  it('skips newer failed attempts and returns the recorded successful seek index from real scoped history', async () => {
    const sql = fakeSql([
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'own_log_compaction', ts: 3,
        message: 'anchor=unreadable(atIndex=99,cause=timeout) lastCoversUpTo=0' },
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'own_log_compaction', ts: 2,
        message: 'anchor=found(excludes=presence) failures=0 lastCoversUpTo=42 lastRows=100' },
    ]);
    expect(await findOwnCompactionAnchorHintPg({ workspaceId: 'ws-1', harnessSlug: 'h1' }, sql)).toBe(42);
    expect(allText(sql)).toContain("AND origin = 'real'");
    expect(allValues(sql)).toEqual(expect.arrayContaining(['ws-1', 'h1', ['own_log_compaction'], 500]));
  });

  it('returns no hint for absent, malformed or unsafe recorded indices', async () => {
    const sql = fakeSql([
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'own_log_compaction', ts: 3,
        message: 'anchor=found(excludes=none) lastCoversUpTo=9007199254740993' },
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'own_log_compaction', ts: 2,
        message: 'anchor=found(excludes=none) lastCoversUpTo=0' },
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'own_log_compaction', ts: 1, message: null },
    ]);
    expect(await findOwnCompactionAnchorHintPg({ workspaceId: 'ws-1', harnessSlug: 'h1' }, sql)).toBeNull();
  });
});

describe('listBootHistoryEventsPg', () => {
  it('maps snake_case rows to the camelCase BootHistoryEntry shape, coercing a numeric-string ts', async () => {
    const sql = fakeSql([
      {
        workspace_id: 'ws-1',
        harness_slug: 'h1',
        kind: 'announce_admitted',
        message: 'log=5fe26c2e0135',
        ts: '1000',
      },
    ]);
    const rows = await listBootHistoryEventsPg({ workspaceId: 'ws-1' }, sql);
    expect(rows).toEqual([
      {
        workspaceId: 'ws-1',
        harnessSlug: 'h1',
        kind: 'announce_admitted',
        message: 'log=5fe26c2e0135',
        ts: 1000,
      },
    ]);
  });

  it('maps a null message to undefined (matches BootHistoryEntry.message being optional, not nullable)', async () => {
    const sql = fakeSql([
      { workspace_id: 'ws-1', harness_slug: 'h1', kind: 'boot_fail', message: null, ts: 1000 },
    ]);
    const rows = await listBootHistoryEventsPg({}, sql);
    expect(rows[0]!.message).toBeUndefined();
  });

  it('threads workspaceId / harnessSlug / kinds filters into the query only when supplied', async () => {
    const withFilters = fakeSql([]);
    await listBootHistoryEventsPg(
      { workspaceId: 'ws-1', harnessSlug: 'h1', kinds: ['announce_admitted', 'boot_fail'] },
      withFilters,
    );
    expect(allText(withFilters)).toContain('AND workspace_id');
    expect(allText(withFilters)).toContain('AND harness_slug');
    expect(allText(withFilters)).toContain('AND kind = ANY');
    expect(allValues(withFilters)).toEqual(expect.arrayContaining(['ws-1', 'h1']));
    expect(allValues(withFilters)).toContainEqual(['announce_admitted', 'boot_fail']);

    const noFilters = fakeSql([]);
    await listBootHistoryEventsPg({}, noFilters);
    expect(allText(noFilters)).not.toContain('AND workspace_id');
    expect(allText(noFilters)).not.toContain('AND harness_slug');
    expect(allText(noFilters)).not.toContain('AND kind = ANY');
  });

  it('clamps limit into [1, 500]', async () => {
    const tooHigh = fakeSql([]);
    await listBootHistoryEventsPg({ limit: 10_000 }, tooHigh);
    expect(allValues(tooHigh)).toContain(500);

    const tooLow = fakeSql([]);
    await listBootHistoryEventsPg({ limit: 0 }, tooLow);
    expect(allValues(tooLow)).toContain(1);
  });

  // EI-18736339540215666 recurrence guard: the default read must exclude test-fixture
  // rows, and only an EXPLICIT includeTestOrigin:true may pull them in.
  describe("origin filter (EI-18736339540215666: test-fixture rows must not read as real federation health)", () => {
    it("defaults to origin='real' only", async () => {
      const sql = fakeSql([]);
      await listBootHistoryEventsPg({}, sql);
      expect(allText(sql)).toContain("AND origin = 'real'");
    });

    it('omits the origin filter when includeTestOrigin:true is passed explicitly', async () => {
      const sql = fakeSql([]);
      await listBootHistoryEventsPg({ includeTestOrigin: true }, sql);
      expect(allText(sql)).not.toContain('origin');
    });
  });
});
