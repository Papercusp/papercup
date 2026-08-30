import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { PgCoordLog } from './pg-log';
import { isPgContentionError, withPgContentionRetry } from './pg-retry';

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code });
}

function makeSql(sequence: Array<unknown | Error>): { sql: Sql; readonly calls: number } {
  let calls = 0;
  const tag = () => {
    const result = sequence[calls++];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result ?? []);
  };
  return { sql: tag as unknown as Sql, get calls() { return calls; } };
}

function makeTransactionalSql(): {
  sql: Sql;
  readonly queryTexts: string[];
  readonly queryParams: unknown[][];
} {
  const queryTexts: string[] = [];
  const queryParams: unknown[][] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    for (let i = 1; i < strings.length; i += 1) {
      text += '?';
      text += strings[i] ?? '';
    }
    queryTexts.push(text);
    queryParams.push(values);
    if (text.includes('RETURNING id')) return Promise.resolve([{ id: '7' }]);
    return Promise.resolve([]);
  };
  const sql = tag as unknown as Sql;
  (sql as unknown as {
    begin: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  }).begin = (fn) => fn(sql);
  return { sql, queryTexts, queryParams };
}

const envelope = {
  ts: '2026-08-12T19:55:00.000Z',
  msg_id: 'retry-message',
  from: 'sender',
  to: ['recipient'],
  kind: 'message' as const,
  summary: 'retry me',
};

describe('PG contention retry', () => {
  it.each(['55P03', '57014'])('recognizes PostgreSQL transient code %s', (code) => {
    expect(isPgContentionError(pgError(code))).toBe(true);
  });

  it('does not retry unrelated database errors', async () => {
    const error = pgError('23505');
    const run = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(withPgContentionRetry(run, { backoffsMs: [0, 0], sleep })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries appendLine after a transient lock timeout so coord:send does not lose its durable row', async () => {
    const fake = makeSql([pgError('57014'), [{ id: '41' }]]);
    const sleep = vi.fn(async () => {});
    const log = new PgCoordLog({
      getSql: () => fake.sql,
      ensureSchema: async () => {},
      workspaceId: 'ws-test',
      contentionRetry: { backoffsMs: [0], sleep },
    });

    await expect(log.appendLine('messages', 'sender', envelope)).resolves.toBe(41);
    expect(fake.calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('uses a PostgreSQL-safe deterministic advisory-lock key for idempotent appends', async () => {
    const fake = makeTransactionalSql();
    const log = new PgCoordLog({
      getSql: () => fake.sql,
      ensureSchema: async () => {},
      workspaceId: `ws${String.fromCharCode(0)}test`,
    });
    const line = {
      ...envelope,
      msg_id: `message${String.fromCharCode(0)}id`,
    };

    await expect(log.appendLineIfAbsent('messages', 'sender', line)).resolves.toMatchObject({
      created: true,
      sequence: 7,
    });

    expect(fake.queryTexts[0]).toContain('hashtextextended(?, 0)');
    const lockKey = fake.queryParams[0]?.[0];
    expect(lockKey).toBe(JSON.stringify([`ws${String.fromCharCode(0)}test`, 'messages', line.msg_id]));
    expect(typeof lockKey).toBe('string');
    expect((lockKey as string).includes(String.fromCharCode(0))).toBe(false);
    expect(lockKey).toContain('\\u0000');
  });
});
