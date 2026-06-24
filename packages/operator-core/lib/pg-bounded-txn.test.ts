/**
 * pg-bounded-txn.test.ts — the bounded+atomic admin-pool write txn.
 *
 * Pins the reliability contract that fixes the work_items:comment indefinite-hang:
 *   - the txn issues SET LOCAL statement_timeout + lock_timeout (so a stalled
 *     query is killed DB-side, the only thing that actually unblocks postgres-js);
 *   - a PG contention timeout (57014 statement_timeout / 55P03 lock_timeout) is
 *     mapped to a typed OrgTxnTimeoutError the caller turns into a clean failure;
 *   - any OTHER error propagates unchanged (and the txn rolls back).
 *
 * Run: cd packages/operator-core && npx vitest run lib/pg-bounded-txn.test.ts
 */
import { describe, expect, it } from 'vitest';
import { boundedOrgTxn, OrgTxnTimeoutError } from './pg-bounded-txn';

/** A fake postgres-js client: `.begin(cb)` invokes cb with a tagged-template `tx`
 *  that records each query's bound params and resolves to []. */
function fakeClient(onTag?: (text: string, vals: unknown[]) => void) {
  const tag = (s: TemplateStringsArray, ...v: unknown[]) => {
    onTag?.(s.join('?'), v);
    return Promise.resolve([] as unknown[]);
  };
  return { begin: async (cb: (tx: unknown) => Promise<unknown>) => cb(tag) } as never;
}

function pgError(code: string): Error & { code: string } {
  const e = new Error(`pg ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

describe('boundedOrgTxn', () => {
  it('runs fn in the txn, returns its value, and SET LOCALs both timeouts (bound params)', async () => {
    const vals: unknown[] = [];
    const client = fakeClient((_text, v) => vals.push(...v));
    const out = await boundedOrgTxn(async (tx) => {
      await (tx as never as (s: TemplateStringsArray) => Promise<unknown[]>)`INSERT INTO t VALUES (1)`;
      return 'done';
    }, { client, statementTimeoutMs: 12345, lockTimeoutMs: 6789 });
    expect(out).toBe('done');
    // The set_config calls carry the configured timeouts as 'Nms' bound params.
    expect(vals).toContain('6789ms'); // lock_timeout
    expect(vals).toContain('12345ms'); // statement_timeout
  });

  it('maps a PG 57014 (statement_timeout) to OrgTxnTimeoutError with pgCode', async () => {
    const err = await boundedOrgTxn(async () => {
      throw pgError('57014');
    }, { client: fakeClient() }).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).pgCode).toBe('57014');
    expect((err as OrgTxnTimeoutError).cause).toMatchObject({ code: '57014' });
  });

  it('maps a PG 55P03 (lock_timeout) to OrgTxnTimeoutError', async () => {
    const err = await boundedOrgTxn(async () => {
      throw pgError('55P03');
    }, { client: fakeClient() }).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).pgCode).toBe('55P03');
  });

  it('propagates a non-contention error unchanged (e.g. a unique violation)', async () => {
    const original = pgError('23505');
    const err = await boundedOrgTxn(async () => {
      throw original;
    }, { client: fakeClient() }).catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(OrgTxnTimeoutError);
  });

  it('floors absurdly-small timeouts (never sets sub-100ms)', async () => {
    const vals: unknown[] = [];
    const client = fakeClient((_t, v) => vals.push(...v));
    await boundedOrgTxn(async () => 1, { client, statementTimeoutMs: 1, lockTimeoutMs: 1 });
    expect(vals).toContain('100ms'); // both floored to 100ms
  });
});
