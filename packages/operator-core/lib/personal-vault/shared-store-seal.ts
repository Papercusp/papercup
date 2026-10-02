/**
 * Reader-set labels — sealing what a restricted session writes to SHARED WORK
 * STORES. Plan personal-data-reader-set-labels-2026-10-01 P-012 (WI-10005520), D-006.
 *
 * coord-seal.ts seals coord envelopes. The same leak exists in every other store
 * a peer can read: a work-item comment or checkpoint, a fact, a harness/hive
 * memory. While the writer holds an active disclosure, the authored text moves
 * to personal_sealed_contents with a snapshot of the writer's labels, and the
 * shared row keeps only a stub. `personal:open-sealed { store, ref }` opens it
 * through openSealedContent, which labels the opener in the same transaction.
 *
 * Owner-scoped (user) memory is never sealed: only the owner reads it, and the
 * owner is always a permitted reader.
 *
 * Fail closed: a ledger read or seal write that fails refuses the write
 * (disclosure_ledger_unavailable) rather than persisting the text in the clear.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { DisclosureRefused } from './disclosure-ledger';
import { snapshotActiveLabels, storeSealedContent } from './sealed-contents';

type Db = postgres.Sql | postgres.TransactionSql;

/** The shared stores P-012 seals, as recorded in personal_sealed_contents.store. */
export const SHARED_SEAL_STORES = ['work-item-comment', 'work-item-checkpoint', 'fact', 'memory'] as const;
export type SharedSealStore = (typeof SHARED_SEAL_STORES)[number];

export function isSharedSealStore(value: string): value is SharedSealStore {
  return (SHARED_SEAL_STORES as readonly string[]).includes(value);
}

export interface SharedSealParams {
  workspaceId: string | null | undefined;
  /** The agent identity that authored the text; null/blank never seals. */
  writerOwnerId: string | null | undefined;
  store: SharedSealStore;
  text: string;
  /** Pre-chosen ref (e.g. a memory id). Defaults to a fresh uuid. */
  ref?: string;
  /** Non-authored locators saved beside the text (work-item id, fact key, …). */
  context?: Record<string, unknown>;
}

export type SharedSealResult =
  | { sealed: false; text: string }
  | { sealed: true; text: string; store: SharedSealStore; ref: string; labels: number };

/** The call that opens a sealed shared row. */
export function sharedSealOpenCall(store: SharedSealStore, ref: string): string {
  return `personal:open-sealed { store: '${store}', ref: '${ref}' }`;
}

/** What the shared row holds in place of the authored text. */
export function sharedSealStub(params: { store: SharedSealStore; ref: string; writerOwnerId: string; labels: number }): string {
  return (
    `🔒 Sealed: ${params.writerOwnerId} wrote this while holding restricted personal content ` +
    `(${params.labels} labelled document${params.labels === 1 ? '' : 's'}). ` +
    `${sharedSealOpenCall(params.store, params.ref)} opens it and limits your outbound sends the same way.`
  );
}

const SEALED_STUB_RE = /personal:open-sealed \{ store: '([a-z-]+)', ref: '([^']+)' \}/;

/** The store/ref a sealed stub points at, or null for ordinary text. */
export function sharedSealRefOf(text: unknown): { store: SharedSealStore; ref: string } | null {
  if (typeof text !== 'string' || !text.startsWith('🔒 Sealed: ')) return null;
  const match = SEALED_STUB_RE.exec(text);
  if (!match || !isSharedSealStore(match[1])) return null;
  return { store: match[1], ref: match[2] };
}

function concreteWorkspace(workspaceId: string | null | undefined): string | null {
  const ws = workspaceId?.trim();
  return ws && ws !== '*' ? ws : null;
}

/** True when this write can never need a seal, so no ledger read is spent on it. */
function nothingToSeal(params: SharedSealParams): boolean {
  return !params.writerOwnerId?.trim() || !concreteWorkspace(params.workspaceId) || !params.text.trim();
}

/**
 * Seal inside the CALLER's transaction, so the sealed row commits or rolls back
 * with the shared write it replaces. Errors propagate; the caller's transaction
 * aborts and nothing is written in the clear.
 */
export async function sealSharedTextInTx(tx: Db, params: SharedSealParams): Promise<SharedSealResult> {
  if (nothingToSeal(params)) return { sealed: false, text: params.text };
  const workspaceId = concreteWorkspace(params.workspaceId)!;
  const writerOwnerId = params.writerOwnerId!.trim();
  const labels = await snapshotActiveLabels(tx, { workspaceId, agentOwnerId: writerOwnerId });
  if (!labels.length) return { sealed: false, text: params.text };
  const ref = params.ref?.trim() || randomUUID();
  await storeSealedContent(tx, {
    workspaceId,
    store: params.store,
    ref,
    writerOwnerId,
    content: { text: params.text, ...(params.context ? { context: params.context } : {}) },
    labels,
  });
  return {
    sealed: true,
    text: sharedSealStub({ store: params.store, ref, writerOwnerId, labels: labels.length }),
    store: params.store,
    ref,
    labels: labels.length,
  };
}

function ledgerUnavailable(params: SharedSealParams, error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `could not check or seal ${params.writerOwnerId}'s ${params.store} write against its disclosure ledger (${error instanceof Error ? error.message : String(error)}); refusing rather than storing it unsealed`,
  );
}

/**
 * Seal in a short transaction of its own on `sql`, with app.workspace_id set so
 * the ledger read is correct under RLS whichever role the handle connects as.
 * Use it where the shared write happens later in another transaction (a
 * comment's thread post, a memory backend write).
 */
export async function sealSharedText(sql: postgres.Sql, params: SharedSealParams): Promise<SharedSealResult> {
  if (nothingToSeal(params)) return { sealed: false, text: params.text };
  const workspaceId = concreteWorkspace(params.workspaceId)!;
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return sealSharedTextInTx(tx, params);
    })) as SharedSealResult;
  } catch (error) {
    if (error instanceof DisclosureRefused) throw error;
    throw ledgerUnavailable(params, error);
  }
}

/** Wrap an in-transaction seal failure as the same fail-closed refusal. */
export async function sealSharedTextInTxOrRefuse(tx: Db, params: SharedSealParams): Promise<SharedSealResult> {
  try {
    return await sealSharedTextInTx(tx, params);
  } catch (error) {
    if (error instanceof DisclosureRefused) throw error;
    throw ledgerUnavailable(params, error);
  }
}
