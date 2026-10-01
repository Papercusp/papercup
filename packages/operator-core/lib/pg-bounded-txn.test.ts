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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { boundedOrgTxn, OrgTxnTimeoutError } from './pg-bounded-txn';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BOUNDED_TXN_MODULE = pathToFileURL(fileURLToPath(new URL('./pg-bounded-txn.ts', import.meta.url))).href;

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
    const out = await boundedOrgTxn(
      async (tx) => {
        await (tx as never as (s: TemplateStringsArray) => Promise<unknown[]>)`INSERT INTO t VALUES (1)`;
        return 'done';
      },
      { client, statementTimeoutMs: 12345, lockTimeoutMs: 6789 },
    );
    expect(out).toBe('done');
    // The set_config calls carry the configured timeouts as 'Nms' bound params.
    expect(vals).toContain('6789ms'); // lock_timeout
    expect(vals).toContain('12345ms'); // statement_timeout
  });

  it('starts read-only transactions before applying the local timeouts', async () => {
    const statements: string[] = [];
    const client = fakeClient((text) => statements.push(text));

    await boundedOrgTxn(async () => 'rows', { client, readOnly: true });

    expect(statements[0]).toMatch(/SET TRANSACTION READ ONLY/i);
    expect(statements[1]).toMatch(/set_config\('lock_timeout'/i);
    expect(statements[1]).toMatch(/set_config\('statement_timeout'/i);
  });

  it('cancels an active postgres query when the caller aborts the transaction', async () => {
    let resolveSlowStart!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      resolveSlowStart = resolve;
    });
    const cancel = vi.fn();
    const client = {
      begin: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb(((strings: TemplateStringsArray, ..._values: unknown[]) => {
          if (strings.join('?').includes('set_config')) return Promise.resolve([]);
          const pending = new Promise<unknown[]>(() => {});
          resolveSlowStart();
          return Object.assign(pending, { cancel });
        }) as never),
    } as never;
    const controller = new AbortController();
    const transaction = boundedOrgTxn(
      async (tx) => {
        await (tx as never as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)`
          SELECT slow_claim_query()
        `;
      },
      { client, signal: controller.signal },
    );

    await slowStarted;
    controller.abort();

    await expect(transaction).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('observes a pre-aborted signal without emitting an unhandled sibling rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const controller = new AbortController();
      const reason = new Error('f12-before');
      controller.abort(reason);
      let fnRan = false;

      const transaction = boundedOrgTxn(
        async () => {
          fnRan = true;
          return 'unreachable';
        },
        { client: fakeClient(), signal: controller.signal },
      );

      await expect(transaction).rejects.toBe(reason);
      // Node reports a rejected promise without a handler at the end of the
      // turn. Give that report a chance to arrive before asserting the guard.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fnRan).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('handles a pre-aborted signal under Node\'s default unhandled-rejection policy', () => {
    const childEnv = { ...process.env };
    // Run without Vitest\'s process hooks or inherited NODE_OPTIONS so this
    // exercises the same default policy as the packaged Node host.
    delete childEnv.VITEST;
    delete childEnv.NODE_OPTIONS;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import { boundedOrgTxn } from ${JSON.stringify(BOUNDED_TXN_MODULE)};
          const tag = () => Promise.resolve([]);
          const client = { begin: async (cb) => cb(tag) };
          const controller = new AbortController();
          controller.abort(new Error('f12-before'));
          let fnRan = false;
          await boundedOrgTxn(async () => {
            fnRan = true;
            return 'unreachable';
          }, { client, signal: controller.signal }).then(
            () => { throw new Error('expected pre-abort rejection'); },
            (error) => {
              if (error?.message !== 'f12-before') throw error;
            },
          );
          if (fnRan) throw new Error('pre-aborted transaction invoked fn');
        `,
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.signal).toBeNull();
    expect(child.stderr).toBe('');
  });

  it('observes an asynchronous query cancellation rejection under the Node host policy', () => {
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    delete childEnv.NODE_OPTIONS;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import { boundedOrgTxn } from ${JSON.stringify(BOUNDED_TXN_MODULE)};
          const controller = new AbortController();
          let started;
          const startedPromise = new Promise((resolve) => { started = resolve; });
          let cancelCalls = 0;
          const tag = (strings) => {
            if (strings.join('').includes('set_config')) return Promise.resolve([]);
            started();
            return Object.assign(new Promise(() => {}), {
              cancel() {
                cancelCalls++;
                return Promise.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
              },
            });
          };
          const transaction = boundedOrgTxn(async (tx) => {
            await tx\`SELECT slow_query()\`;
          }, { client: { begin: async (cb) => cb(tag) }, signal: controller.signal });
          await startedPromise;
          controller.abort();
          await transaction.then(
            () => { throw new Error('expected abort'); },
            (error) => { if (error?.name !== 'AbortError') throw error; },
          );
          await new Promise((resolve) => setImmediate(resolve));
          if (cancelCalls !== 1) throw new Error('query cancellation not invoked once');
        `,
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.signal).toBeNull();
    expect(child.stderr).toBe('');
  });

  it('does not cancel an unexecuted SQL fragment or crash the Node host on abort', () => {
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    delete childEnv.NODE_OPTIONS;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import { boundedOrgTxn } from ${JSON.stringify(BOUNDED_TXN_MODULE)};
          const controller = new AbortController();
          let fragment;
          let started;
          const startedPromise = new Promise((resolve) => { started = resolve; });
          const tag = (strings, ...values) => {
            if (strings.join('').includes('set_config')) return Promise.resolve([]);
            if (!strings.join('').includes('SELECT slow_query')) {
              fragment = Object.assign(new Promise(() => {}), {
                executed: false,
                active: false,
                cancel() {
                  return Promise.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
                },
              });
              return fragment;
            }
            started();
            return Object.assign(new Promise(() => {}), {
              executed: true,
              active: true,
              cancel() { return Promise.resolve(); },
            });
          };
          const transaction = boundedOrgTxn(async (tx) => {
            const condition = tx\`(last_released_by IS NULL)\`;
            await tx\`SELECT slow_query() WHERE \${condition}\`;
          }, { client: { begin: async (cb) => cb(tag) }, signal: controller.signal });
          await startedPromise;
          controller.abort();
          await transaction.then(
            () => { throw new Error('expected abort'); },
            (error) => { if (error?.name !== 'AbortError') throw error; },
          );
          await new Promise((resolve) => setImmediate(resolve));
          if (!fragment || fragment.executed !== false) throw new Error('fragment was executed');
        `,
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.signal).toBeNull();
    expect(child.stderr).toBe('');
  });

  it('does not execute tagged or unsafe SQL fragments while tracking cancellable queries', async () => {
    const executed: string[] = [];
    const makeQuery = (text: string) => {
      let settled = false;
      const query = {
        fragment: false,
        cancel: vi.fn(),
        then(resolve: (rows: unknown[]) => void) {
          if (!settled) {
            settled = true;
            executed.push(text);
          }
          resolve([]);
        },
      };
      return query;
    };
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      for (const value of values) {
        if (value && typeof value === 'object' && 'fragment' in value) {
          (value as { fragment: boolean }).fragment = true;
        }
      }
      return makeQuery(strings.join('?'));
    };
    const tx = Object.assign(tag, {
      unsafe: (text: string) => makeQuery(text),
    });
    const client = {
      begin: async (cb: (transaction: unknown) => Promise<unknown>) => cb(tx),
    } as never;
    const controller = new AbortController();

    await boundedOrgTxn(
      async (transaction) => {
        const taggedFragment = (transaction as never as (strings: TemplateStringsArray, ...values: unknown[]) => unknown)`
          (last_released_by IS NULL)
        `;
        const unsafeFragment = (transaction as never as { unsafe: (text: string) => unknown }).unsafe('item_kind');
        await (transaction as never as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)`
          SELECT 1 WHERE ${taggedFragment} AND ${unsafeFragment}
        `;
      },
      { client, signal: controller.signal },
    );

    expect(executed.filter((text) => text.includes('last_released_by') || text === 'item_kind')).toEqual([]);
    expect(executed.filter((text) => text.includes('SELECT 1 WHERE'))).toHaveLength(1);
  });

  it('fails a stalled admin-pool acquisition before entering fn', async () => {
    let fnRan = false;
    const client = {
      begin: async () => new Promise<never>(() => {}),
    } as never;

    const err = await boundedOrgTxn(
      async () => {
        fnRan = true;
        return 'unreachable';
      },
      { client, acquireTimeoutMs: 20 },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect((err as DbCallDeadlineError).label).toBe('boundedOrgTxn:acquire(admin)');
    expect(fnRan).toBe(false);
  });

  it('maps a PG 57014 (statement_timeout) to OrgTxnTimeoutError with pgCode', async () => {
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('57014');
      },
      { client: fakeClient() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).pgCode).toBe('57014');
    expect((err as OrgTxnTimeoutError).cause).toMatchObject({ code: '57014' });
  });

  it('maps a PG 55P03 (lock_timeout) to OrgTxnTimeoutError', async () => {
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('55P03');
      },
      { client: fakeClient() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).pgCode).toBe('55P03');
  });

  it('propagates a non-contention error unchanged (e.g. a unique violation)', async () => {
    const original = pgError('23505');
    const err = await boundedOrgTxn(
      async () => {
        throw original;
      },
      { client: fakeClient() },
    ).catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(OrgTxnTimeoutError);
  });

  it('floors absurdly-small timeouts (never sets sub-100ms)', async () => {
    const vals: unknown[] = [];
    const client = fakeClient((_t, v) => vals.push(...v));
    await boundedOrgTxn(async () => 1, { client, statementTimeoutMs: 1, lockTimeoutMs: 1 });
    expect(vals).toContain('100ms'); // both floored to 100ms
  });

  /**
   * EI-19404770733829453: a bare "canceling statement due to lock timeout" names no
   * cause. On a contention timeout, boundedOrgTxn runs a best-effort diagnostic query
   * (on a FRESH connection — the failing txn's own connection already aborted) and
   * folds the head blocker into the thrown error's message.
   */
  it('folds a head-blocker diagnosis into the thrown error on a contention timeout', async () => {
    let calls = 0;
    let diagnosticSql = '';
    const client = {
      begin: async (cb: (tx: unknown) => Promise<unknown>) => {
        calls++;
        if (calls === 1) {
          // the main txn: a plain template-tag fn, like the other tests' fakeClient.
          return cb((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([] as unknown[]));
        }
        // the diagnostic query: tx needs `.unsafe`, and its SECOND call (the SELECT)
        // is the one whose return value the diagnosis reads.
        const rows = [
          {
            pid: 1644480,
            age_s: 104,
            // pg_stat_activity.query is only the blocker's current/last statement;
            // this innocent SELECT is not proof of the statement that acquired its lock.
            q: "SELECT id, confidence, expires_at, created_at, updated_at FROM harness_shared.agent_facts WHERE workspace_id = $1 AND scope = $2 AND coalesce(scope_ref, '') = $3",
            unblocked: true,
          },
          { pid: 1671608, age_s: 80, q: 'LOCK TABLE harness_shared.harness_features', unblocked: false },
        ];
        const tx = {
          unsafe: async (sql: string) => {
            diagnosticSql = sql;
            return rows;
          },
        };
        return cb(tx);
      },
    } as never;
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('55P03');
      },
      { client },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).blockerHint).toContain('pid 1644480');
    expect((err as OrgTxnTimeoutError).blockerHint).toContain('current/last statement');
    expect((err as OrgTxnTimeoutError).blockerHint).toContain(
      'lock may have been taken by an earlier statement in this transaction',
    );
    expect((err as OrgTxnTimeoutError).blockerHint).toContain('SELECT id, confidence');
    expect((err as OrgTxnTimeoutError).message).toContain('likely blocked by pid 1644480');
    expect((err as OrgTxnTimeoutError).message).toContain('1 other backend(s) also waiting');
    expect(diagnosticSql).toContain('a.datname = current_database()');
    expect(diagnosticSql).toContain('b.datname = current_database()');
  });

  it('leaves blockerHint undefined (and the base message unchanged) when the diagnostic query itself fails', async () => {
    // fakeClient() has no `.unsafe` at all — the diagnostic's tx.unsafe(...) throws,
    // which describeContentionAtFailure must swallow rather than letting it mask
    // (or replace) the real OrgTxnTimeoutError.
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('55P03');
      },
      { client: fakeClient() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).blockerHint).toBeUndefined();
    expect((err as OrgTxnTimeoutError).message).toBe(
      'operator write timed out waiting for a row/advisory lock (pg 55P03 lock_timeout) — retry shortly',
    );
  });

  it('describes a read-only statement timeout as a query timeout', async () => {
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('57014');
      },
      { client: fakeClient(), readOnly: true },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).message).toContain('operator read query exceeded its time budget');
  });

  it('bounds fresh-connection acquisition for blocker diagnosis after a contention timeout', async () => {
    let calls = 0;
    const client = {
      begin: async (cb: (tx: unknown) => Promise<unknown>) => {
        calls++;
        if (calls === 1) {
          return cb((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([] as unknown[]));
        }
        // A saturated pool can leave the diagnostic's fresh connection queued
        // indefinitely. The diagnosis must time out locally and preserve the
        // original typed contention result instead of hanging the MCP call.
        return new Promise<never>(() => {});
      },
    } as never;

    const startedAt = Date.now();
    const err = await boundedOrgTxn(
      async () => {
        throw pgError('55P03');
      },
      { client },
    ).catch((e) => e);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(OrgTxnTimeoutError);
    expect((err as OrgTxnTimeoutError).pgCode).toBe('55P03');
    expect((err as OrgTxnTimeoutError).blockerHint).toBeUndefined();
  });
});
