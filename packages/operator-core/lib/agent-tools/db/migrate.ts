/**
 * db:migrate — the blessed path to apply a schema migration, coordinated (P-027).
 *
 * Acquires exclusive(db-schema) with a drain so in-flight schema-dependent
 * work finishes before destructive DDL runs, then applies the migration,
 * then releases. Use this instead of a raw `psql -f` so peers are coordinated.
 *
 * Safe by default: no `confirm` → DRY RUN (no lock, no psql). With confirm it
 * acquires + drains, and applies the file ONLY if PAPERCUSP_ALLOW_DB_MIGRATE=1.
 */

import { z } from 'zod';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { resolveDeployedReleaseRoot, verifyPendingCodeDeployMigration } from '../../migration-deploy-guard';
// Local bindings for this module's own use — the `export { … } from` below
// re-exports the same names for existing importers but creates no local binding.
import { isRetryableLockFailure, lockRetryBackoffMs } from '../../pg-retryable-failure';
import { openEscalation } from '../coordination/escalations';
import {
  checkResourceAction,
  recordResourceAction,
  getTxPool,
  type ResourceHolder,
} from '../locks/su-lock-store';

const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 60;

// EI-9417: harness_shared.coord_presence / coord_event_log / work_items are
// extremely hot (every agent heartbeat/declare-intent writes them), so even a
// metadata-only ALTER TABLE (constant default, PG 11+ — trivial hold time once
// granted) genuinely queues behind live write traffic and can hit a lock
// timeout — not a bug in the migration, just contention. Rather than every
// agent hand-rolling a "check pg_locks, retry BEGIN/SET lock_timeout/ALTER/
// COMMIT" loop from scratch (WI-1546), db:migrate now applies a hard
// lock_timeout (fail FAST instead of hanging indefinitely — no lock_timeout
// was set before this fix) and retries with backoff automatically, but ONLY
// for the retryable transaction-contention failure classes — lock timeout,
// deadlock, and serialization failure (EI-18747087108453188: a deadlock is
// if anything the MORE retryable of the two, since Postgres has already
// broken the cycle by killing one side of it, and it is also the MORE
// LIKELY failure here — a migration touching harness_shared.work_items also
// touches its two dependent views, and a reader locking view-then-base
// against `ALTER TABLE …; CREATE OR REPLACE VIEW …` locking base-then-view
// is a guaranteed lock-order inversion against ordinary fleet read traffic);
// any other psql error (syntax, constraint, …) fails immediately, unretried.
const DEFAULT_LOCK_TIMEOUT_SEC = 10;
const LOCK_RETRY_MAX_ATTEMPTS = 5;
// WI-6381: EI-9417's 5×10s retry (worst case ~80s incl. backoff) assumes the
// blocker is ordinary hot-table CONTENTION — another agent's brief write —
// which clears in seconds. It cannot ride out a genuinely long-lived
// NON-OPERATOR holder: confirmed live via pg_locks, the host's pg_dump-based
// backup (packages/backup + ~/.config/kopia/db-backup.sh, EI-10733) dumps the
// whole cluster with no per-table exclusions, and while it works through a
// large table (e.g. harness_shared.session_archive_files, which stores
// zstd-compressed session transcripts and can run for MULTIPLE MINUTES — one
// observed instance held its lock 9m34s) it keeps holding AccessShareLock on
// every table it already touched earlier in the SAME dump transaction,
// including small hot ones like agent_facts. No amount of short retries beats
// that — the fix is to let ONE (or two) attempts actually WAIT it out, via a
// caller-opted-in wider lock_timeout, mirroring the sanctioned manual
// workaround (`SET LOCAL lock_timeout = '180s'`) db:migrate's own withheld
// branch already documents. `lock_timeout_sec` below is that lever; when a
// caller opts in, MAX attempts drops to 2 — the whole point of a long
// per-attempt wait is to absorb the contention in ONE try, not to multiply a
// multi-minute timeout by 5 attempts and blow far past this tool's own budget.
const MAX_LOCK_TIMEOUT_SQL_SEC = 300; // ceiling — mirrors MAX_DRAIN_SEC's magnitude
const CUSTOM_LOCK_TIMEOUT_MAX_ATTEMPTS = 2;

// EI-19320461261471579: these predicates + the backoff now live in the
// dependency-free `lib/pg-retryable-failure` module and are RE-EXPORTED here,
// unchanged, so every existing importer and test keeps working. They moved
// because db:migrate is only ONE of the two paths that apply migrations — the
// other is db-boot-migrate (operator boot AND the green-checkpoint gate's
// migration preflight), which could not import them from this file: migrate.ts
// pulls in @papercusp/agent-mcp, the lock store and the escalation surface,
// far too heavy for a boot path. Copying the regexes into that second site
// would have re-created the very drift this fixes — the deadlock retry landed
// here and never reached the gate, so a deadlocked migration aborted the run
// as INCONCLUSIVE and held main for the whole fleet.
export {
  isLockTimeoutFailure,
  isDeadlockFailure,
  isSerializationFailure,
  isRetryableLockFailure,
  lockRetryBackoffMs,
} from '../../pg-retryable-failure';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// EI-18159491440495603: guardResource's underlying su-lock-store pool (postgres-js,
// routed through the box's PgBouncer at :6432) occasionally drops a connection
// mid-write on this heavily-parallel dev box — pgbouncer.log shows periodic
// "pooler error: server conn crashed?" warnings independent of any code bug here.
// postgres-js surfaces that as a plain Error with `.code` one of its own connection-
// layer codes (CONNECTION_CLOSED / CONNECTION_DESTROYED / CONNECT_TIMEOUT — see
// node_modules/postgres/src/errors.js's `connection()` factory), NOT a PostgresError
// (a real SQL/logic failure). Previously this propagated as an UNCAUGHT throw out of
// the handler (MCP error -32603: "write CONNECTION_CLOSED 127.0.0.1:6432"), forcing
// every caller to fall back to a raw hand-rolled psql apply. Mirrors the EI-9417
// lock-timeout retry below: same shape, a DIFFERENT (connection-layer, not
// contention-layer) transient failure class — never retries a genuine SQL/logic
// error, which throws a PostgresError with no such `.code`.
const CONNECTION_RETRY_MAX_ATTEMPTS = 3;
const CONNECTION_RETRY_BASE_DELAY_MS = 1000;
const CONNECTION_RETRY_MAX_DELAY_MS = 8000;
const TRANSIENT_CONNECTION_ERROR_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/** True iff `err` is one of postgres-js's own transient connection-layer errors
 *  (see TRANSIENT_CONNECTION_ERROR_CODES above) rather than a real SQL/logic
 *  failure — the ONLY class the retry wrapper below targets. Exported + pure
 *  for unit testing. */
export function isTransientConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_CONNECTION_ERROR_CODES.has(code);
}

/** Exponential backoff (1s, 2s, 4s, capped at 8s) for attempt N (1-based) —
 *  gives a dropped pgbouncer/PG connection a window to recover between
 *  attempts. Pure + unit tested. */
export function connectionRetryBackoffMs(attempt: number): number {
  return Math.min(CONNECTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), CONNECTION_RETRY_MAX_DELAY_MS);
}

// WI-6002: a failed psql apply is NOT necessarily a failed migration. The
// migration script wraps its DDL and the harness_shared.schema_migrations
// ledger INSERT in ONE transaction — so the specific case where the script
// fails on that INSERT's unique-constraint (filename already recorded) means
// an EARLIER attempt already committed the whole thing (e.g. one whose
// success response was lost to the exact connection-layer blip
// isTransientConnectionFailure retries above, which triggers a full re-run
// via withConnectionRetry — see EI-18159491440495603). Reporting `ok:false`
// in that case is a FALSE FAILURE that invites a destructive retry of an
// already-applied migration. Verify against the ledger itself — on a FRESH
// psql invocation, independent of whatever connection just dropped — before
// trusting the failed exit code as evidence the migration never landed.
const SCHEMA_MIGRATIONS_DUP_KEY_RE = /schema_migrations_pkey/i;

/** True iff `stderr` looks like the schema_migrations ledger's own
 *  duplicate-key guard (filename already recorded) rather than a genuine
 *  DDL/logic failure. Exported + pure for unit testing. */
export function isDuplicateMigrationLedgerFailure(stderr: string): boolean {
  return SCHEMA_MIGRATIONS_DUP_KEY_RE.test(stderr);
}

/** Query harness_shared.schema_migrations directly (a fresh psql
 *  invocation — NOT the pool that may have just dropped) for whether
 *  `filename` is already recorded as applied. Never throws: an unreadable
 *  result (psql itself fails, e.g. box is genuinely down) returns false
 *  rather than falsely claiming already-applied. `spawn` is injectable for
 *  tests, matching runMigrationWithLockRetry's own pattern. */
function checkSchemaMigrationsRecorded(
  url: string,
  filename: string,
  spawn: (cmd: string, args: string[], opts: { encoding: 'utf8' }) => SpawnResult = spawnSync,
): boolean {
  const escaped = filename.replace(/'/g, "''");
  const query = `SELECT 1 FROM harness_shared.schema_migrations WHERE filename = '${escaped}' LIMIT 1;`;
  const r = spawn('psql', [url, '-tAc', query], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '1';
}

/** Run `fn` (a guardResource(...) call), retrying ONLY on a transient
 *  connection-layer throw, up to `maxAttempts`, with backoff between
 *  attempts. A non-transient error (including a genuine SQL/logic failure)
 *  rethrows immediately, unretried — same contract as runMigrationWithLockRetry
 *  above, at the connection layer instead of the lock-contention layer. */
async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = CONNECTION_RETRY_MAX_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientConnectionFailure(err)) throw err;
      await sleep(connectionRetryBackoffMs(attempt));
    }
  }
}

type SpawnResult = SpawnSyncReturns<string>;

/** Run the migration script via psql, retrying ONLY on a retryable
 *  transaction-contention failure ({@link isRetryableLockFailure} — lock
 *  timeout, deadlock, or serialization failure), up to `maxAttempts`, with
 *  {@link lockRetryBackoffMs} backoff between attempts. `spawn` is injectable
 *  for tests. */
async function runMigrationWithLockRetry(
  url: string,
  script: string,
  spawn: (cmd: string, args: string[], opts: { input: string; encoding: 'utf8' }) => SpawnResult = spawnSync,
  maxAttempts = LOCK_RETRY_MAX_ATTEMPTS,
  // EI-18769559897594065: fired once per attempt (including the first) so a
  // caller can surface retry progress instead of the whole multi-attempt,
  // backoff-retried apply going silent — see db:migrate's emitProgress wiring.
  onAttempt?: (attempt: number, maxAttempts: number) => void,
): Promise<{ result: SpawnResult; attempts: number }> {
  let result: SpawnResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt?.(attempt, maxAttempts);
    result = spawn('psql', [url, '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8' });
    if (result.status === 0) return { result, attempts: attempt };
    if (attempt >= maxAttempts || !isRetryableLockFailure(result.stderr ?? '')) return { result, attempts: attempt };
    await sleep(lockRetryBackoffMs(attempt));
  }
  // Unreachable — the loop above always returns by its last iteration — but
  // keeps TS's control-flow analysis happy without a non-null assertion.
  return { result: result!, attempts: maxAttempts };
}

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

export default defineTool({
  name: 'db:migrate',
  description:
    'Apply a SQL migration file, coordinated. DRY RUN unless confirm:true; with confirm, acquires exclusive(db-schema), drains, then applies. Real apply also needs host-only PAPERCUSP_ALLOW_DB_MIGRATE=1; when withheld you still get back the exact psql + schema_migrations INSERT to run by hand. Prefer this over a raw psql -f.',
  guidance: {
    when: 'Applying a migration / destructive DDL that could disrupt in-flight queries. Dry-run to see holders; confirm to drain + apply.',
    notWhen: 'Read-only SQL needs no lock. Never apply migrations casually on a shared box.',
    chaining:
      'db:migrate { file } (dry) → review → db:migrate { file, confirm: true }. ' +
      'EI-6955: `file` is any absolute path — pass a migration you JUST wrote in STAGING (db:check_drift reads the ' +
      'release checkout). EI-13299: no shell/PG access (a cup) + urgent + deploy gate red? re-call with ' +
      'escalate:true to open a blocker coord:escalate carrying that ready-to-run command; omit it for routine ' +
      'attempts (no spam). Emits ctx.progress during drain/apply; a client-side timeout does NOT stop the server ' +
      'call — verify schema_migrations before retrying, never assume failure. WI-6381: repeated ' +
      'lock_timeout_retries_exhausted:true against an otherwise-idle table? check pg_locks/pg_stat_activity for a ' +
      'long-lived NON-operator holder (the host pg_dump backup can hold AccessShareLock for minutes), then retry ' +
      'with lock_timeout_sec high enough to outlast it rather than looping the default retry.',
    seeAlso: [
      'db:check_drift (verify schema drift first)',
      'db:next-migration (scaffold a new migration)',
      'db:migrate-policy (deploy-migration lock policy)',
    ],
  },
  capability: 'locks:write',
  // EI-9417: + budget for the default lock-timeout retry loop's worst case (5
  // attempts x DEFAULT_LOCK_TIMEOUT_SEC, plus backoff between them — see
  // above). WI-6381: widened to also cover the caller-opted-in long-wait path
  // (CUSTOM_LOCK_TIMEOUT_MAX_ATTEMPTS attempts x MAX_LOCK_TIMEOUT_SQL_SEC),
  // whichever is larger — a real call almost never approaches this; it is
  // only the outer ceiling this tool's MCP transport enforces.
  timeoutSec: MAX_DRAIN_SEC + CUSTOM_LOCK_TIMEOUT_MAX_ATTEMPTS * MAX_LOCK_TIMEOUT_SQL_SEC + 120,
  // EI-18733783500981433: this handler drains (up to MAX_DRAIN_SEC) then shells
  // out to psql — up to several minutes — and never reads ctx.tx. Without this,
  // the host's ambient workspace transaction sits idle for the whole drain+apply
  // and gets killed by Postgres's idle_in_transaction_session_timeout (60s),
  // surfacing to the caller as a bare "write CONNECTION_CLOSED 127.0.0.1:6432"
  // even though the migration itself completed. Confirmed live: 100% of
  // tools:invoke→db:migrate CONNECTION_CLOSED failures in the trailing 12h
  // clustered at ~60-62s duration. Same fix as capability:bash (EI-18666279107998059)
  // — see ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file: z.string().min(1).describe('Absolute path to the .sql migration file to apply.'),
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
    escalate: z
      .boolean()
      .optional()
      .describe(
        'EI-13299: when the real apply is WITHHELD (no PAPERCUSP_ALLOW_DB_MIGRATE), also raise a blocker ' +
          'coord:escalate to a human carrying the exact ready-to-run command — the fast sanctioned path for an ' +
          'urgent, already-committed migration when you have no shell/PG access of your own (a cup) and the ' +
          'normal deploy pipeline is blocked. Default false (a routine withheld confirm stays silent). Repeated ' +
          'escalations for the SAME file coalesce onto one open escalation instead of flooding the inbox.',
      ),
    lock_timeout_sec: z
      .number()
      .int()
      .positive()
      .max(MAX_LOCK_TIMEOUT_SQL_SEC)
      .optional()
      .describe(
        `WI-6381: widen the per-attempt SQL lock_timeout beyond the ${DEFAULT_LOCK_TIMEOUT_SEC}s default ` +
          `(max ${MAX_LOCK_TIMEOUT_SQL_SEC}s) for a migration repeatedly failing with ` +
          'lock_timeout_retries_exhausted:true against a KNOWN long-lived NON-operator holder — confirmed via ' +
          'pg_locks/pg_stat_activity, e.g. the host pg_dump backup process, which can hold AccessShareLock on an ' +
          'otherwise-idle table for several minutes while it dumps a large one elsewhere in the same transaction ' +
          '(the whole DB is dumped with no per-table exclusions). Setting this drops the retry-attempt count to ' +
          `${CUSTOM_LOCK_TIMEOUT_MAX_ATTEMPTS} — a wide per-attempt wait is meant to ride out the contention in ` +
          'ONE try (mirroring the sanctioned manual `SET LOCAL lock_timeout` workaround), not to be multiplied by ' +
          `the default's 5 short attempts. Omit for ordinary hot-table contention (EI-9417's 5×10s default is the ` +
          'right shape there — most lock timeouts clear in seconds).',
      ),
  }),
  async handler(args, ctx) {
    // Validate the file before the dry-run/lock branches and retain the exact
    // bytes for the apply hash. A missing file used to be swallowed here, then
    // read again inside guardResource's callback, where ENOENT escaped as an
    // opaque handler error after the caller had already acquired the schema
    // lock (EI-20208885180481722).
    let sqlText: string;
    try {
      sqlText = readFileSync(args.file, 'utf8');
    } catch (err) {
      return json({
        ok: false,
        applied: false,
        reason: 'migration_file_unreadable',
        file: args.file,
        error: err instanceof Error ? err.message : String(err),
        note: 'The migration file could not be read; no lock was acquired and no SQL was applied.',
      });
    }

    // The boot runner performs the same check through its beforeApply hook.
    // Keep db:migrate fail-closed too: it is the sanctioned manual applier and
    // must not provide a route around the release-before-schema ordering rule.
    try {
      const sqlDir = path.dirname(path.resolve(args.file));
      const guard = verifyPendingCodeDeployMigration({
        filename: path.basename(args.file),
        sqlText,
        releaseRoot: resolveDeployedReleaseRoot(sqlDir),
      });
      if (!guard.ok) {
        return json({
          ok: false,
          applied: false,
          reason: 'pending_code_deploy_not_ready',
          file: args.file,
          note: guard.error,
        });
      }
    } catch {
      // Preserve db:migrate's existing dry-run / psql error behavior for a
      // missing or unreadable path; the deployed-code guard only applies to a
      // file whose body can actually identify itself as parked.
    }
    if (!args.confirm) {
      return json({
        ok: true,
        dry_run: true,
        would_run: `psql <admin-url> -v ON_ERROR_STOP=1 -f ${args.file}`,
        note: 'Pass confirm:true to acquire exclusive(db-schema), drain, then apply. The real apply also requires PAPERCUSP_ALLOW_DB_MIGRATE=1.',
      });
    }

    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabled = process.env.PAPERCUSP_ALLOW_DB_MIGRATE === '1';
    const effectiveMaxDrainSec = args.max_drain_sec ?? DEFAULT_DRAIN_SEC;

    // EI-18769559897594065: capture ctx.progress safely (older shapes / shim
    // callers may not have it — same defensive pattern as locks:acquire's own
    // drain-wait heartbeat). Wired into guardResource's onTick below so a
    // caller sees drain progress instead of total silence, and — because
    // ctx.progress refreshes the transport's own idle-timeout deadline
    // (tooldef D2) — a genuinely-still-draining wait no longer looks
    // indistinguishable from a wedge to an MCP client watching for "response
    // or progress".
    const emitProgress =
      (ctx as { progress?: (pct: number | undefined, msg?: string) => void }).progress ??
      (() => undefined);

    const outcome = await withConnectionRetry(() =>
      guardResource(
        {
          coordinationDomain,
          ownerId,
          ownerLabel,
          coordIdentity,
          resource: 'db-schema',
          mode: 'exclusive',
          maxDrainSec: effectiveMaxDrainSec,
          reason: `apply migration ${args.file}`,
          onTick: ({ waited_sec, holders }) => {
            emitProgress(
              undefined,
              JSON.stringify({
                phase: 'draining',
                elapsed_sec: waited_sec,
                max_drain_sec: effectiveMaxDrainSec,
                remaining_sec: Math.max(0, effectiveMaxDrainSec - waited_sec),
                holders: holders.map(holderJson),
              }),
            );
          },
      },
      async (fence) => {
        if (!enabled) {
          // EI-6879: PAPERCUSP_ALLOW_DB_MIGRATE is a deliberate host-level opt-in
          // (same rail as PAPERCUSP_ALLOW_DEV_RESTART) — an agent cannot set it
          // remotely, so on a dev box without it configured this withheld branch
          // is the ONLY path every migration takes. Every agent that hit this
          // previously had to reverse-engineer the sanctioned fallback (a raw
          // `psql -f` + a same-transaction schema_migrations INSERT, mirroring
          // embedded-postgres-server's migration-runner.js) from scratch — the
          // note below spells it out inline so that rediscovery cost is zero.
          // CAUTION per CLAUDE.md § storage policy: a bare `psql -f` WITHOUT the
          // same-txn INSERT leaves schema_migrations un-recorded, so every future
          // deploy re-runs the file (a lock-contending re-run can trip a
          // deploy's lock_timeout) — always include the INSERT in the same BEGIN/COMMIT.
          const url = getHarnessAdminUrl();
          const readyCommand = `psql "${url}" -v ON_ERROR_STOP=1 <<'SQL'\nBEGIN;\nSET LOCAL statement_timeout = 0;\n\\i ${args.file}\nINSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${path.basename(args.file)}', '<sha256 of the file bytes, e.g. sha256sum ${args.file}>');\nCOMMIT;\nSQL`;
          // EI-13299: escalate:true is the sanctioned fast path when the caller
          // (typically a cup with no shell/PG access at all) has no other way to
          // get an urgent, already-committed migration applied while the deploy
          // gate is red. Fail-soft — a notification hiccup must never turn an
          // otherwise-successful drain+withhold response into an error, mirroring
          // attention-notify.ts's "each channel independently fail-safe" contract.
          let escalation: { escalated: boolean; msg_id?: string; ts?: string; error?: string } = {
            escalated: false,
          };
          if (args.escalate) {
            try {
              const ctxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
              const harnessSlug =
                typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined;
              const rec = await openEscalation(coordIdentity, {
                severity: 'blocker',
                summary: `db:migrate withheld for ${path.basename(args.file)} — ${ownerLabel} needs a human/su to apply it (no PAPERCUSP_ALLOW_DB_MIGRATE, no shell/PG access of their own)`,
                body:
                  `Requester: ${ownerId} (${ownerLabel})\n` +
                  `File: ${args.file}\n` +
                  `exclusive(db-schema) is ALREADY held + drained under this request (safe to apply now).\n\n` +
                  `Ready-to-run command (fill in the sha256 first — sha256sum ${args.file}):\n${readyCommand}\n\n` +
                  `Why this fired: the requester called db:migrate with escalate:true, meaning the normal apply ` +
                  `path (PAPERCUSP_ALLOW_DB_MIGRATE, or the release deploy pipeline's boot-apply) is unavailable ` +
                  `or blocked (e.g. the deploy gate is red) and the migration is urgent.`,
                ...(harnessSlug ? { harness_slug: harnessSlug } : {}),
                meta: {
                  subjectSignature: `db-migrate-withheld:${path.basename(args.file)}`,
                  ...(harnessSlug ? { harnessSlug } : {}),
                },
              });
              escalation = { escalated: true, msg_id: rec.msg_id, ts: rec.ts };
            } catch (e) {
              escalation = { escalated: false, error: e instanceof Error ? e.message : String(e) };
            }
          }
          return json({
            ok: true,
            drained: true,
            applied: false,
            note: 'Drain complete, but apply WITHHELD — set PAPERCUSP_ALLOW_DB_MIGRATE=1 on the operator host to enable the real psql apply.',
            escalation,
            fallback: {
              why: 'PAPERCUSP_ALLOW_DB_MIGRATE is a deliberate owner-authority safety rail (like PAPERCUSP_ALLOW_DEV_RESTART) — it cannot be set by an agent call, only by the host operator process env.',
              caution:
                'You already hold exclusive(db-schema) + the drain completed, so applying by hand here is coordinated and safe AS LONG AS you record the schema_migrations row in the SAME transaction as the DDL — a bare `psql -f` without it leaves the migration unrecorded, so every future deploy/boot re-applies the file (a lock-contending re-run can trip a deploy lock_timeout).',
              command: readyCommand,
              note: 'sha256 must match createHash(\'sha256\').update(<raw file text>).digest(\'hex\') (embedded-postgres-server/src/migration-runner.js) — `sha256sum <file>` on the exact file bytes gives the same value.',
              escalateHint:
                'No shell/PG access to run this yourself (a cup) and it is genuinely urgent? Re-call db:migrate with escalate:true instead of improvising a hand-off.',
            },
          });
        }
        // D-001 fencing: re-verify we still hold the effective exclusive at our
        // fence before the irreversible DDL apply. A paused/zombie holder whose
        // lease lapsed and was re-granted is rejected — no merge un-corrupts a
        // double-migrate, so this is correctness-class.
        const fc = await fence.assertCurrent();
        if (!fc.current) {
          return json({
            ok: false,
            applied: false,
            reason: `stale_fence_${fc.reason}`,
            fence_seq: fence.seq,
            live_fence_seq: fc.live_fence_seq,
            note: 'Migration ABORTED — our exclusive(db-schema) lease was superseded while we held it. Re-acquire before retrying.',
          });
        }
        // D-001 resource-side idempotency: make the su_meta migration-name check
        // EXPLICIT. A retried / zombie re-apply of the SAME file short-circuits
        // here as a checked no-op even if fencing were somehow bypassed.
        const actionKey = `migrate:${path.basename(args.file)}`;
        const prior = await checkResourceAction(getTxPool(), coordinationDomain, actionKey);
        if (prior.applied) {
          return json({
            ok: true,
            applied: false,
            already_applied: true,
            action_key: actionKey,
            prior_fence_seq: prior.fence_seq,
            note: 'This migration file was already applied (resource-side idempotency ledger) — no-op.',
          });
        }
        const url = getHarnessAdminUrl();
        // EI-6962: the previous version ran the file bare (`psql -f <file>`)
        // and only recorded success in the su_meta coordination-domain
        // idempotency ledger (recordResourceAction below) — NEVER in
        // harness_shared.schema_migrations, the table every deploy/boot
        // actually reads to decide what's already applied. That left the
        // enabled path (this branch) exactly as unsafe as the withheld
        // path's own fallback warns against: a future deploy/boot re-runs
        // the "applied" file, and a lock-contending re-run can trip the
        // deploy's lock_timeout (the 2026-06-09 ~1h wedge this tool exists
        // to prevent). Fix: wrap the file in the SAME BEGIN/COMMIT as the
        // schema_migrations INSERT, mirroring both the withheld-branch's own
        // documented fallback command above and
        // embedded-postgres-server/src/migration-runner.js's boot-apply path
        // — `\i` (not `-f`) so the file still runs through psql's full
        // meta-command interpreter (dollar-quotes, DO blocks, COPY), keeping
        // the perf:allow A4 rationale below intact.
        const sha256 = createHash('sha256').update(sqlText).digest('hex');
        const filenameLiteral = path.basename(args.file).replace(/'/g, "''");
        // WI-6381: the caller-opted-in wide wait (see args.lock_timeout_sec's
        // description above) — falls back to the EI-9417 default when omitted,
        // producing the exact same script text as before this change.
        const lockTimeoutSec = args.lock_timeout_sec ?? DEFAULT_LOCK_TIMEOUT_SEC;
        const migrationMaxAttempts = args.lock_timeout_sec != null ? CUSTOM_LOCK_TIMEOUT_MAX_ATTEMPTS : LOCK_RETRY_MAX_ATTEMPTS;
        const script =
          `BEGIN;\n` +
          `SET LOCAL statement_timeout = 0;\n` +
          // EI-9417: fail FAST on lock contention (was unset — could hang
          // indefinitely against a hot table) instead of waiting it out; the
          // retry loop below is what actually rides out the contention.
          // WI-6381: caller-widened when riding out a known long-lived
          // non-operator holder instead (see migrationMaxAttempts above).
          `SET LOCAL lock_timeout = '${lockTimeoutSec}s';\n` +
          `\\i ${args.file}\n` +
          `INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('${filenameLiteral}', '${sha256}');\n` +
          `COMMIT;\n`;
        // perf:allow A4 — this tool IS the sanctioned dev-only migration
        // applier: psql's meta-command interpreter runs full .sql files
        // (dollar-quoted functions, DO blocks, COPY, \meta-commands) that
        // postgres-js can't, and it's gated behind PAPERCUSP_ALLOW_DB_MIGRATE
        // + the db-schema lock. Not runtime/shipped data-plane code. Mirrored
        // in @papercusp/export-state's no-psql-shellout ALLOW set.
        // EI-18769559897594065: the drain is over (onTick above stops firing
        // the moment guardResource's run() starts) — emit one more tick so a
        // caller watching progress sees the phase change instead of silence
        // resuming right as the (potentially multi-attempt, backoff-retried)
        // apply begins.
        emitProgress(undefined, JSON.stringify({ phase: 'applying', file: path.basename(args.file) }));
        // EI-9417: retries automatically on "canceling statement due to lock
        // timeout" against a hot coordination table (coord_presence et al) —
        // see runMigrationWithLockRetry above.
        const { result: r, attempts } = await runMigrationWithLockRetry(url, script, undefined, migrationMaxAttempts, (attempt, maxAttempts) => {
          if (attempt > 1) {
            emitProgress(
              undefined,
              JSON.stringify({ phase: 'applying', retry_attempt: attempt, max_attempts: maxAttempts }),
            );
          }
        });
        if (r.status !== 0) {
          // WI-6002: before trusting this failure, check whether it's actually
          // the schema_migrations duplicate-key guard tripping on a migration
          // an EARLIER attempt already committed (see the comment above
          // checkSchemaMigrationsRecorded). Only bother with the extra psql
          // round-trip when the stderr shape matches — a genuine syntax/logic
          // error skips straight to the real failure report, unchanged.
          if (isDuplicateMigrationLedgerFailure(r.stderr ?? '') && checkSchemaMigrationsRecorded(url, path.basename(args.file))) {
            return json({
              ok: true,
              applied: false,
              already_applied: true,
              file: args.file,
              note:
                'psql reported a failure (schema_migrations duplicate-key guard), but harness_shared.schema_migrations ' +
                'already records this file as applied — verified via a FRESH connection, independent of whatever ' +
                'connection dropped on the earlier attempt. Treating this as a redundant retry, not a real failure.',
              exit_code: r.status,
              stderr: (r.stderr ?? '').slice(-2000),
              attempts,
            });
          }
          return json({
            ok: false,
            applied: false,
            exit_code: r.status,
            stderr: (r.stderr ?? '').slice(-2000),
            attempts,
            // EI-18747087108453188: was isLockTimeoutFailure-only, so a deadlock
            // or serialization-failure exhaustion (both now retried above)
            // silently reported false here. Widened to match the same
            // predicate the retry loop itself uses. WI-6381: compares against
            // migrationMaxAttempts (2 when lock_timeout_sec was set), not the
            // hardcoded default — otherwise a caller who opted into the
            // 2-attempt long-wait path would see this flag stick at false
            // forever (attempts never reaches 5).
            lock_timeout_retries_exhausted: attempts >= migrationMaxAttempts && isRetryableLockFailure(r.stderr ?? ''),
          });
        }
        // Record only on a successful apply (first writer wins). This is the
        // su_meta coordination-domain idempotency ledger (a DIFFERENT record
        // from the schema_migrations row the script above just committed) —
        // it backstops a retried/zombie re-apply of the SAME file even when
        // this tool's own fencing were somehow bypassed (D-001 above).
        await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
          recordResourceAction(tx, coordinationDomain, actionKey, fence.seq),
        );
        return json({
          ok: true,
          drained: true,
          applied: true,
          file: args.file,
          fence_seq: fence.seq,
          schema_migrations_recorded: true,
          sha256,
          attempts,
        });
      },
      ),
    );

    if (outcome.acquired) return outcome.result;
    // EI-18769559897594065: a failure at THIS point means guardResource's run()
    // never started — no psql apply was attempted, so no DDL ran. Say so
    // explicitly: the failure mode this closes is a caller (or a downstream
    // reader of a client-side timeout report) assuming "failed" means "may have
    // partially applied" and manually verifying/hesitating before a retry that
    // is, at this stage, always safe.
    return json({
      ok: false,
      reason: `resource_${outcome.reason}`,
      resource: 'db-schema',
      holders: outcome.holders.map(holderJson),
      note:
        'No DDL was applied — this failure occurred while acquiring/draining exclusive(db-schema), before the ' +
        'migration script ever ran. Safe to retry immediately (raise max_drain_sec if holders keep blocking). If ' +
        'YOUR client reported a timeout/abort but the server call kept running (it does not stop server-side), ' +
        'a re-call now will report the true current state rather than repeating a stale client-side guess.',
    });
  },
});
