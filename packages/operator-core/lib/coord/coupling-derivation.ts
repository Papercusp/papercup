/**
 * coupling-derivation.ts — P-013's DERIVED half of the coupling union.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-013. Scoping ruling: D-078.
 *
 * WHY THIS EXISTS. `resolveCoupledPeers` has always been `derived ∪ declared −
 * suppressed`, but `derived` was hard-coded `[]` at the only call site
 * (presence.ts), so `coord:presence`'s `expanded[]` block could only ever show
 * peers somebody had DECLARED by hand. This computes the derived half.
 *
 * ⚠ IT IS A CONSUMER OF THE UNION, NOT A SECOND COUPLING MECHANISM (D-078 (b)).
 * It returns a value that is passed INTO `resolveCoupledPeers`; it never writes
 * `agent_couplings` (that table is the DECLARED half, owned by coord:couple) and
 * never builds a parallel expansion path. Routing through the union is also what
 * keeps suppression winning: an agent that decoupled a peer stays decoupled even
 * though this derivation re-fires on every read (D-061 R4).
 *
 * ⚠ RE-RANKING ONLY, NEVER WIDENING (D-044, D-078 (c)). Every signal below is
 * computed from the roster rows the caller is ALREADY being sent. There is no
 * second query and no cell read, so this cannot surface a peer the caller could
 * not otherwise observe — the strongest available form of that guarantee, since
 * it holds by construction rather than by an access check that could be wrong.
 * A signal needing data OUTSIDE the caller's roster (a plan `blocked-by` edge, a
 * recent coord exchange) is deliberately NOT here: it needs a bounded query, and
 * that query must route through `getCell(cell, reader)` / `listCells(reader)`
 * rather than the `Unchecked` accessors, or leg C of the D-076 parity gate reds.
 *
 * ⚠ PURE AND TOTAL, like `resolveCoupledPeers` and `buildCoupledExpansion`
 * before it: rows come in as `unknown[]` and are read structurally, so it unit-
 * tests without PG and a malformed row is skipped rather than thrown on. A
 * derivation that throws would take down `coord:presence`, which is a far worse
 * outcome than a missing `expanded[]` entry.
 */
import type { DerivedCoupling } from './couplings';

/** How many overlapping files to NAME before summarising the rest. */
export const DERIVATION_FILES_NAMED = 2;

/** The roster fields this derivation reads. Structural, so any roster row fits. */
export interface DerivationRow {
  ownerId?: string | null;
  fleetSlug?: string | null;
  currentFiles?: readonly string[] | null;
  awaitingEventKey?: string | null;
}

function cleanId(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function fileSet(v: unknown): Set<string> {
  if (!Array.isArray(v)) return new Set();
  const out = new Set<string>();
  for (const f of v) {
    const s = cleanId(f);
    if (s) out.add(s);
  }
  return out;
}

/** Render the shared-file signal, naming a bounded number of paths. */
function sharedFilesPhrase(shared: readonly string[]): string {
  const named = shared.slice(0, DERIVATION_FILES_NAMED);
  const rest = shared.length - named.length;
  const list = named.join(', ');
  return rest > 0
    ? `both working in ${list} (+${rest} more shared ${rest === 1 ? 'file' : 'files'})`
    : `both working in ${list}`;
}

/**
 * Derive coupled peers from the caller's own roster.
 *
 * Emits ONE {@link DerivedCoupling} per (peer, signal) pair — the union
 * accumulates them into a single `derivedBecause` per peer (D-078 (a)), which is
 * why a peer coupled three ways reads "same fleet; both working in x; ..." and
 * not just the first signal that happened to fire.
 *
 * Signal order is fixed (fleet → files → awaited event) and rows are visited in
 * the order given, so two readers with the same roster derive the same string.
 */
export function deriveCouplingsFromRoster(
  selfOwnerId: string,
  rows: readonly unknown[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];

  let selfRow: DerivationRow | undefined;
  const peers: DerivationRow[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) {
      selfRow ??= row;
      continue;
    }
    peers.push(row);
  }
  // No row for the caller ⇒ nothing to compare against. Honest empty, not a throw:
  // a caller outside its own roster is a scope question, not a coupling question.
  if (!selfRow) return [];

  const myFleet = cleanId(selfRow.fleetSlug);
  const myFiles = fileSet(selfRow.currentFiles);
  const myAwait = cleanId(selfRow.awaitingEventKey);

  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const row of peers) {
    const ownerId = cleanId(row.ownerId);
    // A roster can legitimately repeat an ownerId (federated/overlay rows); the
    // first row wins so the derivation stays deterministic.
    if (seen.has(ownerId)) continue;
    seen.add(ownerId);

    if (myFleet && cleanId(row.fleetSlug) === myFleet) {
      out.push({ ownerId, because: `same fleet (${myFleet})` });
    }

    if (myFiles.size > 0) {
      const shared: string[] = [];
      for (const f of fileSet(row.currentFiles)) if (myFiles.has(f)) shared.push(f);
      if (shared.length > 0) {
        shared.sort();
        out.push({ ownerId, because: sharedFilesPhrase(shared) });
      }
    }

    if (myAwait && cleanId(row.awaitingEventKey) === myAwait) {
      out.push({ ownerId, because: `both awaiting ${myAwait}` });
    }
  }
  return out;
}
