/**
 * carry-respawn-marker.test.ts — the "respawn expected" signal EI-18676518990229124's
 * fix hinges on: session:request-compaction marks an owner right before its
 * SessionEnd fires; report.ts's P-002 branch consumes (check-and-clear) it to
 * decide whether the ending owner's claims should survive the transition.
 *
 * The marker is PG-backed (migration 716) rather than a module-scoped Map,
 * because the operator is clustered and the marking worker is usually not the
 * one that handles the SessionEnd — see the module header. These tests drive it
 * through an injected fake `sql` so they stay unit-fast; `carry-respawn-marker.integration.test.ts`
 * runs the SAME expectations against real Postgres, which is what actually
 * proves the SQL (a fake can only prove the logic around it).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  RESPAWN_EXPECTED_TTL_MS,
  consumeRespawnExpected,
  markRespawnExpected,
} from './carry-respawn-marker';

/**
 * Minimal stand-in for the three tagged-template statements this module issues.
 * Deliberately dispatches on the statement text so an unrecognized query fails
 * loudly instead of silently returning "no mark" (which would make a broken
 * implementation look like a correctly-empty one).
 */
function makeFakeSql(): {
  sql: Sql;
  store: Map<string, Date>;
  statements: string[];
  fail: (on: RegExp) => void;
} {
  const store = new Map<string, Date>();
  const statements: string[] = [];
  let failOn: RegExp | null = null;
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ? ');
    statements.push(text);
    if (failOn?.test(text)) return Promise.reject(new Error('simulated PG failure'));
    if (/INSERT INTO harness_shared\.session_respawn_expected/.test(text)) {
      const [owner, ttlSec] = vals as [string, number];
      store.set(owner, new Date(Date.now() + ttlSec * 1000));
      return Promise.resolve([]);
    }
    if (/DELETE FROM harness_shared\.session_respawn_expected[\s\S]*WHERE owner_id/.test(text)) {
      const [owner] = vals as [string];
      const expiresAt = store.get(owner);
      store.delete(owner);
      return Promise.resolve(expiresAt ? [{ expires_at: expiresAt }] : []);
    }
    if (/DELETE FROM harness_shared\.session_respawn_expected/.test(text)) {
      store.clear();
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected statement: ${text}`));
  };
  return {
    sql: fn as unknown as Sql,
    store,
    statements,
    fail: (on: RegExp) => {
      failOn = on;
    },
  };
}

describe('carry-respawn-marker', () => {
  it('an unmarked owner is never treated as respawn-expected', async () => {
    const { sql } = makeFakeSql();
    expect(await consumeRespawnExpected('su-never-marked', { sql })).toBe(false);
  });

  it('marking then consuming returns true', async () => {
    const { sql } = makeFakeSql();
    await markRespawnExpected('su-a', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('su-a', { sql })).toBe(true);
  });

  it('atomically invalidates the predecessor process identity when marking a respawn', async () => {
    const { sql, statements } = makeFakeSql();
    await markRespawnExpected('su-respawn', RESPAWN_EXPECTED_TTL_MS, { sql });

    expect(statements[0]).toMatch(/WITH marked AS/);
    expect(statements[0]).toMatch(/UPDATE harness_shared\.coord_presence/);
    expect(statements[0]).toMatch(/SET host = ''[\s\S]*pid = NULL[\s\S]*tty = NULL/);
    expect(statements[0]).toMatch(/context_tokens = NULL[\s\S]*context_estimated_at = NULL/);
    expect(statements[0]).toMatch(/presence\.owner_id = marked\.owner_id/);
  });

  it('consuming is SINGLE-USE — a second check for the same owner is false', async () => {
    const { sql } = makeFakeSql();
    await markRespawnExpected('su-b', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('su-b', { sql })).toBe(true);
    expect(await consumeRespawnExpected('su-b', { sql })).toBe(false);
  });

  it('marks are scoped per-owner — marking one owner never affects another', async () => {
    const { sql } = makeFakeSql();
    await markRespawnExpected('su-c', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('su-d', { sql })).toBe(false);
    expect(await consumeRespawnExpected('su-c', { sql })).toBe(true);
  });

  it('a mark past its TTL is treated as stale (false) — the P-001 backstop is the correct recovery, not a suppressed release', async () => {
    const { sql } = makeFakeSql();
    await markRespawnExpected('su-e', 1000, { sql });
    expect(await consumeRespawnExpected('su-e', { sql, nowMs: Date.now() + 1001 })).toBe(false);
  });

  it('an EXPIRED mark is still cleared, not left behind for a later reader', async () => {
    const { sql, store } = makeFakeSql();
    await markRespawnExpected('su-e2', 1000, { sql });
    expect(await consumeRespawnExpected('su-e2', { sql, nowMs: Date.now() + 5000 })).toBe(false);
    expect(store.has('su-e2')).toBe(false);
  });

  it('a mark within TTL survives right up to (not including) expiry', async () => {
    const { sql } = makeFakeSql();
    const t0 = Date.now();
    await markRespawnExpected('su-f', 1000, { sql });
    expect(await consumeRespawnExpected('su-f', { sql, nowMs: t0 + 999 })).toBe(true);
  });

  it('the default TTL is 60s', () => {
    expect(RESPAWN_EXPECTED_TTL_MS).toBe(60_000);
  });

  it('re-marking the same owner before it is consumed refreshes the expiry (last mark wins)', async () => {
    vi.useFakeTimers();
    try {
      const { sql } = makeFakeSql();
      const t0 = Date.now();
      await markRespawnExpected('su-g', 1000, { sql });
      vi.advanceTimersByTime(500);
      await markRespawnExpected('su-g', 1000, { sql }); // refresh
      // 1400ms after the FIRST mark (would be stale) but 900ms after the second.
      expect(await consumeRespawnExpected('su-g', { sql, nowMs: t0 + 1400 })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blank/empty ownerId is a no-op mark (never consumable)', async () => {
    const { sql } = makeFakeSql();
    await markRespawnExpected('', RESPAWN_EXPECTED_TTL_MS, { sql });
    await markRespawnExpected('   ', RESPAWN_EXPECTED_TTL_MS, { sql });
    expect(await consumeRespawnExpected('', { sql })).toBe(false);
    expect(await consumeRespawnExpected('   ', { sql })).toBe(false);
  });

  describe('fail-safe: a PG failure must degrade to TODAY’s behavior, never strand a claim', () => {
    it('a failed consume reports NOT-expected, so the ordinary release still runs', async () => {
      const { sql, fail } = makeFakeSql();
      await markRespawnExpected('su-h', RESPAWN_EXPECTED_TTL_MS, { sql });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fail(/DELETE FROM/);
        expect(await consumeRespawnExpected('su-h', { sql })).toBe(false);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('a failed mark never throws — the compaction the caller asked for still proceeds', async () => {
      const { sql, fail } = makeFakeSql();
      fail(/INSERT INTO/);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(
          markRespawnExpected('su-i', RESPAWN_EXPECTED_TTL_MS, { sql }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
