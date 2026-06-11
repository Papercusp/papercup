/**
 * cross-hive-asks-store-port — the C-1 `cross_hive_asks` ledger STORE seam
 * (hive-network-surface-2026-06-11, brief B-04 consuming brief B-02's contract).
 *
 * B-02 owns the migration + the live PG store; B-04's front-door tools
 * (`hive:ask` / `hive:request_work` / `hive:asks`) CONSUME it. This module is the
 * narrow port the tools build against plus a process-level provider so the live
 * store is injected once (B-02 registers its impl) without B-04's tools holding a
 * compile-time dependency on B-02's not-yet-landed module:
 *
 *   - B-02's store module (or the index.ts wiring line added on landing) calls
 *     `setCrossHiveAsksStore(impl)` once at boot.
 *   - The tools call `getCrossHiveAsksStore()`; before B-02 lands it throws a
 *     clear "pending" error, and tests inject a fake via `setCrossHiveAsksStore`.
 *
 * The row/insert/filter shapes mirror C-1 verbatim (see the plan's Contracts
 * section). When B-02 lands, the registered impl adapts its own row type to these
 * if they differ — the contract field set is fixed.
 */
import type { Sql } from 'postgres';

/** C-1 ask states + their legal transitions: queued→sent→answered|declined; queued|sent→expired. */
export type CrossHiveAskState = 'queued' | 'sent' | 'answered' | 'declined' | 'expired';
export type CrossHiveAskDirection = 'out' | 'in';
export type CrossHiveAskKind = 'ask' | 'work-request';

/** One `cross_hive_asks` row (C-1), camelCased for the TS surface. */
export interface CrossHiveAskRow {
  id: string;
  peerPubkey: string;
  direction: CrossHiveAskDirection;
  kind: CrossHiveAskKind;
  subject: string;
  body: string;
  correlationId: string;
  state: CrossHiveAskState;
  replyBody: string | null;
  replyTs: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields the SEND tools supply when recording a fresh outbound ask. */
export interface CrossHiveAskInsert {
  id: string;
  peerPubkey: string;
  direction: CrossHiveAskDirection;
  kind: CrossHiveAskKind;
  subject: string;
  body: string;
  correlationId: string;
  /** A just-created outbound ask is `sent` (delivered) or `queued` (peer offline). */
  state: 'queued' | 'sent';
}

/** Filter for `hive:asks` — every field ANDs; omit all for the full list. */
export interface CrossHiveAsksFilter {
  state?: CrossHiveAskState;
  direction?: CrossHiveAskDirection;
  peerPubkey?: string;
  correlationId?: string;
}

/** The narrow store surface B-04's tools depend on (a subset of B-02's full store). */
export interface CrossHiveAsksStore {
  insertCrossHiveAsk(
    workspaceId: string,
    hiveSlug: string,
    row: CrossHiveAskInsert,
    sql?: Sql,
  ): Promise<void>;
  listCrossHiveAsks(
    workspaceId: string,
    hiveSlug: string,
    filter: CrossHiveAsksFilter,
    sql?: Sql,
  ): Promise<CrossHiveAskRow[]>;
}

let registered: CrossHiveAsksStore | null = null;

/**
 * Register the live C-1 store impl (B-02). Called once at boot (or per-test).
 * Idempotent — last write wins.
 */
export function setCrossHiveAsksStore(store: CrossHiveAsksStore): void {
  registered = store;
}

/** TEST helper: clear the registered store so a case starts from a known state. */
export function __resetCrossHiveAsksStore(): void {
  registered = null;
}

/**
 * The live C-1 store. Throws a clear, actionable error when no impl is registered
 * yet (B-02's migration + store has not landed / been wired) rather than silently
 * dropping the asking-side record.
 */
export function getCrossHiveAsksStore(): CrossHiveAsksStore {
  if (!registered) {
    throw new Error(
      'cross_hive_asks store (C-1) is not registered — brief B-02 must land the migration + store and wire setCrossHiveAsksStore() at boot',
    );
  }
  return registered;
}
