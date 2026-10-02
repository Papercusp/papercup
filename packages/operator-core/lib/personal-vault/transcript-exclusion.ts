/**
 * Exclude-at-read for session transcripts.
 * Plan personal-data-reader-set-labels-2026-10-01 P-013 (WI-10005552), D-006 point 3.
 *
 * Papercusp does not WRITE an agent's transcript — the CLI does — so the
 * seal-at-write rule (P-006 / P-012) cannot reach it. Instead every agent-facing
 * read of a transcript (sessions:search, sessions:read, consult routing) runs its
 * turns through this module before returning them:
 *
 *   A turn recorded by agent A at time t is WITHHELD from every caller other than
 *   A when t falls inside one of A's disclosure windows
 *   [delivered_at, released_at) — released windows included, because the content
 *   was in A's context while the window was open.
 *
 * A withheld turn is COUNTED, never silently dropped: each surface reports the
 * tally on its result (`withheldReceipt`).
 *
 * Two fail-closed rules:
 *   - A turn with NO recorded owner cannot be attributed to an agent, so it is
 *     withheld whenever ANY other agent's disclosure window covers its time.
 *     With no disclosures in the ledger this changes nothing.
 *   - If the ledger cannot be read, the read is refused with
 *     `disclosure_ledger_unavailable` rather than served unfiltered.
 *
 * `restrictedTranscriptOwners` is the owner-level form used by consult, whose
 * answer session forks an expert's WHOLE transcript: an expert who has held any
 * disclosure is not a routable transcript source at all.
 */
import type postgres from 'postgres';
import { DisclosureRefused } from './disclosure-ledger';

type Db = postgres.Sql | postgres.TransactionSql;

/** One disclosure window in epoch-ms; `to === null` while the disclosure is active. */
export interface DisclosureWindow {
  from: number;
  to: number | null;
}

/** What a read surface knows about one transcript turn. */
export interface TranscriptTurnStamp {
  /** `session_turns.owner` — the agent identity that recorded the turn. */
  owner: string | null | undefined;
  /** When the turn was recorded: `session_turns.ts`, falling back to `ingested_at`. */
  at: string | Date | null | undefined;
}

export type WithholdReason = 'disclosure-window' | 'unattributed';

export interface WithheldTally {
  turns: number;
  byReason: Record<WithholdReason, number>;
}

export const D006_TRANSCRIPT_RULE =
  "D-006 (personal-data-reader-set-labels): turns another agent recorded while it held personal data " +
  "under a restricted privacy level are withheld from every reader but that agent.";

function toMs(at: string | Date | null | undefined): number | null {
  if (at == null) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function normOwner(owner: string | null | undefined): string | null {
  const trimmed = owner?.trim();
  return trimmed ? trimmed : null;
}

function covers(windows: readonly DisclosureWindow[], at: number | null): boolean {
  if (windows.length === 0) return false;
  // A turn with no time cannot be placed outside a window: fail closed.
  if (at === null) return true;
  return windows.some((w) => at >= w.from && (w.to === null || at < w.to));
}

export function emptyTally(): WithheldTally {
  return { turns: 0, byReason: { 'disclosure-window': 0, unattributed: 0 } };
}

export function addTally(into: WithheldTally, from: WithheldTally): WithheldTally {
  into.turns += from.turns;
  into.byReason['disclosure-window'] += from.byReason['disclosure-window'];
  into.byReason.unattributed += from.byReason.unattributed;
  return into;
}

/** The per-caller decision, built once per read from the ledger. Pure after construction. */
export class TranscriptExclusion {
  constructor(
    private readonly selfOwners: ReadonlySet<string>,
    private readonly windowsByOwner: ReadonlyMap<string, DisclosureWindow[]>,
    /** Every other agent's windows, loaded only when an unattributed turn needs them. */
    private readonly anyOwnerWindows: readonly DisclosureWindow[],
  ) {}

  /** Why this turn is withheld from the caller, or null when it may be shown. */
  withholds(stamp: TranscriptTurnStamp): WithholdReason | null {
    const owner = normOwner(stamp.owner);
    const at = toMs(stamp.at);
    if (owner === null) return covers(this.anyOwnerWindows, at) ? 'unattributed' : null;
    if (this.selfOwners.has(owner)) return null;
    return covers(this.windowsByOwner.get(owner) ?? [], at) ? 'disclosure-window' : null;
  }

  /** Partition `turns`, keeping order. */
  partition<T>(turns: readonly T[], stampOf: (turn: T) => TranscriptTurnStamp): { kept: T[]; withheld: WithheldTally } {
    const kept: T[] = [];
    const withheld = emptyTally();
    for (const turn of turns) {
      const reason = this.withholds(stampOf(turn));
      if (reason === null) {
        kept.push(turn);
      } else {
        withheld.turns += 1;
        withheld.byReason[reason] += 1;
      }
    }
    return { kept, withheld };
  }
}

function ledgerUnavailable(error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `transcript read refused: the disclosure ledger could not be read (${(error as Error)?.message ?? error})`,
  );
}

/**
 * Load the decision for `stamps` as read by a caller whose identities are
 * `selfOwnerIds` (the caller's ownerId, plus its respawn chain when the surface
 * already resolved one). Issues no query when every turn is the caller's own.
 */
export async function loadTranscriptExclusion(
  sql: Db,
  params: { selfOwnerIds: ReadonlyArray<string | null | undefined>; stamps: readonly TranscriptTurnStamp[] },
): Promise<TranscriptExclusion> {
  const selfOwners = new Set(params.selfOwnerIds.map(normOwner).filter((o): o is string => o !== null));
  const owners = new Set<string>();
  let unattributedFrom: number | null = null;
  let unattributedTo: number | null = null;
  let unattributedUntimed = false;
  for (const stamp of params.stamps) {
    const owner = normOwner(stamp.owner);
    if (owner !== null) {
      if (!selfOwners.has(owner)) owners.add(owner);
      continue;
    }
    const at = toMs(stamp.at);
    if (at === null) {
      unattributedUntimed = true;
    } else {
      unattributedFrom = unattributedFrom === null ? at : Math.min(unattributedFrom, at);
      unattributedTo = unattributedTo === null ? at : Math.max(unattributedTo, at);
    }
  }
  const self = [...selfOwners];
  const windowsByOwner = new Map<string, DisclosureWindow[]>();
  const anyOwnerWindows: DisclosureWindow[] = [];
  try {
    if (owners.size > 0) {
      const rows = await sql<Array<{ owner: string; from: Date; to: Date | null }>>`
        SELECT agent_owner_id AS owner, delivered_at AS "from", released_at AS "to"
          FROM harness_shared.personal_disclosures
         WHERE agent_owner_id = ANY(${[...owners]}::text[])`;
      for (const row of rows) {
        const list = windowsByOwner.get(row.owner) ?? [];
        list.push({ from: new Date(row.from).getTime(), to: row.to ? new Date(row.to).getTime() : null });
        windowsByOwner.set(row.owner, list);
      }
    }
    if (unattributedUntimed || unattributedFrom !== null) {
      // An untimed unattributed turn can sit in any window; otherwise only windows
      // overlapping the unattributed turns' time span can cover one.
      const lo = unattributedUntimed ? null : new Date(unattributedFrom!);
      const hi = unattributedUntimed ? null : new Date(unattributedTo!);
      const rows = await sql<Array<{ from: Date; to: Date | null }>>`
        SELECT delivered_at AS "from", released_at AS "to"
          FROM harness_shared.personal_disclosures
         WHERE agent_owner_id <> ALL(${self}::text[])
           AND (${hi}::timestamptz IS NULL OR delivered_at <= ${hi}::timestamptz)
           AND (${lo}::timestamptz IS NULL OR released_at IS NULL OR released_at > ${lo}::timestamptz)`;
      for (const row of rows) {
        anyOwnerWindows.push({ from: new Date(row.from).getTime(), to: row.to ? new Date(row.to).getTime() : null });
      }
    }
  } catch (error) {
    throw ledgerUnavailable(error);
  }
  return new TranscriptExclusion(selfOwners, windowsByOwner, anyOwnerWindows);
}

/** Load the decision and partition `turns` in one call. */
export async function withholdRestrictedTurns<T>(
  sql: Db,
  params: { selfOwnerIds: ReadonlyArray<string | null | undefined> },
  turns: readonly T[],
  stampOf: (turn: T) => TranscriptTurnStamp,
): Promise<{ kept: T[]; withheld: WithheldTally }> {
  if (turns.length === 0) return { kept: [], withheld: emptyTally() };
  const exclusion = await loadTranscriptExclusion(sql, {
    selfOwnerIds: params.selfOwnerIds,
    stamps: turns.map(stampOf),
  });
  return exclusion.partition(turns, stampOf);
}

/**
 * Owners among `owners` who have EVER held a disclosure (active or released).
 * Consult forks a routed expert's whole transcript into its answer session, so a
 * per-turn filter cannot make that fork safe; the expert is withheld instead.
 */
export async function restrictedTranscriptOwners(sql: Db, owners: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(owners.map(normOwner).filter((o): o is string => o !== null))];
  if (wanted.length === 0) return new Set();
  try {
    const rows = await sql<Array<{ owner: string }>>`
      SELECT DISTINCT agent_owner_id AS owner
        FROM harness_shared.personal_disclosures
       WHERE agent_owner_id = ANY(${wanted}::text[])`;
    return new Set(rows.map((row) => row.owner));
  } catch (error) {
    throw ledgerUnavailable(error);
  }
}

/** The receipt a read surface spreads into its result; empty when nothing was withheld. */
export function withheldReceipt(tally: WithheldTally): { withheld?: { restricted_turns: number; unattributed_turns?: number; rule: string } } {
  if (tally.turns === 0) return {};
  return {
    withheld: {
      restricted_turns: tally.turns,
      ...(tally.byReason.unattributed > 0 ? { unattributed_turns: tally.byReason.unattributed } : {}),
      rule: D006_TRANSCRIPT_RULE,
    },
  };
}
