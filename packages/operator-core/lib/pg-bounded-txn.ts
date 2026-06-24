/**
 * pg-bounded-txn — a bounded, atomic WRITE transaction on the operator admin pool.
 *
 * WHY (reliability): getOrgPg() (the `harness_admin` pool) carries a role-default
 * `lock_timeout` (15s) + `idle_in_transaction_session_timeout` (60s) but DELIBERATELY
 * NO `statement_timeout` — migrations + long maintenance tooling run on this same
 * pool and must be allowed to run unbounded. The cost of that omission: an
 * INTERACTIVE write tool that runs raw queries on this pool (e.g. work_items:comment
 * → commentIssue → getOrCreateThread/addPost) has NO per-statement bound. A query
 * that stalls for any NON-lock reason — a CPU-starved backend, a slow scan, a buffer
 * wait — runs UNBOUNDED and HANGS the MCP call until the client transport gives up.
 *
 * Crucially, a JS-level watchdog cannot rescue it: postgres-js does NOT cancel an
 * in-flight query when an AbortController fires, so the route-stack 30s abort only
 * yields a 408 once the handler finally returns. The ONLY thing that actually
 * unblocks a wedged query is a DB-side statement_timeout. (Root cause of the
 * reported "work_items:comment hung, then timed out on a bounded retry.")
 *
 * boundedOrgTxn wraps a unit of admin-pool writes in ONE transaction with a
 * SET LOCAL statement_timeout + lock_timeout, so the work is:
 *   - ATOMIC  — partial writes can't half-land and a post-stall retry can't
 *               duplicate (every statement commits together or not at all); and
 *   - BOUNDED — a stall surfaces as a fast, typed OrgTxnTimeoutError (mapped from
 *               PG 57014 statement_timeout / 55P03 lock_timeout) that the caller
 *               turns into a clean { ok:false, error } result (runBulk does this
 *               for the bulk tools), instead of an indefinite hang.
 *
 * It is the interactive-WRITE counterpart to pg-read-query's bounded READ ONLY txn,
 * and a deliberately lighter sibling of locks/inWorkspaceTxn: NO per-workspace
 * advisory lock (a coordination append must not serialize the entire workspace).
 * Migrations + long tooling keep calling getOrgPg() directly and stay unbounded.
 */

import { getOrgPg } from '@papercusp/db-org';

/** The postgres-js client type the org handle exposes (same alias pg-read-query uses). */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Thrown when a bounded admin-pool txn can't finish in time: a statement exceeds
 * `statement_timeout` (PG `57014`) or a lock wait exceeds `lock_timeout` (PG `55P03`).
 * Callers map this to a structured busy result instead of leaking a raw postgres
 * error. The originating PG error is preserved on `.cause` / `.pgCode`.
 */
export class OrgTxnTimeoutError extends Error {
  readonly pgCode: string;
  constructor(pgCode: string, cause: unknown) {
    super(
      pgCode === '55P03'
        ? 'operator write timed out waiting for a row/advisory lock (pg 55P03 lock_timeout) — retry shortly'
        : 'operator write exceeded its time budget (pg 57014 statement_timeout) — the database stalled; retry shortly',
    );
    this.name = 'OrgTxnTimeoutError';
    this.pgCode = pgCode;
    this.cause = cause;
  }
}

/** PG SQLSTATEs that mean "couldn't finish in time": statement_timeout + lock_timeout. */
const CONTENTION_CODES = new Set(['57014', '55P03']);

/** Per-statement cap for an interactive coordination write. Generous enough that a
 *  healthy sub-second write NEVER trips it, tight enough that a wedged query dies
 *  well under the route-stack 30s budget (so the agent gets a typed error, not a
 *  408). Override via PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS. */
export const ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS) || 15_000,
);
/** Per-lock-wait cap. Override via PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS. */
export const ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS) || 8_000,
);

export interface BoundedOrgTxnOptions {
  /** Per-statement cap (PG statement_timeout), ms. Default ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
  /** Per-lock-wait cap (PG lock_timeout), ms. Default ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS. */
  lockTimeoutMs?: number;
  /** Inject the sql client (tests / a non-default backend). Default getOrgPg().sql. */
  client?: OrgSql;
}

/**
 * Run `fn` inside ONE bounded admin-pool transaction. `fn` receives the
 * transaction-scoped sql handle — every query it runs is in the same txn and
 * under the SET LOCAL timeouts. A contention timeout (PG 57014 / 55P03) is mapped
 * to OrgTxnTimeoutError; any other error propagates unchanged (and rolls the txn
 * back).
 *
 * The `tx` is typed as OrgSql so store helpers that take a single `Sql` can be
 * constructed against it (e.g. `new PgThreadStore({ ...opts, getSql: () => tx })`).
 */
export async function boundedOrgTxn<T>(
  fn: (tx: OrgSql) => Promise<T>,
  opts: BoundedOrgTxnOptions = {},
): Promise<T> {
  const sql = opts.client ?? getOrgPg().sql;
  const stmtMs = Math.max(100, Math.trunc(opts.statementTimeoutMs ?? ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS));
  const lockMs = Math.max(100, Math.trunc(opts.lockTimeoutMs ?? ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS));
  let result: unknown;
  try {
    result = await sql.begin(async (tx) => {
      // set_config(name, value, is_local=true) == SET LOCAL, but binds the value
      // as a parameter (a bare `SET` cannot). Mirrors locks/inWorkspaceTxn.
      await tx`SELECT set_config('lock_timeout', ${`${lockMs}ms`}, true)`;
      await tx`SELECT set_config('statement_timeout', ${`${stmtMs}ms`}, true)`;
      return fn(tx as unknown as OrgSql);
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === 'string' && CONTENTION_CODES.has(code)) {
      throw new OrgTxnTimeoutError(code, err);
    }
    throw err;
  }
  return result as T;
}
