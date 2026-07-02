/**
 * coord-quarantine-store unit tests (P-013 residual — the store itself had zero
 * coverage; enforcement call sites (coord-message.ts, bee-claim-spec.ts) already
 * had it). PG-free: a fake `sql` tagged-template captures the query text +
 * interpolated values instead of hitting real Postgres — mirrors
 * agent-tools/coordination/federated-presence.test.ts's `fakeSql` pattern.
 *
 * NOTE on nested fragments: `listCoordQuarantine`'s optional filter is a nested
 * `sql\`...\`` expression (postgres.js fragment composition). JS evaluates that
 * expression BEFORE the enclosing tagged template is invoked, so it lands as an
 * EARLIER call in `calls[]` than the outer query — assertions below check the
 * flattened union of every captured call's values, not one call by index, so
 * they don't depend on that ordering.
 */
import { describe, expect, it } from 'vitest';
import { quarantineCoordMessage, listCoordQuarantine, clearCoordQuarantineForAuthor } from './coord-quarantine-store';

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

describe('quarantineCoordMessage', () => {
  it('inserts then evicts past the per-author cap, in that order, with the right values', async () => {
    const sql = fakeSql([]);
    await quarantineCoordMessage(
      {
        workspaceId: 'ws-1',
        msgId: 'm1',
        harnessSlug: 'h1',
        surface: 'coord',
        body: { text: 'hi' },
        authorGithubUserId: 42,
        authorDevicePubkey: 'dev-1',
        reason: 'below-message-tier',
        msgTs: 1000,
        nowMs: 2000,
      },
      sql,
    );
    const calls = callsOf(sql);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.strings.join('?')).toContain('INSERT INTO harness_shared.coord_quarantine');
    expect(calls[0]!.values).toEqual(
      expect.arrayContaining(['ws-1', 'm1', 'h1', 'coord', 42, 'dev-1', 'below-message-tier', 1000]),
    );
    expect(calls[1]!.strings.join('?')).toContain('DELETE FROM harness_shared.coord_quarantine');
    expect(calls[1]!.values).toEqual(expect.arrayContaining(['ws-1', 'dev-1']));
  });
});

describe('listCoordQuarantine', () => {
  it('maps snake_case rows to the camelCase shape, coercing numeric-string ids', async () => {
    const sql = fakeSql([
      {
        msg_id: 'm1',
        harness_slug: 'h1',
        surface: 'coord',
        body: { text: 'hi' },
        author_github_user_id: '42',
        author_device_pubkey: 'dev-1',
        reason: 'below-message-tier',
        msg_ts: '1000',
        created_ts: '2000',
      },
    ]);
    const rows = await listCoordQuarantine({ workspaceId: 'ws-1' }, sql);
    expect(rows).toEqual([
      {
        msgId: 'm1',
        harnessSlug: 'h1',
        surface: 'coord',
        body: { text: 'hi' },
        authorGithubUserId: 42,
        authorDevicePubkey: 'dev-1',
        reason: 'below-message-tier',
        msgTs: 1000,
        createdTs: 2000,
      },
    ]);
  });

  it('preserves a null authorGithubUserId (unattested / unresolved author)', async () => {
    const sql = fakeSql([
      {
        msg_id: 'm1',
        harness_slug: 'h1',
        surface: 'coord',
        body: {},
        author_github_user_id: null,
        author_device_pubkey: 'dev-1',
        reason: 'rate-exceeded',
        msg_ts: 1000,
        created_ts: 2000,
      },
    ]);
    const rows = await listCoordQuarantine({ workspaceId: 'ws-1' }, sql);
    expect(rows[0]!.authorGithubUserId).toBeNull();
  });

  it('threads authorGithubUserId into the query only when supplied', async () => {
    const withFilter = fakeSql([]);
    await listCoordQuarantine({ workspaceId: 'ws-1', authorGithubUserId: 42 }, withFilter);
    expect(allValues(withFilter)).toContain(42);
    expect(allText(withFilter)).toContain('AND author_github_user_id');

    const withoutFilter = fakeSql([]);
    await listCoordQuarantine({ workspaceId: 'ws-1' }, withoutFilter);
    expect(allValues(withoutFilter)).not.toContain(42);
  });

  it('clamps limit into [1, 500]', async () => {
    const tooHigh = fakeSql([]);
    await listCoordQuarantine({ workspaceId: 'ws-1', limit: 10_000 }, tooHigh);
    expect(allValues(tooHigh)).toContain(500);

    const tooLow = fakeSql([]);
    await listCoordQuarantine({ workspaceId: 'ws-1', limit: 0 }, tooLow);
    expect(allValues(tooLow)).toContain(1);
  });
});

describe('clearCoordQuarantineForAuthor', () => {
  it('deletes scoped to (workspaceId, authorGithubUserId) and reports the affected count', async () => {
    const result = Object.assign([], { count: 3 });
    const sql = fakeSql(result);
    const out = await clearCoordQuarantineForAuthor({ workspaceId: 'ws-1', authorGithubUserId: 42 }, sql);
    expect(out).toEqual({ cleared: 3 });
    expect(allText(sql)).toContain('DELETE FROM harness_shared.coord_quarantine');
    expect(allValues(sql)).toEqual(['ws-1', 42]);
  });

  it('is idempotent — clearing an empty backlog reports cleared:0, not an error', async () => {
    const result = Object.assign([], { count: 0 });
    const out = await clearCoordQuarantineForAuthor({ workspaceId: 'ws-1', authorGithubUserId: 42 }, fakeSql(result));
    expect(out).toEqual({ cleared: 0 });
  });

  it('defaults cleared to 0 when the driver omits `.count`', async () => {
    const out = await clearCoordQuarantineForAuthor({ workspaceId: 'ws-1', authorGithubUserId: 42 }, fakeSql([]));
    expect(out).toEqual({ cleared: 0 });
  });
});
