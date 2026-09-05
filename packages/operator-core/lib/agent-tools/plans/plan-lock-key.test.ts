import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
  type SnapshotRow = {
    pid: number | string;
    application_name: string | null;
    state: string | null;
    query_start: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
  };

  const state: {
    rows: SnapshotRow[];
    calls: Array<{ text: string; values: unknown[] }>;
    fail: boolean;
  } = { rows: [], calls: [], fail: false };

  const end = vi.fn(async () => {});
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    state.calls.push({
      text: strings.raw.join(' ? ').replace(/\s+/g, ' ').trim(),
      values,
    });
    return state.fail
      ? Promise.reject(new Error('snapshot query unavailable'))
      : Promise.resolve(state.rows);
  });
  const client = { sql: Object.assign(sql, { end }) };

  return {
    state,
    end,
    createDedicatedOrgPg: vi.fn(() => client),
    withDbCallDeadline: vi.fn((promise: Promise<unknown>) => promise),
  };
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  createDedicatedOrgPg: dbMocks.createDedicatedOrgPg,
  withDbCallDeadline: dbMocks.withDbCallDeadline,
}));

import {
  PLAN_ADVISORY_LOCK_BUDGET_MS,
  PLAN_ADVISORY_LOCK_NAMESPACE,
  PLAN_LOCK_TIMEOUT_CODE,
  acquirePlanAdvisoryLock,
  planAdvisoryLockKey,
  readPlanAdvisoryLockSnapshot,
} from './plan-lock-key';

interface Statement {
  text: string;
  values: unknown[];
}

/**
 * A tagged-SQL shim that records what was actually sent. `throwOn` makes one statement fail the
 * way PostgreSQL fails a `lock_timeout` — an ERROR carrying 55P03, which aborts the transaction.
 */
function recordingSql(throwOn?: { match: string; code: string }) {
  const statements: Statement[] = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join(' ? ').replace(/\s+/g, ' ').trim();
    statements.push({ text, values });
    if (throwOn && text.includes(throwOn.match)) {
      return Promise.reject(Object.assign(new Error('canceled on lock timeout'), {
        code: throwOn.code,
      }));
    }
    return Promise.resolve([] as unknown[]);
  };
  return { sql: sql as never, statements };
}

describe('acquirePlanAdvisoryLock (WI-2143102)', () => {
  it('JOINS the wait queue — it must never use the non-blocking try acquire', async () => {
    const { sql, statements } = recordingSql();
    await acquirePlanAdvisoryLock(sql, planAdvisoryLockKey('ws', 'harness', 'a-plan'));

    const acquire = statements.find((s) => s.text.includes('advisory_xact_lock'));
    expect(acquire).toBeDefined();
    // The whole defect in one assertion. `pg_try_advisory_xact_lock` does not enter the lock's
    // wait queue, and PG hands a released lock straight to the head of that queue at the holder's
    // COMMIT — so a `try` acquire cannot win while any blocking waiter is queued, however long it
    // keeps retrying. Both writers of this key must queue, or the poller starves by construction.
    expect(acquire!.text).not.toContain('pg_try_advisory_xact_lock');
    expect(acquire!.text).toContain('pg_advisory_xact_lock');
    expect(acquire!.values).toContain(PLAN_ADVISORY_LOCK_NAMESPACE);
    expect(acquire!.values).toContain('ws:harness:a-plan');
  });

  it('bounds the wait, so a waiter can never pin a pooled connection indefinitely', async () => {
    const { sql, statements } = recordingSql();
    await acquirePlanAdvisoryLock(sql, 'ws:harness:a-plan', 1234);

    const cap = statements[0];
    expect(cap.text).toContain("set_config('lock_timeout'");
    // The budget is the only interpolated value; the setting name and the is_local flag are
    // literals, so assert each where it actually lives rather than where it reads nicely.
    expect(cap.values).toContain('1234');
    // That trailing `, true` is set_config's is_local: the cap dies with the transaction and
    // cannot leak onto the pooled connection a later, unrelated caller will be handed.
    expect(cap.text).toContain(', true)');
    expect(statements.indexOf(cap)).toBeLessThan(
      statements.findIndex((s) => s.text.includes('pg_advisory_xact_lock')),
    );
  });

  it('caps the ACQUISITION only — the wait is un-capped again once the lock is held', async () => {
    const { sql, statements } = recordingSql();
    await acquirePlanAdvisoryLock(sql, 'ws:harness:a-plan');

    // These transactions carried no lock_timeout at all before this change. Leaving the
    // acquisition cap in force for the rest of them would be a second, unrelated behaviour change
    // riding along with this one.
    const last = statements[statements.length - 1];
    expect(last.text).toContain("set_config('lock_timeout', '0', true)");
    expect(statements.findIndex((s) => s.text.includes('pg_advisory_xact_lock'))).toBeLessThan(
      statements.length - 1,
    );
  });

  it('defaults to the shared 5s budget', async () => {
    const { sql, statements } = recordingSql();
    await acquirePlanAdvisoryLock(sql, 'ws:harness:a-plan');
    expect(statements[0].values).toContain(String(PLAN_ADVISORY_LOCK_BUDGET_MS));
  });

  it('propagates the lock_timeout instead of swallowing it', async () => {
    const { sql, statements } = recordingSql({
      match: 'pg_advisory_xact_lock',
      code: PLAN_LOCK_TIMEOUT_CODE,
    });

    // Deliberately not swallowed: a lock_timeout ABORTS the transaction, so no further statement
    // could run inside it. The caller catches it OUTSIDE the transaction — withPlanLock's
    // `.catch` on the withWorkspace promise turns exactly this code into its `busy` result.
    await expect(acquirePlanAdvisoryLock(sql, 'ws:harness:a-plan')).rejects.toMatchObject({
      code: PLAN_LOCK_TIMEOUT_CODE,
    });
    // And it must not try to keep talking to an aborted transaction.
    expect(statements.filter((s) => s.text.includes('set_config'))).toHaveLength(1);
  });
});

describe('readPlanAdvisoryLockSnapshot (EI-22341502784159350)', () => {
  beforeEach(() => {
    dbMocks.state.rows = [];
    dbMocks.state.calls.length = 0;
    dbMocks.state.fail = false;
    dbMocks.createDedicatedOrgPg.mockClear();
    dbMocks.withDbCallDeadline.mockClear();
    dbMocks.end.mockClear();
  });

  it('reads granted holders through a fresh bounded client and normalizes backend metadata', async () => {
    dbMocks.state.rows = [
      {
        pid: '42',
        application_name: 'papercusp-staging',
        state: 'active',
        query_start: '2026-09-04 20:00:00+00',
        wait_event_type: null,
        wait_event: null,
      },
      {
        pid: 'not-a-pid',
        application_name: 'discard-me',
        state: 'idle',
        query_start: null,
        wait_event_type: 'Client',
        wait_event: 'ClientRead',
      },
    ];

    const result = await readPlanAdvisoryLockSnapshot('ws:harness:a-plan', 17.9);

    expect(result).toMatchObject({
      lock_key: 'ws:harness:a-plan',
      holders: [
        {
          pid: 42,
          application_name: 'papercusp-staging',
          state: 'active',
          query_start: '2026-09-04 20:00:00+00',
          wait_event_type: null,
          wait_event: null,
        },
      ],
    });
    expect(Number.isNaN(Date.parse(result!.captured_at))).toBe(false);
    expect(dbMocks.createDedicatedOrgPg).toHaveBeenCalledWith('plan-lock-snapshot', { max: 1 });
    expect(dbMocks.withDbCallDeadline).toHaveBeenCalledWith(expect.anything(), {
      ms: 17,
      label: 'plans:advisory-lock-snapshot',
    });
    expect(dbMocks.state.calls[0]?.text).toContain('pg_locks');
    expect(dbMocks.state.calls[0]?.text).toContain('pg_stat_activity');
    expect(dbMocks.state.calls[0]?.text).toContain('l.objsubid = 2');
    expect(dbMocks.state.calls[0]?.text).toContain('l.database');
    expect(dbMocks.state.calls[0]?.values).toEqual([
      PLAN_ADVISORY_LOCK_NAMESPACE,
      'ws:harness:a-plan',
    ]);
    expect(dbMocks.end).toHaveBeenCalledWith({ timeout: 1 });
  });

  it('returns null when post-rollback diagnostics fail and still closes the disposable client', async () => {
    dbMocks.state.fail = true;

    await expect(readPlanAdvisoryLockSnapshot('ws:harness:a-plan')).resolves.toBeNull();

    expect(dbMocks.end).toHaveBeenCalledWith({ timeout: 1 });
  });
});

/**
 * The recurrence guard for the CLASS, not just the instance: two acquisition disciplines on ONE
 * lock key. Fixing the two call sites is worth little if the next writer of `harness_plans`
 * hand-rolls a third acquire — which is exactly how these two drifted apart.
 */
describe('every plan-lock writer goes through the one shared acquire (WI-2143102)', () => {
  // Scan CODE, not prose. Both call sites now carry comments that NAME the two banned forms in
  // order to explain why they are banned — a whole-file scan would flag its own explanation, which
  // is how this kind of guard ends up "fixed" by deleting the comment that made it legible.
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  for (const file of ['with-plan-lock.ts', 'plan-dependency-admission-transaction.ts']) {
    it(`${file} takes the plan lock only via acquirePlanAdvisoryLock`, () => {
      const text = source(file);
      expect(text).toContain('acquirePlanAdvisoryLock');
      // Neither raw form may reappear at a call site. A `pg_try_…` here re-opens the starvation;
      // a bare `pg_advisory_xact_lock` here re-opens the unbounded wait that pinned the pool.
      expect(text).not.toContain('pg_try_advisory_xact_lock');
      expect(text).not.toMatch(/SELECT\s+pg_advisory_xact_lock/);
    });
  }

  // A guard that cannot fail is not a guard — and one whose comment-stripping is too greedy
  // passes on everything. Run the SAME strip over synthetic sources so both directions are shown:
  // a regression in CODE is still caught, and the identical text in a COMMENT is ignored.
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('is falsifiable: catches both banned acquires in code, and ignores them in comments', () => {
    const tryInCode = 'await tx`SELECT pg_try_advisory_xact_lock(hashtext(a), hashtext(b)) AS ok`;';
    const unboundedInCode = 'await tx`SELECT pg_advisory_xact_lock(hashtext(a), hashtext(b))`;';
    expect(strip(tryInCode)).toContain('pg_try_advisory_xact_lock');
    expect(strip(unboundedInCode)).toMatch(/SELECT\s+pg_advisory_xact_lock/);

    expect(strip('// this used to call pg_try_advisory_xact_lock in a poll loop')).not.toContain(
      'pg_try_advisory_xact_lock',
    );
    expect(strip('/* it ran SELECT pg_advisory_xact_lock unbounded */')).not.toMatch(
      /SELECT\s+pg_advisory_xact_lock/,
    );

    // Calibration: the strip must not eat ordinary code, or every assertion above passes vacuously.
    expect(strip(unboundedInCode).trim()).not.toHaveLength(0);
    // …and the call sites really do carry the shared acquire, so the guard is checking live code.
    expect(source('with-plan-lock.ts')).toMatch(/acquirePlanAdvisoryLock\(tx, lockKey/);
  });
});
