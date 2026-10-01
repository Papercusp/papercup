/**
 * A graceful host restart must not spend a DBOS workflow's recovery budget (WI-10004954).
 *
 * THE MECHANISM (DBOS SDK 4.27.x, pinned by graceful-shutdown-recovery-credit.test.ts):
 *   - Every time a queued workflow is DEQUEUED, the claim flip ENQUEUED→PENDING runs
 *     `recovery_attempts = recovery_attempts + 1` (system_database.js).
 *   - On boot, `recoverPendingWorkflows` re-enqueues every PENDING workflow the executor
 *     owned (`reenqueueWorkflowsForRecovery`), so the next dequeue charges it again.
 *   - The claim refuses a workflow once `claimedAttempts > maxRecoveryAttempts + 1`
 *     (dbos-executor.js) and marks it MAX_RECOVERY_ATTEMPTS_EXCEEDED.
 * So EVERY bg-host restart (a deploy, a dev:restart, a peer reloading its fix) costs each
 * in-flight workflow one attempt. routineFire registers `maxRecoveryAttempts: 5`, so the
 * 24h P-005 bulk-dedup fire dead-lettered at 7 dequeues on 2026-10-01 after a day of
 * routine restarts. Its successor reached 3 dequeues in its first 23 minutes.
 *
 * WHAT maxRecoveryAttempts IS FOR: stopping a POISON workflow (one that takes its process
 * down) from crash-looping the host. A graceful SIGTERM is not that. So on a graceful
 * shutdown the executor gives each of its in-flight workflows back the attempt that the
 * next dequeue will charge. Crashes, OOM kills, SIGKILL, and an event loop too blocked to
 * run this handler still count, so poison protection is unchanged.
 *
 * BOUND: only workflows with an explicit DBOS deadline are credited, so a workflow that
 * somehow keeps provoking graceful restarts still ends at its own deadline. routineFire
 * always has one (`routineFireTimeoutMs`).
 *
 * FAIL-SAFE: every failure path (no executor id, PG error, the statement timeout, the
 * process dying first) leaves the attempt counted, which is the pre-fix behaviour.
 */
import type { Sql } from 'postgres';

/** Must finish well inside the cluster primary's 2s SIGKILL after SIGTERM (hono-host.ts). */
export const GRACEFUL_RECOVERY_CREDIT_STATEMENT_TIMEOUT_MS = 1_000;

/** How long a sole SIGTERM listener waits for the credit before restoring default exit. */
export const GRACEFUL_RECOVERY_CREDIT_SOLE_LISTENER_EXIT_MS = 1_500;

type CreditSql = Pick<Sql, 'begin'>;

/**
 * Give one recovery attempt back to every PENDING, deadline-bounded workflow owned by
 * `executorId`. Returns the ids credited. Never drops below zero.
 */
export async function creditGracefulShutdownRecoveryAttempts(
  sql: CreditSql,
  executorId: string,
): Promise<string[]> {
  if (!executorId) return [];
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL statement_timeout = ${GRACEFUL_RECOVERY_CREDIT_STATEMENT_TIMEOUT_MS}`,
    );
    return tx<{ workflow_uuid: string }[]>`
      UPDATE dbos.workflow_status
         SET recovery_attempts = recovery_attempts - 1
       WHERE executor_id = ${executorId}
         AND status = 'PENDING'
         AND recovery_attempts > 0
         AND workflow_deadline_epoch_ms IS NOT NULL
      RETURNING workflow_uuid`;
  });
  return (rows as unknown as { workflow_uuid: string }[]).map((r) => r.workflow_uuid);
}

type SignalProcess = Pick<NodeJS.Process, 'once' | 'removeListener' | 'listenerCount' | 'kill' | 'pid'>;

export interface ArmGracefulRecoveryCreditOptions {
  sql: CreditSql;
  executorId: string;
  /** Injectable for tests; defaults to the real process. */
  proc?: SignalProcess;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Arm the credit on SIGTERM/SIGINT for the process that runs DBOS. Returns a disarm
 * function. Fires at most once.
 *
 * Adding a SIGTERM listener suppresses Node's default exit-on-signal. Every production
 * DBOS host already owns its shutdown (hono-host.ts / installGracefulShutdown), but if
 * this turns out to be the ONLY listener for the signal, it re-raises the signal after
 * the credit settles (or a bounded wait) so the process still terminates as before.
 */
export function armGracefulShutdownRecoveryCredit(opts: ArmGracefulRecoveryCreditOptions): () => void {
  const proc: SignalProcess = opts.proc ?? process;
  const log = opts.log ?? ((line: string) => console.log(line));
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  let fired = false;

  const handlers: Record<'SIGTERM' | 'SIGINT', () => void> = {
    SIGTERM: () => onSignal('SIGTERM'),
    SIGINT: () => onSignal('SIGINT'),
  };

  const disarm = (): void => {
    proc.removeListener('SIGTERM', handlers.SIGTERM);
    proc.removeListener('SIGINT', handlers.SIGINT);
  };

  function onSignal(sig: 'SIGTERM' | 'SIGINT'): void {
    // `once` already removed THIS signal's handler, so a count of 0 means nobody
    // else will terminate the process for this signal.
    const soleListener = proc.listenerCount(sig) === 0;
    disarm();
    if (fired) return;
    fired = true;
    const credit = creditGracefulShutdownRecoveryAttempts(opts.sql, opts.executorId).then(
      (ids) => {
        log(
          `[dbos-graceful-credit] ${sig}: credited ${ids.length} in-flight workflow(s) on ` +
            `executor ${opts.executorId}${ids.length > 0 ? `: ${ids.slice(0, 10).join(', ')}` : ''}`,
        );
      },
      (e: unknown) => {
        warn(
          `[dbos-graceful-credit] ${sig}: credit failed, this restart counts as a recovery ` +
            `attempt: ${e instanceof Error ? e.message : String(e)}`,
        );
      },
    );
    if (soleListener) {
      const reraise = (): void => {
        proc.kill(proc.pid, sig);
      };
      const timer = setTimeout(reraise, GRACEFUL_RECOVERY_CREDIT_SOLE_LISTENER_EXIT_MS);
      timer.unref?.();
      void credit.finally(() => {
        clearTimeout(timer);
        reraise();
      });
    }
  }

  proc.once('SIGTERM', handlers.SIGTERM);
  proc.once('SIGINT', handlers.SIGINT);
  return disarm;
}
