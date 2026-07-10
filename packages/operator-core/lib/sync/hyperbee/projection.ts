/**
 * Bidirectional PG ↔ Hyperbee projection registry.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-table read/write hooks are registered here; the substrate
 * applies them on Hyperbee ops it receives + invokes them on PG
 * writes that need to fan out to Hyperbee.
 *
 * NOT WIRED YET to the actual operator boot path or PG triggers —
 * this commit ships the interface + registry + LWW helper. Per-table
 * hooks land in follow-up commits (one per HYPERBEE-bucket table)
 * because each table has its own row contract.
 *
 * v5 D-012 — same-key Hyperbee conflicts resolve LWW by `ts` (op
 * timestamp). LWW helper here is pure + testable.
 */

import type { OpEnvelope } from './op-envelope-types';
import { observeMergedOp } from './clobber-events';
import { observeRemoteHlc } from './hlc-stamp';
import { encodeHlc, type HlcClock } from '@papercusp/locks-core';

/**
 * G1 Provenance context (P-002). Passed to `writeToPg` so each per-table writer
 * can stamp `author_pubkey` + `origin` on the upserted row.
 *
 * `origin` is determined by the apply path (not the writer) because it requires
 * comparing `sourceLogKeyHex` against the own log's `keyHex` — information
 * the writer doesn't hold. The writer just stamps the values it receives.
 */
export interface ProvenanceContext {
  /**
   * The UNFORGEABLE writer identity for this op (maps to `author_pubkey`
   * column). P-002/D-004: for a `local` op it's the own device pubkey (the
   * trustworthy self-declared `writerPubkey`); for a `remote` op it's the
   * receiver-stamped, immutable `sourceLogKeyHex` (the source log core key) —
   * NOT the self-declared field, which a remote peer controls. `''` when a
   * remote op carries no source key. Resolve a remote value to its
   * device/GitHub identity at read time via the admission map.
   */
  authorPubkey: string;
  /** 'local' | 'remote' — derived from log-source (own vs admitted-remote). */
  origin: 'local' | 'remote';
  /**
   * EI-79 residual step 2: the op's WIRE ts (epoch ms) — the LWW ordering field
   * `lwwPick` orders on. Writers persist it as the table's `fed_ts` column and
   * guard their `ON CONFLICT ... DO UPDATE` with `WHERE EXCLUDED.fed_ts >=
   * <table>.fed_ts`, so a strictly-older (out-of-order / backfilled) op can
   * never clobber a newer projected row — making each writer PG-level
   * last-write-wins INDEPENDENT of the incremental merge cursor's in-process
   * fold. `undefined` for a synthetic/local op built without a ts (the writers
   * treat a NULL stored fed_ts as "older than anything", so such a write lands).
   */
  ts?: number;
  /**
   * D-001 (shared-pot-release-testing Brief J): the op's HLC ordering key — the
   * SAME causal clock `lwwPick` orders the merge fold by. Writers persist it as
   * the table's `fed_hlc` column and guard their `ON CONFLICT …` with
   * `harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >=
   * harness_shared.fed_order_key(<table>.fed_hlc, <table>.fed_ts)` — a SQL mirror
   * of `lwwPick`'s single derived-order-space fix (EI-1698: `hlc ?? encodeHlc({ms:
   * ts ?? 0, count: 0})` on both sides), so the guard compares in the exact same
   * total order the fold does and never rejects a fold-winner under clock skew or
   * mixed HLC presence (the D-001 split-brain). `undefined` for an op without an
   * `hlc` (the append-only claim path; legacy ops) — the writer stores NULL and
   * the guard derives an order key from `fed_ts` instead.
   */
  fedHlc?: string;
}

export interface TableProjection<Row> {
  /** Table tag, matching `hyperbee-key-types.HYPERBEE_TABLE_TAGS`. */
  tableTag: string;
  /**
   * EI-117 echo breaker. Set `true` on projections whose PG table is
   * CDC-CAPTURED (a capture trigger enqueues local PG writes into
   * `substrate_outbox`, the drain appends them to the own log): for those
   * tables an own-log op is by construction a REPLAY of a row PG already
   * authored, so applying it back is at best redundant and at worst a silent
   * revert (an old op landing over newer local content) whose write re-enters
   * the capture trigger as `origin='local'` — the self-sustaining echo storm
   * behind EI-117 (plan-doc reverts) and a contributor to EI-125 (outbox
   * bloat). Log-first tables (claims / queue / working-set / contributors /
   * presence / prs / usage) must NOT set this — their PG state arrives via the
   * merge, own ops included. Skipping is gated on log-source verification in
   * `applyOpVia` (`op.sourceLogKeyHex === ownLogKeyHex`); paths without an
   * `ownLogKeyHex` (legacy global-registry) skip nothing.
   */
  skipOwnOps?: boolean;
  /**
   * Build the Hyperbee key for a given row. Single source of truth
   * for the per-table key shape — composer + parser stay aligned.
   */
  composeKey: (row: Row) => string;
  /** Parse the row out of a Hyperbee value. */
  decodeValue: (raw: unknown) => Row | null;
  /**
   * F1-4 / P-012 (federated-scout-gym): optional per-source refused-op
   * observability. When `decodeValue` returns null — the op was DECLINED (a
   * malformed wire row, or a non-federatable elite a buggy/hostile sender's log
   * carried) — `applyOpVia` invokes this with the raw op value and the SAME
   * resolved `ProvenanceContext` the put path would see, so a projection can bump
   * a per-source refused-op counter (`federation_refused_op_counters`, mig 474).
   * Only content projections that want the observability implement it; the rest
   * silently drop as before. FAIL-SOFT: `applyOpVia` swallows a throw so refusal
   * accounting can never break the apply loop. Called only for a `put` whose
   * decode failed (a `del` carries no value to validate).
   */
  onRefusedOp?: (rawValue: unknown, provenance: ProvenanceContext | undefined) => void | Promise<void>;
  /**
   * Write the row into PG (idempotent — must handle re-application).
   *
   * G1 Provenance (P-002): the second arg carries `{ authorPubkey, origin }`
   * so the writer can stamp `author_pubkey` + `origin` on the upserted row.
   * Optional to preserve backward-compat with writers not yet upgraded (they
   * silently ignore the context).
   */
  writeToPg: (row: Row, provenance?: ProvenanceContext) => Promise<void>;
  /**
   * Delete the row from PG (idempotent).
   *
   * EI-79 residual step 2: `delTs` is the del op's WIRE ts (epoch ms). The
   * deleter guards its DELETE with `WHERE fed_ts IS NULL OR fed_ts <= <delTs>`,
   * the symmetric partner of the upsert's `fed_ts`-`>=` guard, so a stale (out
   * of order / backfilled) del can never erase a row a newer put recreated —
   * making the deleter PG-level LWW independent of the merge cursor's fold.
   * `undefined` for a del op built without a ts (unguarded → deletes, the
   * pre-step-2 behavior).
   *
   * D-001 (Brief J): `delHlc` is the del op's HLC ordering key. The deleter
   * guards its DELETE with the SAME HLC-then-fed_ts order as the put guard (a
   * stale del — lower HLC — must not erase a row a newer put recreated), falling
   * back to the `delTs` ts-guard when either side lacks an hlc. `undefined` for a
   * del op without an `hlc` (legacy / claim path) → the ts-guard alone applies.
   *
   * P-018 / D-012: the optional 4th arg carries the SAME `ProvenanceContext` the put
   * path resolves (the UNFORGEABLE author identity + origin), so an author-scoped
   * deleter can authorize a tombstone by row OWNERSHIP — i.e. reject a stranger-member
   * deleting another member's plan in a public/open hive. Optional + back-compatible:
   * deleters that don't author-scope ignore it (today's behavior).
   */
  deleteFromPg: (
    key: string,
    delTs?: number,
    delHlc?: string,
    provenance?: ProvenanceContext,
  ) => Promise<void>;
}

const registry = new Map<string, TableProjection<unknown>>();

export function registerProjection<Row>(p: TableProjection<Row>): void {
  registry.set(p.tableTag, p as TableProjection<unknown>);
}

export function getProjection(tableTag: string): TableProjection<unknown> | null {
  return registry.get(tableTag) ?? null;
}

export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * A projection-set lookup: `tableTag → projection | null`. The single seam
 * `applyOpVia` dispatches through, so the GLOBAL registry and a PER-HARNESS
 * scoped projection set share one apply implementation (no duplicated
 * put/del/decode/clobber logic). The global path passes the module registry's
 * `getProjection`; a per-harness path passes a lookup bound to that harness's
 * own projection set (see `buildHarnessProjectionApply` in `projections/
 * register-all.ts`).
 */
export type ProjectionLookup = (tableTag: string) => TableProjection<unknown> | null;

/**
 * G1 Provenance (P-002): options for `applyOpVia`. The `ownLogKeyHex` is the
 * hex key of this harness's own writable log (from `ownLog.keyHex` in
 * `boot.ts`). When provided, `applyOpVia` determines `origin` by comparing
 * `op.sourceLogKeyHex === ownLogKeyHex` (log-source approach, D-006). When
 * absent (global registry path / callers that haven't threaded it yet), origin
 * falls back to `writerPubkey`-comparison against `ownWriterPubkey`; if neither
 * is available, origin defaults to `'local'` (safe default — the global-registry
 * path is single-harness legacy; no remote peers write through it).
 */
export interface ApplyOpOpts {
  /**
   * The own log's hex keyHex. When set, `op.sourceLogKeyHex === ownLogKeyHex`
   * → `origin='local'`; any other source → `origin='remote'`.
   */
  ownLogKeyHex?: string;
  /**
   * Override the process-global HLC the RECV seam advances on a remote op.
   * Defaults to `processHlc()`. A test harness simulating MULTIPLE peers in ONE
   * process passes a PER-PEER clock so each simulated peer advances its OWN clock
   * on receive (real peers are separate processes); paired with the same per-peer
   * clock on `stampOpHlc` (boot's send seam).
   */
  hlcClock?: HlcClock;
}

/**
 * Resolve the {@link ProvenanceContext} for an op — origin (local vs admitted-remote, via
 * log-source) + the UNFORGEABLE author identity + ts/hlc. Shared by the put AND del branches
 * of {@link applyOpVia} (P-018/D-012: deletes need the same provenance the puts do, so an
 * author-scoped deleter can authorize a tombstone by row ownership). Pure of the projection.
 */
function resolveOpProvenance(op: OpEnvelope, applyOpts?: ApplyOpOpts): ProvenanceContext | undefined {
  // G1 Provenance (P-002): determine origin via log-source when possible. Log-source is the
  // authoritative signal (D-006): an op whose sourceLogKeyHex matches the own log's keyHex was
  // written locally and cannot be forged by a remote peer. Without ownLogKeyHex (legacy /
  // global-registry path) we default to 'local' (safe for single-peer use).
  if (op.writerPubkey !== undefined || applyOpts?.ownLogKeyHex !== undefined) {
    let origin: 'local' | 'remote' = 'local';
    if (applyOpts?.ownLogKeyHex !== undefined) {
      origin =
        op.sourceLogKeyHex !== undefined && op.sourceLogKeyHex === applyOpts.ownLogKeyHex
          ? 'local'
          : 'remote';
    }
    // P-002/D-004 — attribution must be UNFORGEABLE. `writerPubkey` is self-declared (a field in
    // the op value), so a remote peer can set it to anything. For a REMOTE op attribute by the
    // receiver-stamped, immutable `sourceLogKeyHex` (the source log core key); `''` when absent
    // rather than trust the forgeable field. For a LOCAL op `writerPubkey` is the operator's OWN
    // write — trustworthy. D-001: thread the op's HLC so the writer stamps fed_hlc.
    const authorPubkey =
      origin === 'remote' ? (op.sourceLogKeyHex ?? '') : (op.writerPubkey ?? '');
    return { authorPubkey, origin, ts: op.ts, fedHlc: op.hlc };
  }
  if (typeof op.ts === 'number') {
    // EI-79 step 2: even a provenance-less op must carry its `ts` so the writer stamps fed_ts and
    // the PG-level LWW guard works. Default attribution to a local self-write. D-001: carry hlc too.
    return { authorPubkey: op.writerPubkey ?? '', origin: 'local', ts: op.ts, fedHlc: op.hlc };
  }
  return undefined;
}

/**
 * Core op-dispatch: resolve `op.table` via `lookup`, then write/delete the row
 * to PG and fire the clobber-event hook. Returns true iff the op was applied
 * (false on unknown table / non-put-del / decode failure / missing key).
 *
 * This is the single source of truth for "apply one op through a projection
 * set" — both `applyHyperbeeOpToPg` (global registry) and a per-harness scoped
 * apply call it with different lookups, so the put/del/decode/clobber logic is
 * NOT duplicated (Model B per-harness projection-apply, D-021 collision fix).
 *
 * G1 Provenance (P-002): when `applyOpts.ownLogKeyHex` is provided, computes
 * `origin` via log-source comparison (`op.sourceLogKeyHex === ownLogKeyHex`
 * → 'local', else 'remote') and passes `ProvenanceContext` to `writeToPg`.
 * Writers that understand provenance stamp `author_pubkey` + `origin` on upsert;
 * legacy writers (no provenance param) continue to work unchanged.
 */
export async function applyOpVia(
  lookup: ProjectionLookup,
  op: OpEnvelope,
  applyOpts?: ApplyOpOpts,
): Promise<boolean> {
  if (op.type !== 'put' && op.type !== 'del') return false;
  if (!op.table) return false;
  const p = lookup(op.table);
  if (!p) return false;
  // EI-117 echo breaker: skip log-source-VERIFIED own ops on CDC-captured
  // tables (see `TableProjection.skipOwnOps`). WI-1684: narrowed to PUTS ONLY.
  // An own PUT re-apply is an UPSERT that re-fires the capture trigger as
  // origin='local' → the echo storm the skip exists to break. An own DEL must
  // NOT be skipped: during the drain window (before the author's own del reaches
  // its own log) a concurrent lower-hlc foreign put can hit the no-row INSERT
  // path and RESURRECT the row on the author peer only; the winning own del is
  // then the ONLY thing that can clean it up, and skipping its apply makes the
  // resurrection permanent (silent split-brain on row PRESENCE — the deleting
  // peer keeps a row every other peer deleted). Re-applying the del is echo-safe:
  // a 0-row delete never fires the FOR EACH ROW capture trigger, and a resurrected
  // row is origin='remote' so capture's echo-guard skips it — neither re-enters the
  // outbox. deleteFromPg stays fed_hlc-guarded, so it cannot erase a row a
  // genuinely-newer put recreated.
  if (
    p.skipOwnOps === true &&
    op.type === 'put' &&
    applyOpts?.ownLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== undefined &&
    op.sourceLogKeyHex === applyOpts.ownLogKeyHex
  ) {
    return false;
  }
  // P-010 RECV seam: observing a REMOTE op's HLC advances this process's logical
  // clock past the remote causal frontier, so a subsequent LOCAL write is
  // stamped strictly-greater — the cross-machine happens-before that makes
  // `lwwPick` causal rather than wall-clock-skew-dependent. Fires for every
  // applied remote op (put or del) that carries an `hlc`; own ops never advance
  // (we authored them). Gated on log-source: only with `ownLogKeyHex` known can
  // we tell remote from own — the single-harness/global-registry path has no
  // remote peers, so skipping the advance there is correct.
  if (
    op.hlc &&
    applyOpts?.ownLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== applyOpts.ownLogKeyHex
  ) {
    observeRemoteHlc(op.hlc, applyOpts.hlcClock);
  }
  if (op.type === 'del') {
    if (!op.hbKey) return false;
    // EI-79 step 2 + D-001: thread the del op's wire ts AND its HLC so the
    // deleter can guard the DELETE by the same HLC-then-fed_ts order as the put
    // guard (a stale del must not erase a row a newer put recreated).
    // P-018/D-012: thread the SAME provenance the put path resolves, so an author-
    // scoped deleter can authorize a tombstone by row OWNERSHIP (the unforgeable
    // source-log identity) — rejecting a stranger-member's delete in an open hive.
    await p.deleteFromPg(op.hbKey, op.ts, op.hlc, resolveOpProvenance(op, applyOpts));
    return true;
  }
  const row = p.decodeValue(op.value);
  if (!row) {
    // F1-4 / P-012: the op was DECLINED (malformed / not-federatable). Give the
    // projection a chance to record a per-source refused-op counter. Fail-soft —
    // refusal accounting must never break the apply loop.
    if (p.onRefusedOp) {
      try {
        await p.onRefusedOp(op.value, resolveOpProvenance(op, applyOpts));
      } catch {
        /* observability is not load-bearing */
      }
    }
    return false;
  }

  const provenance = resolveOpProvenance(op, applyOpts);

  await p.writeToPg(row, provenance);
  // P-035: clobber-event hook. Fires only when the incoming op has
  // a writerPubkey + the tracker has a recent local write for the
  // same key from a *different* pubkey within the 60s window.
  // No-op when writerPubkey is absent (legacy / un-threaded write).
  if (op.writerPubkey && op.hbKey && typeof op.ts === 'number') {
    observeMergedOp({
      table: op.table,
      hbKey: op.hbKey,
      ts: op.ts,
      pubkey: op.writerPubkey,
    });
  }
  return true;
}

/**
 * Apply one Hyperbee op against the GLOBAL registry. Called by the
 * Hyperbee read loop. Returns true if the op was applied to PG,
 * false if it was dropped (unknown table / decode failed / LWW
 * stale).
 *
 * NOTE (Model B): with 2+ booted harnesses, the global registry is a
 * last-writer-wins collision point — `registerAllHarnessProjections` overwrites
 * by `tableTag`, so this global apply dispatches to whichever harness registered
 * last. Model B's boot path therefore uses a PER-HARNESS scoped apply
 * (`buildHarnessProjectionApply`) instead of this global function. This is kept
 * for any caller that still has a single-harness global view.
 */
export async function applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean> {
  return applyOpVia((tableTag) => registry.get(tableTag) ?? null, op);
}

/**
 * LWW conflict resolution helper (D-003 HLC; tiebreak hardened in D-004/P-001).
 * Given two ops on the same key, return the one to keep:
 *
 *   1. the causally-later clock wins — by HLC (`encodeHlc` string compare) when
 *      BOTH ops carry one, else by the bare wall-clock `ts` (back-compat);
 *   2. on an exact tie, `del` beats `put` (safety — a delete that raced a write
 *      at the same instant takes precedence);
 *   3. on a clock tie with the SAME type (del/put doesn't decide), the op with
 *      the lexicographically-GREATER `sourceLogKeyHex` wins.
 *
 * The HLC (D-003) makes step 1 monotone across NTP corrections and causally
 * correct across machines — a backward clock step can no longer resurrect a
 * stale write, and a value that causally followed another never loses to it on
 * a wall-clock coincidence. It is additive: an op without `hlc` falls back to
 * `ts`, so the field rolls out per surface with no flag day. The encoded HLC is
 * a fixed-width sortable string, so `>` on it equals compareHlc.
 *
 * Step 3 is what makes the fold fully order-independent: the previous
 * "return the first arg" rule was arrival-order-dependent, so two peers folding
 * the same two ops in opposite orders could pick different winners and diverge.
 * The tiebreak keys off `sourceLogKeyHex` — the receiver-stamped source-log key
 * (`read-merge.toEnvelope`), which is BOTH peer-stable (every peer sees the same
 * source log keys) AND unforgeable (a writer controls the self-declared
 * `writerPubkey`, but NOT which admitted log a received op was replicated from).
 * A missing `sourceLogKeyHex` (synthetic / local legacy ops built outside the
 * merge path) is treated as `''` so the comparison stays total and stable.
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  // Step 1 — causal clock, as a SINGLE TOTAL order (EI-1698). Give EVERY op one
  // comparable key: its HLC when present, else a DERIVED HLC `{ms: ts, count: 0}`
  // (a no-HLC op behaves like an HLC op at wall-time `ts`, logical 0). Comparing
  // the SAME key for every pair is transitive. The previous rule — "HLC when BOTH
  // carry one, ELSE ts" — switched basis per pair and was NON-TRANSITIVE under
  // mixed HLC presence: a no-HLC op whose ts sat BETWEEN two HLC ops on a key
  // formed a winner cycle (X>Z, Z>Y, Y>X), so two peers folding the same ops in
  // different delivery orders diverged on a contended key (rolling-upgrade skew).
  // Backward-compatible: HLC-only pairs still compare by HLC, ts-only pairs still
  // compare by ts (both via encodeHlc's fixed-width sortable `ms:count` string),
  // and a no-HLC op (pre-P-010 = oldest ts) sorts below the newer HLC ops as before.
  const ka = a.hlc ?? encodeHlc({ ms: a.ts ?? 0, count: 0 });
  const kb = b.hlc ?? encodeHlc({ ms: b.ts ?? 0, count: 0 });
  if (ka > kb) return a;
  if (kb > ka) return b;
  // ── clock tie ──
  // del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // Same type on a clock tie → deterministic, unforgeable tiebreak: the higher
  // (lexicographically-greater) sourceLogKeyHex wins, identical on every peer
  // regardless of fold order. Undefined source ⇒ '' so the order is total.
  const sa = a.sourceLogKeyHex ?? '';
  const sb = b.sourceLogKeyHex ?? '';
  if (sa >= sb) return a;
  return b;
}
