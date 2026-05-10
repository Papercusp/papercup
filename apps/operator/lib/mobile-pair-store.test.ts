/**
 * Tests for mobile-pair-store. Mocks @restart/db-org so the PG-backed
 * mint/consume contract is exercised without a live database.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];
const sqlQueue: unknown[][] = [];

vi.mock('@restart/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ strings, values });
      return Promise.resolve(sqlQueue.shift() ?? []);
    },
  }),
}));

import { mintPairToken, consumePairToken, newDeviceId } from './mobile-pair-store';

beforeEach(() => {
  sqlCalls.length = 0;
  sqlQueue.length = 0;
});

describe('mintPairToken', () => {
  it('inserts a fresh row and returns token + expiresAt', async () => {
    sqlQueue.push([]); // INSERT
    sqlQueue.push([{ n: 0 }]); // count for GC

    const before = Date.now();
    const { pairToken, expiresAt } = await mintPairToken({
      workspaceId: 'ws-1',
      desktopHost: 'localhost:3055',
      userEmail: 'a@b.com',
    });

    expect(pairToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pairToken.length).toBeGreaterThan(20);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 100);

    expect(sqlCalls).toHaveLength(2);
    const sqlText = sqlCalls[0].strings.join('?');
    expect(sqlText).toContain('INSERT INTO harness_shared.mobile_pair_tokens');
    expect(sqlText).toContain('false'); // consumed=false hard-coded in SQL, not a value
    // values: pairToken, workspaceId, userEmail, desktopHost, expiresAt, createdAt
    expect(sqlCalls[0].values[0]).toBe(pairToken);
    expect(sqlCalls[0].values[1]).toBe('ws-1');
    expect(sqlCalls[0].values[2]).toBe('a@b.com');
    expect(sqlCalls[0].values[3]).toBe('localhost:3055');
    expect(sqlCalls[0].values[4]).toBe(expiresAt);
  });

  it('passes null when userEmail is omitted', async () => {
    sqlQueue.push([]); // INSERT
    sqlQueue.push([{ n: 0 }]); // count
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(sqlCalls[0].values[2]).toBeNull();
  });

  it('triggers opportunistic GC sweep when row count > 1000', async () => {
    sqlQueue.push([]); // INSERT
    sqlQueue.push([{ n: 1500 }]); // count
    sqlQueue.push([]); // DELETE
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2].strings.join('?')).toContain('DELETE FROM harness_shared.mobile_pair_tokens');
  });

  it('skips GC when row count <= 1000', async () => {
    sqlQueue.push([]); // INSERT
    sqlQueue.push([{ n: 999 }]); // count
    await mintPairToken({ workspaceId: 'w', desktopHost: 'h' });
    expect(sqlCalls).toHaveLength(2); // no DELETE
  });

  it('mints unique tokens', async () => {
    sqlQueue.push([], [{ n: 0 }], [], [{ n: 0 }]);
    const a = (await mintPairToken({ workspaceId: 'w', desktopHost: 'h' })).pairToken;
    const b = (await mintPairToken({ workspaceId: 'w', desktopHost: 'h' })).pairToken;
    expect(a).not.toBe(b);
  });
});

describe('consumePairToken', () => {
  it('returns parsed PendingPair on a successful UPDATE … RETURNING', async () => {
    sqlQueue.push([
      {
        pair_token: 'abc',
        workspace_id: 'ws-1',
        user_email: 'a@b.com',
        desktop_host: 'h',
        expires_at_ms: 9999999999999,
      },
    ]);
    const out = await consumePairToken('abc');
    expect(out).not.toBeNull();
    expect(out!.workspaceId).toBe('ws-1');
    expect(out!.userEmail).toBe('a@b.com');
    expect(out!.desktopHost).toBe('h');

    const sql = sqlCalls[0].strings.join('?');
    expect(sql).toContain('UPDATE harness_shared.mobile_pair_tokens');
    expect(sql).toContain('SET consumed = true');
    expect(sql).toContain('consumed = false');
    expect(sql).toContain('expires_at_ms');
  });

  it('returns null when no row matched (unknown / expired / already consumed)', async () => {
    sqlQueue.push([]);
    expect(await consumePairToken('missing')).toBeNull();
  });

  it('handles null user_email by returning undefined', async () => {
    sqlQueue.push([
      { pair_token: 'x', workspace_id: 'w', user_email: null, desktop_host: 'h', expires_at_ms: 9999999999999 },
    ]);
    const out = await consumePairToken('x');
    expect(out!.userEmail).toBeUndefined();
  });
});

describe('newDeviceId', () => {
  it('returns unique UUIDs', () => {
    const a = newDeviceId();
    const b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
