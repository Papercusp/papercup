import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory PG mock — model the table as a Map and emulate the
// `sql.begin` transactional read-modify-write the rate-limit code
// uses. The real implementation is a single round-trip per call;
// the mock just preserves that semantic.
const store = new Map<string, unknown>();

vi.mock('@papercusp/db-org', () => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    if (/SELECT payload FROM harness_shared\.operator_rate_limit/.test(sqlText)) {
      const ws = values[0] as string;
      const row = store.get(ws);
      return Promise.resolve(row ? [{ payload: row }] : []);
    }
    if (/INSERT INTO harness_shared\.operator_rate_limit/.test(sqlText)) {
      const ws = values[0] as string;
      const payloadRaw = values[1] as string;
      const payload = JSON.parse(payloadRaw);
      store.set(ws, payload);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }
  // sql.begin emulates the transaction by passing a `tx` proxy that has
  // the same shape as the top-level sql tag.
  (tagged as unknown as { begin: (cb: (tx: typeof tagged) => Promise<unknown>) => Promise<unknown> }).begin =
    async (cb) => cb(tagged);
  // The runtime resetBreaker/inspectState helpers go through a drizzle
  // `db` handle in addition to the raw `sql` template — stub the parts
  // they use (select/insert/onConflict). Tests in this file only call
  // checkRate/record503/recordSuccess (which go through `sql.begin`),
  // but module load reads `generated.X` so the export must exist.
  // Drizzle stub backed by the same `store` Map. The chain
  // .select({...}).from(t).where(eq(t.workspace_id, ws)).limit(N)
  // is fluent — each method returns `this`-like proxies until the
  // terminal `limit()` resolves to rows. We can't see the eq() target,
  // so just return everything we know about (the test only writes one
  // workspace).
  const dbStub = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const out: { payload: unknown }[] = [];
            for (const v of store.values()) out.push({ payload: v });
            return out;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: { workspace_id: string; payload: unknown }) => ({
        onConflictDoUpdate: async () => {
          store.set(row.workspace_id, row.payload);
          return undefined;
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return {
    getOrgPg: () => ({ sql: tagged, db: dbStub }),
    generated: { operatorRateLimitInHarnessShared: { workspace_id: {}, payload: {}, updated_at: {} } },
  };
});

import { checkRate, record503, recordSuccess, resetBreaker, inspectState } from './operator-rate-limit';

const WS = `test-ws-${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  store.clear();
});

afterEach(async () => {
  await resetBreaker(WS);
});

describe('checkRate', () => {
  it('allows up to the limit per window', async () => {
    expect((await checkRate(WS, 2)).allowed).toBe(true);
    expect((await checkRate(WS, 2)).allowed).toBe(true);
    const r = await checkRate(WS, 2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('rate-limit');
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('circuit breaker', () => {
  it('opens after 5 consecutive 503s', async () => {
    for (let i = 0; i < 5; i++) await record503(WS);
    const r = await checkRate(WS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('circuit-breaker');
    expect((await inspectState(WS)).breakerUntilMs).toBeGreaterThan(Date.now());
  });

  it('recordSuccess resets the consecutive counter (but not an open breaker)', async () => {
    await record503(WS);
    await record503(WS);
    await recordSuccess(WS);
    expect((await inspectState(WS)).consecutive503).toBe(0);
  });
});
