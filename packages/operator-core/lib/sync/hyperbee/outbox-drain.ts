/**
 * outbox-drain — Stage 3 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Reads undrained `harness_shared.substrate_outbox` rows for one booted harness
 * and appends the mapped `LocalWriteOp`s to that device's own Hypercore log via
 * `BootedHarnessHandle.append`, so feature content + issues federate to peers
 * (the read-side `harness-features` / `issues` projections apply them).
 *
 * Delivery: AT-LEAST-ONCE (D-4). A row is marked `drained_at` ONLY after its
 * `append` resolves. If `append` throws on a row, the drain STOPS (leaving that
 * row + all later rows undrained) so the next pass re-attempts them. The LWW
 * merge + idempotent `INSERT … ON CONFLICT` projections tolerate a duplicate /
 * reordered op, so re-appending a row that was actually delivered is harmless.
 *
 * Liveness: `startOutboxDrain` wires a `LISTEN substrate_outbox` (event-driven,
 * the Stage-1 trigger fires `pg_notify` with payload `${ws}::${slug}`) PLUS a
 * bounded poll-fallback timer (in case a NOTIFY is missed while the process was
 * briefly down). This is CDC within one process — NOT polling-as-transport
 * (D-3). It also runs an immediate catch-up drain on start.
 *
 * Inline 24h GC: each drain also deletes ITS OWN (workspace, harness) rows
 * drained > 24h ago, keeping the outbox table small without a separate sweeper
 * (user-approved default — open question 1 in the plan). The GC is scoped per
 * handle so N booted harnesses don't run N concurrent global DELETEs (EI-125).
 *
 * NOT wired into boot here — Stage 5 calls `startOutboxDrain` from boot-all.ts.
 */

import type postgres from 'postgres';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';
import { outboxRowToLocalWriteOp, UnknownOutboxTableError, type OutboxRow } from './feature-issue-op-keys';
import { recordLocalWrite } from './clobber-events';
import { shouldEncryptOpForRekey } from './hive-epoch-content-ops';
import { redactContentOpValueForEgress } from './content-op-egress-guard';

/**
 * The projection tableTag for federated plans (harness-plans.ts:199 — the value
 * `outboxRowToLocalWriteOp` maps `harness_plans` to). The CDC drain records a
 * LOCAL write for plan ops so a later REMOTE plan op for the same plan_slug can be
 * detected as a clobber (shared-hive-collaboration P-007). Scoped to plans: the
 * other CDC tables (features/issues) have no clobber surface, and `writerPubkey`
 * threading would entangle author-provenance — out of P-007's scope.
 */
const PLAN_TABLE_TAG = 'plans-by-slug';

/** Unmapped outbox table_names already logged (dedupe the forward-compat skip
 *  warning so an undrained unknown row doesn't spam the log every drain pass). */
const loggedUnknownTables = new Set<string>();

/** Drain batch size per `drainOutboxOnce` pass. Bounds memory + append latency;
 *  the LISTEN/poll loop re-drains until the table is empty. */
export const DEFAULT_DRAIN_BATCH = 200;

/** Drained rows older than this are GC'd inline on the next drain (24h). */
export const OUTBOX_GC_AGE_MS = 24 * 60 * 60 * 1000;

/** Inline-GC batch size. Bounded so a large backlog can't become one unbounded
 *  DELETE that never commits before the host recycles (the memory-watchdog
 *  recycles the operator ~every 12 min). Each batch is its own committed
 *  statement, so progress survives a restart. */
export const OUTBOX_GC_BATCH = 5000;

/** Max GC batches per drain pass — bounds GC time per pass (≤100k rows); the
 *  drain loop re-runs until the backlog clears. */
export const OUTBOX_GC_MAX_BATCHES = 20;

/** Default poll-fallback cadence for `startOutboxDrain` (ms). */
export const DEFAULT_POLL_MS = 5000;

/**
 * WI-2009 (gate 1b, shared-hive-p2p-release-readiness): watchdog timeout for ONE
 * drain pass. The drain loop SERIALIZES passes (`draining` flag) — so a single
 * pass that never settles (a hung `await`: keychain unwrap inside
 * `epochEncrypt.encryptOp` on a wedged mac keychain [WI-2018], an epoch-key
 * resolution, an `append` into a wedged substrate) freezes the WHOLE loop
 * FOREVER: every later NOTIFY/poll tick coalesces into the stuck pass and the
 * harness's local writes silently stop federating. That is the live VM
 * signature this WI was filed on (fail-count frozen for 18min+ across process
 * restarts, ONE fresh attempt ~50s post-boot then silence — the 5s poll never
 * "stopped", it was coalescing into a hung pass).
 *
 * The watchdog RACES each pass against this timeout. On expiry the loop is
 * un-wedged (the pass is abandoned; a fresh pass re-attempts on the next tick)
 * — SAFE by this module's own at-least-once contract: the zombie pass finishing
 * later just re-appends rows a newer pass already delivered, which the LWW
 * merge + idempotent projections tolerate by design. The stall also escalates
 * loudly (console line + durable EI via the replication-liveness EI surface) so
 * a hung drain is never silent again.
 */
export const DRAIN_PASS_TIMEOUT_MS = 120_000;

/** Thrown inside the drain loop when a pass exceeds `DRAIN_PASS_TIMEOUT_MS`. */
export class DrainPassTimeoutError extends Error {
  constructor(readonly scope: string, readonly timeoutMs: number) {
    super(
      `[outbox-drain] PASS TIMEOUT for ${scope}: a drain pass exceeded ${timeoutMs}ms — ` +
        `hung await (keychain unwrap / epoch-key resolution / append) wedging the serialized ` +
        `drain loop (WI-2009 class). Loop un-wedged; next tick re-attempts.`,
    );
    this.name = 'DrainPassTimeoutError';
  }
}

/** The NOTIFY channel the Stage-1 capture trigger fires on. */
const NOTIFY_CHANNEL = 'substrate_outbox';

/** A captured outbox row, as the local fan-out consumer reads it. */
export interface OutboxFanoutRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
}

/** The local subscribe→inject fan-out consumer (coordination-substrate Phase 2).
 *  Runs per row on the SAME drain as federation (not a second consumer). */
export type OutboxFanoutFn = (row: OutboxFanoutRow) => Promise<unknown>;

/**
 * The encrypt-on-capture capability for the read-plane re-key (C-001,
 * shared-hive-rekey-2026-06-19). Built at boot from the hive's crypto + epoch-key
 * resolver (owner derives / member unwraps) + localDevice, and THREADED into the
 * drain. The drain calls `encryptOp` for the hive-CONTENT ops it selects
 * (`shouldEncryptOpForRekey`), then stamps the returned `{ epoch }` + sets the
 * encrypted `value` on the op before append. ABSENT ⇒ the re-key is off for this
 * harness and every op federates plaintext (today's behavior, byte-identical).
 */
export interface EpochEncryptCapability {
  /**
   * Encrypt a selected content op's payload under the hive's CURRENT epoch key.
   * Returns `{ epoch, value }` — the epoch to stamp + the json-safe encrypted value
   * to set on `op.value` — or `null` to leave the op plaintext. MAY reject
   * (e.g. `EpochKeyUnavailableError`) when the current epoch key has not yet reached
   * this device; the drain treats that like an append failure (halt + retry) so the
   * op federates once the key arrives — it is never dropped or sent in the clear.
   */
  encryptOp(op: LocalWriteOp): Promise<{ epoch: number; value: unknown } | null>;
}

export interface DrainOptions {
  /** Max rows to drain this pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Clock override (epoch ms) — for the drained_at stamp + GC cutoff. Tests
   *  inject a fixed value; production omits it (Date.now). */
  now?: number;
  /** Local subscribe→inject fan-out, run per row AFTER the federation append and
   *  BEFORE drained_at (at-least-once: a failure re-runs; the insert is
   *  idempotent). Omitted → no fan-out (federation-only, the pre-Phase-2 behavior). */
  fanout?: OutboxFanoutFn;
  /** Re-key encrypt-on-capture capability (C-001). When present, the drain encrypts
   *  the payload of selected hive-CONTENT ops under the current epoch + stamps
   *  `op.epoch` before append. Omitted ⇒ no encryption (plaintext, today's path). */
  epochEncrypt?: EpochEncryptCapability;
  /** Test seam: override the inline-GC batch size (`OUTBOX_GC_BATCH`). Lets a
   *  test exercise the batched/bounded loop + early-break without seeding 100k+
   *  rows. Production omits it. */
  _gcBatch?: number;
  /** Test seam: override the inline-GC max-batches bound (`OUTBOX_GC_MAX_BATCHES`).
   *  Production omits it. */
  _gcMaxBatches?: number;
}

interface OutboxDbRow {
  id: string | number;
  table_name: string;
  op: 'put' | 'del';
  key: string;
  row: Record<string, unknown> | null;
  ts: string | number;
  /** D-001: the op's HLC ordering key (the PG clock of record), threaded onto the
   *  wire op so the remote peer's projection materialises an identical fed_hlc.
   *  NULL on a pre-314 outbox row / an append-only table → stampOpHlc fallback. */
  op_hlc: string | null;
}

/**
 * Drain one batch of undrained outbox rows for this handle's (workspace,
 * harness). Returns the number of rows drained.
 *
 * AT-LEAST-ONCE: marks `drained_at` ONLY after `append` resolves; if `append`
 * throws, the error propagates (the row + later rows stay undrained) so the
 * caller's retry re-attempts. Also performs the inline 24h GC of long-drained
 * rows before reading the batch.
 */
export async function drainOutboxOnce(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: DrainOptions = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? DEFAULT_DRAIN_BATCH;

  // Inline 24h GC — keep the table small. SCOPED to this handle's (workspace,
  // harness): every booted harness runs its own drain loop, so an unscoped GC
  // means N concurrent global DELETEs fighting over the same rows + locks
  // (root cause of EI-125 alongside the unbounded DELETE — this produced a
  // 102 GB substrate_outbox, 2026-06-08). Scoping also rides the
  // (workspace_id, harness_slug, drained_at, id) drain index. BOUNDED +
  // BATCHED: each capped batch is its own committed statement so progress
  // survives the memory-watchdog recycle (~every 12 min); the drain loop
  // re-runs until the backlog clears.
  // Best-effort: a GC failure must not block the drain, so swallow it.
  const gcBatch = opts._gcBatch ?? OUTBOX_GC_BATCH;
  const gcMaxBatches = opts._gcMaxBatches ?? OUTBOX_GC_MAX_BATCHES;
  try {
    for (let i = 0; i < gcMaxBatches; i++) {
      const gc = await pg`
        WITH del AS (
          SELECT id
            FROM harness_shared.substrate_outbox
           WHERE workspace_id = ${handle.workspaceId}
             AND harness_slug = ${handle.harnessSlug}
             AND drained_at IS NOT NULL
             AND drained_at < ${now - OUTBOX_GC_AGE_MS}
           LIMIT ${gcBatch}
        )
        DELETE FROM harness_shared.substrate_outbox o
         USING del
         WHERE o.id = del.id`;
      // Fewer than a full batch removed → backlog cleared for now.
      if ((gc.count ?? 0) < gcBatch) break;
    }
  } catch {
    // GC is non-fatal observability; continue to the actual drain.
  }

  const rows = await pg<OutboxDbRow[]>`
    SELECT id, table_name, op, key, row, ts,
           -- D-001: read op_hlc RESILIENTLY via to_jsonb so an outbox provisioned
           -- before migration 314 (an older boot snapshot / a hand-rolled test rig)
           -- degrades to NULL (stampOpHlc fallback) instead of the drain crashing
           -- on a missing op_hlc column. Production (314 applied) returns the value.
           (to_jsonb(substrate_outbox.*) ->> 'op_hlc') AS op_hlc
      FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${handle.workspaceId}
       AND harness_slug = ${handle.harnessSlug}
       AND drained_at IS NULL
     ORDER BY id
     LIMIT ${batch}`;

  let drained = 0;
  for (const r of rows) {
    let op: ReturnType<typeof outboxRowToLocalWriteOp>;
    try {
      op = outboxRowToLocalWriteOp({
        table_name: r.table_name,
        op: r.op,
        key: r.key,
        ts: typeof r.ts === 'number' ? r.ts : Number(r.ts),
        row: r.row,
        // D-001: the PG-clock HLC stamped at capture → op.hlc (stampOpHlc
        // preserves a preset hlc). NULL → stampOpHlc generates a fallback.
        op_hlc: r.op_hlc ?? undefined,
      } satisfies OutboxRow);
    } catch (e) {
      // Forward-compat: a NEWER capture trigger may enqueue a table this (older,
      // co-located) build can't map yet. SKIP that row — leave it undrained so a
      // newer build federates it — and CONTINUE to the next row, rather than
      // halting the whole drain (which would stop ALL federation for this scope).
      // Any OTHER error is a genuine fault → rethrow (preserve the at-least-once
      // halt-and-retry contract). Log each unknown table once to avoid per-pass spam.
      if (e instanceof UnknownOutboxTableError) {
        if (!loggedUnknownTables.has(e.tableName)) {
          loggedUnknownTables.add(e.tableName);
           
          console.warn(
            `[outbox-drain] skipping outbox rows for unmapped table '${e.tableName}' ` +
              `(forward-compat: this build has no projection for it; a newer build will ` +
              `federate them). Rows stay undrained.`,
          );
        }
        continue;
      }
      throw e;
    }

    // P-015 (federated-scout-gym D-006): EGRESS secrets-guard. A shareable fact
    // (body) / federatable elite (rationale) carries agent-authored free text that
    // could embed a credential — redact secret-bearing lines from the WIRE copy
    // HERE, before epoch-encryption + append, so a secret never leaves the hive.
    // Keeps the local PG row intact (only op.value is scrubbed). Fail-soft:
    // redactContentOpValueForEgress returns the value unchanged on any fault /
    // non-content tag / no-secret, so the drain can never break on redaction.
    if (op.type === 'put' && op.value !== undefined) {
      const guarded = redactContentOpValueForEgress(op.table, op.value);
      if (guarded.redacted) {
        op = { ...op, value: guarded.value };
         
        console.warn(
          `[outbox-drain] egress secrets-guard redacted a secret-bearing '${op.table}' op before federation`,
        );
      }
    }

    // Re-key encrypt-on-capture (C-001, shared-hive-rekey-2026-06-19): when the
    // re-key is active for this harness (capability threaded) AND this is a
    // hive-CONTENT put with a payload (admission/key/policy ops + dels stay
    // plaintext — shouldEncryptOpForRekey), encrypt the payload under the current
    // epoch + stamp op.epoch BEFORE append. A null result leaves the op plaintext;
    // a rejection (the epoch key is not yet on this device) propagates like an
    // append failure (halt + retry) so the op federates once the key arrives — it
    // is never dropped or sent in the clear.
    if (
      opts.epochEncrypt &&
      op.type === 'put' &&
      op.value !== undefined &&
      shouldEncryptOpForRekey(op.table)
    ) {
      const enc = await opts.epochEncrypt.encryptOp(op);
      if (enc) op = { ...op, value: enc.value, epoch: enc.epoch };
    }

    // AT-LEAST-ONCE: append FIRST. If this throws we stop here, leaving this
    // row + all later rows undrained for the next pass to re-attempt.
    await handle.append(op);

    // P-007: record this LOCAL plan write so a racing REMOTE plan op for the same
    // plan_slug is detected as a clobber (harness-plans.ts writeToPg fires
    // observeMergedOp on remote apply). Keyed by the device's own log key — a
    // remote op's receiver-stamped source key never equals it, so it never
    // self-clobbers. Plans only (see PLAN_TABLE_TAG). Best-effort: an in-memory
    // tracker write must never break federation.
    if (op.table === PLAN_TABLE_TAG) {
      try {
        recordLocalWrite({ table: op.table, hbKey: op.hbKey, ts: op.ts, pubkey: handle.ownLog.keyHex });
      } catch {
        // tracker is pure in-process bookkeeping; ignore.
      }
    }

    // Local subscribe→inject fan-out on the SAME row (Phase 2). BEST-EFFORT and
    // federation-safe: a fan-out failure is logged but must NOT stall federation
    // (the critical at-least-once path) or block this row's drained_at — so it is
    // caught here. The genuine double-process case (fan-out succeeds, then the
    // drained_at write fails → row reprocessed) is deduped by the idempotent
    // insert (deterministic msg_id + ON CONFLICT, mig 126). Non-subscribable
    // tables are a no-op inside the fan-out.
    if (opts.fanout) {
      try {
        await opts.fanout({ id: r.id, table_name: r.table_name, op: r.op, key: r.key, row: r.row });
      } catch (e) {
         
        console.error(
          `[outbox-drain] fan-out failed for ${r.table_name} key=${r.key} (federation unaffected):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Mark drained only after the append + fan-out resolved.
    await pg`
      UPDATE harness_shared.substrate_outbox
         SET drained_at = ${now}
       WHERE id = ${r.id}`;
    drained += 1;
  }

  return drained;
}

export interface StartDrainOptions {
  /** Poll-fallback cadence (ms). Default `DEFAULT_POLL_MS`. Set 0 to disable
   *  the timer (tests that only want the LISTEN/initial paths). */
  pollMs?: number;
  /** Drain batch size per pass. Default `DEFAULT_DRAIN_BATCH`. */
  batch?: number;
  /** Local subscribe→inject fan-out consumer, run per row (Phase 2). */
  fanout?: OutboxFanoutFn;
  /** Re-key encrypt-on-capture capability (C-001) — threaded to each drain pass. */
  epochEncrypt?: EpochEncryptCapability;
  /** Test seam: override the per-pass watchdog timeout (`DRAIN_PASS_TIMEOUT_MS`).
   *  0 disables the watchdog. Production omits it. */
  _passTimeoutMs?: number;
  /** Test seam: intercept the stall escalation (default = durable EI via
   *  `fileReplicationStallEi`). Production omits it. */
  _onStallEpisode?: (detail: string) => void;
}

export interface OutboxDrainHandle {
  /** Stop the loop: clear the poll timer + close the LISTEN connection.
   *  Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start the per-harness drain loop:
 *   - an immediate catch-up drain (in case the process was down with a backlog);
 *   - a `LISTEN substrate_outbox` that drains when a NOTIFY's payload matches
 *     this harness's `${workspaceId}::${harnessSlug}`;
 *   - a bounded poll-fallback timer (liveness if a NOTIFY is missed).
 *
 * Resilient: a drain error is logged, not fatal — the next NOTIFY/poll retries
 * (the undrained rows are still in the outbox).
 *
 * Returns a handle whose `stop()` clears the timer + closes the LISTEN
 * connection.
 */
export function startOutboxDrain(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: StartDrainOptions = {},
): OutboxDrainHandle {
  const pollMs = Number.isFinite(opts.pollMs as number) ? (opts.pollMs as number) : DEFAULT_POLL_MS;
  const batch = opts.batch;
  const fanout = opts.fanout;
  const epochEncrypt = opts.epochEncrypt;
  const wantPayload = `${handle.workspaceId}::${handle.harnessSlug}`;

  let stopped = false;
  // Serialize drains so a NOTIFY + poll + initial pass can't overlap (a half-
  // applied batch racing another). A pending drain is coalesced (run-again flag).
  let draining = false;
  let runAgain = false;

  const passTimeoutMs = opts._passTimeoutMs ?? DRAIN_PASS_TIMEOUT_MS;

  /** WI-2009 stall escalation: loud console line (grep-able, mirrors the
   *  WI-1840 detector pattern) + durable EI (dedup'd per harness while one
   *  stays open). Best-effort — never throws into the drain loop. */
  const escalateStall =
    opts._onStallEpisode ??
    ((detail: string): void => {
      void import('./replication-stall-ei').then(
        (m) =>
          m.fileReplicationStallEi({
            workspaceId: handle.workspaceId,
            harnessSlug: handle.harnessSlug,
            logKeyHex: handle.ownLog.keyHex,
            kind: 'drain_stalled',
            stalledForMs: passTimeoutMs,
            detail,
          }),
        () => {},
      );
    });

  async function drainSafely(): Promise<void> {
    if (stopped) return;
    if (draining) {
      runAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        runAgain = false;
        const drainOpts: DrainOptions = {};
        if (batch !== undefined) drainOpts.batch = batch;
        if (fanout !== undefined) drainOpts.fanout = fanout;
        if (epochEncrypt !== undefined) drainOpts.epochEncrypt = epochEncrypt;
        // WI-2009 watchdog: race the pass against the timeout so ONE hung await
        // can never wedge the serialized loop forever (the live-VM permanence
        // signature). The abandoned zombie pass is swallowed — if it settles
        // later its work is either complete (drained_at already stamped) or
        // re-attempted by a fresh pass (at-least-once tolerates the duplicate).
        const pass = drainOutboxOnce(handle, pg, drainOpts);
        if (passTimeoutMs > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              pass,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new DrainPassTimeoutError(wantPayload, passTimeoutMs)),
                  passTimeoutMs,
                );
                timer.unref?.();
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            // Detach the (possibly zombie) pass so a late rejection can't
            // become an unhandled rejection after we've moved on.
            pass.catch(() => {});
          }
        } else {
          await pass;
        }
      } while (runAgain && !stopped);
    } catch (e) {
       
      console.error(
        `[outbox-drain] drain failed for ${wantPayload}:`,
        e instanceof Error ? e.message : String(e),
      );
      if (e instanceof DrainPassTimeoutError) {
        escalateStall(
          `outbox-drain pass for ${wantPayload} exceeded ${passTimeoutMs}ms (hung await — ` +
            `WI-2009 permanence class; loop un-wedged, next tick re-attempts)`,
        );
      }
    } finally {
      draining = false;
    }
  }

  // Immediate catch-up drain.
  void drainSafely();

  // LISTEN — drain on a matching NOTIFY. `pg.listen` reserves its own dedicated
  // connection internally; the returned request's `unlisten()` releases it.
  const listenReq = pg.listen(NOTIFY_CHANNEL, (payload) => {
    if (stopped) return;
    if (payload === wantPayload) void drainSafely();
  });
  // Surface a listen-setup failure without crashing the boot path.
  void Promise.resolve(listenReq).catch((e: unknown) => {
     
    console.error(
      `[outbox-drain] LISTEN setup failed for ${wantPayload}:`,
      e instanceof Error ? e.message : String(e),
    );
  });

  // Poll-fallback timer (liveness if a NOTIFY is missed). `.unref()` so it never
  // keeps the process alive on its own.
  const pollTimer =
    pollMs > 0
      ? managedSetInterval('hyperbee-outbox-drain-poll', pollMs, () => {
          void drainSafely();
        }, { category: 'lifecycle', instanced: true })
      : null;

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) {
        try {
          pollTimer.stop();
        } catch {
          // no-op
        }
      }
      try {
        const req = await listenReq;
        await req.unlisten();
      } catch {
        // best-effort: the connection may already be closing
      }
    },
  };
}
