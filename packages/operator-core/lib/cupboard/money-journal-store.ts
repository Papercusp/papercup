/**
 * Postgres persistence for the double-entry money journal
 * (agent-economy-flywheel-2026-08-30 P-042, R-30; schema: migration 1286).
 *
 * The rules are the pure ones in money-journal.ts; this module writes what they
 * accept, atomically:
 *   - postMoneyJournalEntry: one entry and its lines in one transaction,
 *     idempotent on entryId (a byte-identical repeat is a no-op, a different
 *     entry under the same id is refused);
 *   - accrueUsageMicros: one meter accrual into its micros roll-up, idempotent
 *     on the accrual id (the meter nonce);
 *   - settleUsageRollup: the roll-up's whole cents become one usage-settlement
 *     entry and leave the rounding balance, in the same transaction, under a
 *     row lock, so two settlers can never settle the same micros twice.
 * The database repeats the guards that must hold for any writer (append-only
 * history, balance at commit, bigint cents, the roll-up identity as a CHECK).
 *
 * Every committed entry is then witnessed into the P-040 hash chain under the
 * workspace's `money-journal` stream (ledger-chain.ts); a failed witness leaves
 * the entry unchained, which verify reports, and never undoes the posting.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  MICROS_PER_CENT,
  daoShareCents,
  journalEntryForMovement,
  validateJournalEntry,
  type ExternalRef,
  type JournalEntry,
  type JournalLine,
  type JournalRejection,
  type MicrosRollup,
  type MoneyJournalAccount,
  type MovementKind,
} from './money-journal';
import {
  pgLedgerChainLinkStore,
  witnessLedgerAfterAppend,
  type LedgerChainLinkStore,
  type LedgerSource,
} from './ledger-chain';

export const MONEY_JOURNAL_STREAM_ID = 'money-journal';

export interface MoneyJournalStoreDeps {
  readonly sql?: Sql;
  /** Where hash-chain links go; `null` skips witnessing (tests of the store alone). */
  readonly ledgerChain?: LedgerChainLinkStore | null;
}

const db = (deps: MoneyJournalStoreDeps): Sql => deps.sql ?? getOrgPg().sql;

function toSafeInt(value: unknown, what: string): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : (value as number);
  if (!Number.isSafeInteger(n)) throw new Error(`money journal: ${what} = ${String(value)} is not a safe integer`);
  return n;
}

/** The stored form of a reference (the kind is a separate column). */
function storedRef(ref: ExternalRef): string {
  return ref.kind === 'chain-tx' ? `${ref.chainId}:${ref.txHash}` : ref.id;
}

function refFromStored(kind: string, value: string): ExternalRef {
  if (kind === 'chain-tx') {
    const sep = value.indexOf(':');
    return { kind: 'chain-tx', chainId: Number(value.slice(0, sep)), txHash: value.slice(sep + 1) };
  }
  if (kind === 'stripe-balance-transaction' || kind === 'bank-transaction') return { kind, id: value };
  throw new Error(`money journal: unknown external_ref_kind ${kind}`);
}

interface EntryRow {
  entry_id: string;
  occurred_at: Date;
  currency: string;
  movement: string;
  external_ref_kind: string;
  external_ref: string;
  rollup_id: string | null;
  memo: string;
}

interface LineRow {
  entry_id: string;
  line_no: number;
  account: string;
  side: string;
  cents: string | number | bigint;
}

function assemble(rows: readonly EntryRow[], lineRows: readonly LineRow[]): JournalEntry[] {
  const linesByEntry = new Map<string, JournalLine[]>();
  for (const line of [...lineRows].sort((a, b) => a.line_no - b.line_no)) {
    const list = linesByEntry.get(line.entry_id) ?? [];
    list.push({
      account: line.account as MoneyJournalAccount,
      side: line.side as 'debit' | 'credit',
      cents: toSafeInt(line.cents, 'cents'),
    });
    linesByEntry.set(line.entry_id, list);
  }
  return rows.map((row) => ({
    entryId: row.entry_id,
    occurredAtMs: row.occurred_at.getTime(),
    currency: row.currency,
    movement: row.movement as MovementKind,
    externalRef: refFromStored(row.external_ref_kind, row.external_ref),
    rollupId: row.rollup_id,
    memo: row.memo,
    lines: linesByEntry.get(row.entry_id) ?? [],
  }));
}

/** Every entry of the workspace's journal, in posting order. */
export async function readMoneyJournalEntries(workspaceId: string, deps: MoneyJournalStoreDeps = {}): Promise<JournalEntry[]> {
  const sql = db(deps);
  const rows = await sql<EntryRow[]>`
    SELECT entry_id, occurred_at, currency, movement, external_ref_kind, external_ref, rollup_id, memo
      FROM harness_shared.money_journal_entries
     WHERE workspace_id = ${workspaceId}
     ORDER BY posting_seq`;
  const lines = await sql<LineRow[]>`
    SELECT entry_id, line_no, account, side, cents
      FROM harness_shared.money_journal_lines
     WHERE workspace_id = ${workspaceId}`;
  return assemble(rows, lines);
}

/** The workspace's journal as a hash-chain ledger source (fold order = posting order). */
export function moneyJournalLedgerSource(workspaceId: string, deps: MoneyJournalStoreDeps = {}): LedgerSource {
  return {
    streamId: MONEY_JOURNAL_STREAM_ID,
    async list() {
      const entries = await readMoneyJournalEntries(workspaceId, deps);
      return entries.map((entry) => ({ sourceId: entry.entryId, entry }));
    },
  };
}

async function witness(workspaceId: string, deps: MoneyJournalStoreDeps): Promise<void> {
  const chain = deps.ledgerChain === undefined ? pgLedgerChainLinkStore(deps.sql) : deps.ledgerChain;
  if (chain) await witnessLedgerAfterAppend(workspaceId, moneyJournalLedgerSource(workspaceId, deps), chain);
}

function canonicalEntry(entry: JournalEntry): string {
  return JSON.stringify({
    entryId: entry.entryId,
    occurredAtMs: entry.occurredAtMs,
    currency: entry.currency,
    movement: entry.movement,
    externalRef: entry.externalRef,
    rollupId: entry.rollupId,
    memo: entry.memo,
    lines: entry.lines.map((l) => ({ account: l.account, side: l.side, cents: l.cents })),
  });
}

type Tx = Sql;

async function insertEntry(tx: Tx, workspaceId: string, entry: JournalEntry): Promise<void> {
  await tx`
    INSERT INTO harness_shared.money_journal_entries
      (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref, rollup_id, memo)
    VALUES (${workspaceId}, ${entry.entryId}, ${new Date(entry.occurredAtMs)}, ${entry.currency}, ${entry.movement},
            ${entry.externalRef.kind}, ${storedRef(entry.externalRef)}, ${entry.rollupId}, ${entry.memo})`;
  for (const [lineNo, line] of entry.lines.entries()) {
    await tx`
      INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
      VALUES (${workspaceId}, ${entry.entryId}, ${lineNo}, ${line.account}, ${line.side}, ${line.cents})`;
  }
}

async function existingEntry(tx: Tx, workspaceId: string, entryId: string): Promise<JournalEntry | null> {
  const rows = await tx<EntryRow[]>`
    SELECT entry_id, occurred_at, currency, movement, external_ref_kind, external_ref, rollup_id, memo
      FROM harness_shared.money_journal_entries
     WHERE workspace_id = ${workspaceId} AND entry_id = ${entryId}`;
  if (rows.length === 0) return null;
  const lines = await tx<LineRow[]>`
    SELECT entry_id, line_no, account, side, cents
      FROM harness_shared.money_journal_lines
     WHERE workspace_id = ${workspaceId} AND entry_id = ${entryId}`;
  return assemble(rows, lines)[0] ?? null;
}

export type StorePostResult =
  | { ok: true; entry: JournalEntry; duplicate: boolean }
  | JournalRejection
  | { ok: false; code: 'entry-id-conflict'; detail: string };

/** Validate and post one entry. Idempotent on entryId. */
export async function postMoneyJournalEntry(
  input: { readonly workspaceId: string; readonly entry: unknown },
  deps: MoneyJournalStoreDeps = {},
): Promise<StorePostResult> {
  const validated = validateJournalEntry(input.entry);
  if (!validated.ok) return validated;
  const entry = validated.entry;
  const outcome = await db(deps).begin(async (tx) => {
    const prior = await existingEntry(tx as unknown as Tx, input.workspaceId, entry.entryId);
    if (prior) return canonicalEntry(prior) === canonicalEntry(entry) ? ('duplicate' as const) : ('conflict' as const);
    await insertEntry(tx as unknown as Tx, input.workspaceId, entry);
    return 'posted' as const;
  });
  if (outcome === 'conflict') {
    return { ok: false, code: 'entry-id-conflict', detail: `entry ${entry.entryId} is already posted with different content` };
  }
  if (outcome === 'posted') await witness(input.workspaceId, deps);
  return { ok: true, entry, duplicate: outcome === 'duplicate' };
}

interface RollupRow {
  rollup_id: string;
  currency: string;
  total_micros: string | number | bigint;
  settled_cents: string | number | bigint;
  rounding_micros: string | number | bigint;
}

function rollupFromRow(row: RollupRow, accrualIds: readonly string[]): MicrosRollup {
  return {
    rollupId: row.rollup_id,
    currency: row.currency,
    totalMicros: toSafeInt(row.total_micros, 'total_micros'),
    settledCents: toSafeInt(row.settled_cents, 'settled_cents'),
    roundingMicros: toSafeInt(row.rounding_micros, 'rounding_micros'),
    accrualIds: new Set(accrualIds),
  };
}

export async function readMicrosRollup(
  workspaceId: string,
  rollupId: string,
  deps: MoneyJournalStoreDeps = {},
): Promise<MicrosRollup | null> {
  const sql = db(deps);
  const rows = await sql<RollupRow[]>`
    SELECT rollup_id, currency, total_micros, settled_cents, rounding_micros
      FROM harness_shared.money_journal_rollups
     WHERE workspace_id = ${workspaceId} AND rollup_id = ${rollupId}`;
  if (rows.length === 0) return null;
  const accruals = await sql<{ accrual_id: string }[]>`
    SELECT accrual_id FROM harness_shared.money_journal_micro_accruals
     WHERE workspace_id = ${workspaceId} AND rollup_id = ${rollupId}`;
  return rollupFromRow(rows[0]!, accruals.map((a) => a.accrual_id));
}

export type AccrueStoreResult =
  | { ok: true; duplicate: boolean; totalMicros: number; roundingMicros: number }
  | { ok: false; code: 'invalid-micros' | 'invalid-rollup' | 'currency-mismatch'; detail: string };

/** Accrue one per-use charge (micros) into its roll-up. Idempotent on accrualId. */
export async function accrueUsageMicros(
  input: {
    readonly workspaceId: string;
    readonly rollupId: string;
    readonly accrualId: string;
    readonly micros: number;
    readonly currency?: string;
  },
  deps: MoneyJournalStoreDeps = {},
): Promise<AccrueStoreResult> {
  const currency = input.currency ?? 'USD';
  if (!Number.isSafeInteger(input.micros) || input.micros <= 0) {
    return { ok: false, code: 'invalid-micros', detail: `micros must be a positive whole number, got ${String(input.micros)}` };
  }
  if (input.rollupId.length === 0 || input.rollupId.length > 256 || input.accrualId.length === 0 || input.accrualId.length > 256) {
    return { ok: false, code: 'invalid-rollup', detail: 'rollupId and accrualId must be 1-256 characters' };
  }
  return db(deps).begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.money_journal_rollups (workspace_id, rollup_id, currency)
      VALUES (${input.workspaceId}, ${input.rollupId}, ${currency})
      ON CONFLICT (workspace_id, rollup_id) DO NOTHING`;
    const [rollup] = await tx<RollupRow[]>`
      SELECT rollup_id, currency, total_micros, settled_cents, rounding_micros
        FROM harness_shared.money_journal_rollups
       WHERE workspace_id = ${input.workspaceId} AND rollup_id = ${input.rollupId}
       FOR UPDATE`;
    if (!rollup) throw new Error('money journal: roll-up row vanished inside its own transaction');
    if (rollup.currency !== currency) {
      return { ok: false, code: 'currency-mismatch', detail: `roll-up ${input.rollupId} is in ${rollup.currency}` } as const;
    }
    const inserted = await tx`
      INSERT INTO harness_shared.money_journal_micro_accruals (workspace_id, rollup_id, accrual_id, micros)
      VALUES (${input.workspaceId}, ${input.rollupId}, ${input.accrualId}, ${input.micros})
      ON CONFLICT (workspace_id, rollup_id, accrual_id) DO NOTHING
      RETURNING accrual_id`;
    if (inserted.length === 0) {
      return {
        ok: true,
        duplicate: true,
        totalMicros: toSafeInt(rollup.total_micros, 'total_micros'),
        roundingMicros: toSafeInt(rollup.rounding_micros, 'rounding_micros'),
      } as const;
    }
    const [updated] = await tx<RollupRow[]>`
      UPDATE harness_shared.money_journal_rollups
         SET total_micros = total_micros + ${input.micros},
             rounding_micros = rounding_micros + ${input.micros},
             updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND rollup_id = ${input.rollupId}
       RETURNING rollup_id, currency, total_micros, settled_cents, rounding_micros`;
    return {
      ok: true,
      duplicate: false,
      totalMicros: toSafeInt(updated!.total_micros, 'total_micros'),
      roundingMicros: toSafeInt(updated!.rounding_micros, 'rounding_micros'),
    } as const;
  });
}

export type SettleStoreResult =
  | { ok: true; settledCents: number; roundingMicros: number; entry: JournalEntry | null; duplicate: boolean }
  | JournalRejection
  | { ok: false; code: 'unknown-rollup' | 'entry-id-conflict'; detail: string };

/**
 * Settle the roll-up's whole cents into the journal as one usage-settlement
 * entry; the sub-cent residue stays in rounding_micros. Idempotent on entryId.
 */
export async function settleUsageRollup(
  input: {
    readonly workspaceId: string;
    readonly rollupId: string;
    readonly entryId: string;
    readonly occurredAtMs: number;
    readonly externalRef: ExternalRef;
    readonly daoBasisPoints: number;
    readonly memo?: string;
  },
  deps: MoneyJournalStoreDeps = {},
): Promise<SettleStoreResult> {
  const result = await db(deps).begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const [rollup] = await tx<RollupRow[]>`
      SELECT rollup_id, currency, total_micros, settled_cents, rounding_micros
        FROM harness_shared.money_journal_rollups
       WHERE workspace_id = ${input.workspaceId} AND rollup_id = ${input.rollupId}
       FOR UPDATE`;
    if (!rollup) return { ok: false, code: 'unknown-rollup', detail: `no roll-up ${input.rollupId}` } as const;
    const prior = await existingEntry(tx, input.workspaceId, input.entryId);
    const roundingMicros = toSafeInt(rollup.rounding_micros, 'rounding_micros');
    if (prior) {
      if (prior.rollupId !== input.rollupId) {
        return { ok: false, code: 'entry-id-conflict', detail: `entry ${input.entryId} settles a different roll-up` } as const;
      }
      return { ok: true, settledCents: 0, roundingMicros, entry: prior, duplicate: true } as const;
    }
    const cents = Math.floor(roundingMicros / MICROS_PER_CENT);
    if (cents === 0) return { ok: true, settledCents: 0, roundingMicros, entry: null, duplicate: false } as const;
    const built = journalEntryForMovement({
      entryId: input.entryId,
      occurredAtMs: input.occurredAtMs,
      currency: rollup.currency,
      externalRef: input.externalRef,
      memo: input.memo ?? '',
      rollupId: input.rollupId,
      movement: { kind: 'usage-settlement', cents, daoCents: daoShareCents(cents, input.daoBasisPoints) },
    });
    if (!built.ok) return built;
    await insertEntry(tx, input.workspaceId, built.entry);
    const [updated] = await tx<RollupRow[]>`
      UPDATE harness_shared.money_journal_rollups
         SET settled_cents = settled_cents + ${cents},
             rounding_micros = rounding_micros - ${cents * MICROS_PER_CENT},
             updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND rollup_id = ${input.rollupId}
       RETURNING rollup_id, currency, total_micros, settled_cents, rounding_micros`;
    return {
      ok: true,
      settledCents: cents,
      roundingMicros: toSafeInt(updated!.rounding_micros, 'rounding_micros'),
      entry: built.entry,
      duplicate: false,
    } as const;
  });
  if (result.ok && result.entry && !result.duplicate) await witness(input.workspaceId, deps);
  return result;
}
