/**
 * messages:outbox — PURE unit tests for the handler's security + shaping
 * logic, exercised directly.
 *
 * Focus:
 *   - inline slug-regex reject → degraded (same identifier-injection guard
 *     as messages:inbox, expressed inline here).
 *   - the Drizzle select chain is driven and its result rows are shaped.
 *   - summary `{ ts, subject }` projection (drops action + details).
 *
 * `drizzle(ctx.tx)` is mocked: we replace the postgres-js `drizzle` factory
 * with one that returns a chainable, awaitable query builder whose terminal
 * value is the fixture rows.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The query builder the handler walks:
 *   db.select({...}).from(t).where(...).orderBy(...).limit(n)
 * Every link returns `this`; awaiting the builder resolves to `rows`. We
 * also record the projection object passed to `.select(...)` so a test can
 * assert which columns were requested.
 */
let fixtureRows: unknown[] = [];
let lastSelectProjection: Record<string, unknown> | null = null;
let limitCalledWith: number | null = null;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'select') lastSelectProjection = args[0] as Record<string, unknown>;
      if (key === 'limit') limitCalledWith = args[0] as number;
      return builder;
    };
  for (const k of ['select', 'from', 'where', 'orderBy', 'limit']) builder[k] = chain(k);
  // Make the builder awaitable — `await builder` resolves to fixtureRows.
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fixtureRows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => makeBuilder()),
}));

// The handler also calls and(), eq(), desc() — keep the real implementations;
// they return opaque SQL objects our builder ignores.
import tool from './outbox';

const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: {} as never,
  log: vi.fn(),
});

beforeEach(() => {
  fixtureRows = [];
  lastSelectProjection = null;
  limitCalledWith = null;
});

describe('messages:outbox — slug-regex security reject', () => {
  it('rejects an identifier-injection slug before building any query', async () => {
    const res = await tool.handler(
      { slug: 'x"; DROP TABLE audit_log; --', detail: 'summary', limit: 50 } as never,
      CTX() as never,
    );
    expect(res.degraded).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.degradedReasons?.[0]).toContain('invalid slug');
    expect(res.degradedReasons?.[0]).toContain(JSON.stringify('x"; DROP TABLE audit_log; --'));
    // No drizzle query was driven for a rejected slug.
    expect(lastSelectProjection).toBeNull();
  });

  it('accepts a normal slug and drives the select chain', async () => {
    fixtureRows = [];
    const res = await tool.handler(
      { slug: 'my-harness', detail: 'summary', limit: 7 } as never,
      CTX() as never,
    );
    expect(res.degraded).toBeUndefined();
    expect(lastSelectProjection).not.toBeNull();
    // limit passed through to the builder.
    expect(limitCalledWith).toBe(7);
  });
});

describe('messages:outbox — select shaping', () => {
  it('requests ts/action/subject/details columns', async () => {
    await tool.handler({ slug: 'ok', detail: 'full', limit: 50 } as never, CTX() as never);
    expect(lastSelectProjection).not.toBeNull();
    expect(Object.keys(lastSelectProjection!).sort()).toEqual(['action', 'details', 'subject', 'ts']);
  });
});

describe('messages:outbox — summary {ts,subject} projection', () => {
  it('summary keeps only ts + subject, dropping action + details', async () => {
    fixtureRows = [
      { ts: 100, action: 'send_message', subject: 'hi', details: { big: 'payload' } },
      { ts: 90, action: 'send_message', subject: 'bye', details: { big: 'payload2' } },
    ];
    const res = await tool.handler({ slug: 'ok', detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual([
      { ts: 100, subject: 'hi' },
      { ts: 90, subject: 'bye' },
    ]);
    expect(JSON.stringify(res.data)).not.toContain('send_message');
    expect(JSON.stringify(res.data)).not.toContain('payload');
  });

  it('full returns the raw rows including action + details', async () => {
    const rows = [{ ts: 100, action: 'send_message', subject: 'hi', details: { x: 1 } }];
    fixtureRows = rows;
    const res = await tool.handler({ slug: 'ok', detail: 'full', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual(rows);
  });
});
