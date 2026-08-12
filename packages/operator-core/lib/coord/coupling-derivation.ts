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
 * ⚠ RE-RANKING ONLY, NEVER WIDENING (D-044, D-078 (c)). `deriveCouplingsFromRoster`
 * is computed purely from roster rows the caller is ALREADY being sent, so it
 * cannot surface a peer the caller could not otherwise observe — a guarantee that
 * holds BY CONSTRUCTION rather than by an access check that could be wrong.
 *
 * The QUERYING signals below (lock holds, plan `blocked-by`, recent coord
 * exchange) keep that property by a different route: each reads only things the
 * caller can ALREADY read — locks in its own coordination domain, its OWN plan's
 * item graph, its OWN messages — and each is keyed to a peer that must ALSO be
 * in the caller's roster to be emitted. No signal can introduce an ownerId the
 * roster did not already contain; see `deriveCouplings`.
 *
 * On D-078 (c) specifically: that ruling binds any CELL-backed input to
 * `getCell(cell, reader)` / `listCells(reader)` rather than the `Unchecked`
 * accessors. This derivation reads no cells at all — not a workaround but the
 * strongest form of compliance, and stated explicitly so a reviewer does not
 * read the absence of a `getCell` call as the ruling being ignored. Should a
 * signal ever need registry data, it MUST take the checked reader path or leg C
 * of the D-076 parity gate reds.
 *
 * ⚠ PURE AND TOTAL, like `resolveCoupledPeers` and `buildCoupledExpansion`
 * before it: rows come in as `unknown[]` and are read structurally, so it unit-
 * tests without PG and a malformed row is skipped rather than thrown on. A
 * derivation that throws would take down `coord:presence`, which is a far worse
 * outcome than a missing `expanded[]` entry.
 */
import type { DerivedCoupling } from './couplings';
import { censusDerivedSignals, type DerivedSignalCensus } from './derived-signal-census';

/**
 * ⚠ EVERY EMIT SITE BELOW SETS BOTH `relation` AND `because`, FROM THE SAME
 * BRANCH (D-087). The typed token is not extra bookkeeping bolted on next to the
 * prose — it is the value the branch already knew and used to be discarded:
 * every `out.push` here sits inside an `if` that has ALREADY decided which signal
 * fired, and then threw that decision away into a sentence. The rule for a new
 * signal: add its token to `DERIVED_COUPLING_RELATIONS`, and never render prose
 * for a signal that has no token — an untyped signal is invisible to the
 * divergence check while still looking fine to a human reading `expanded[]`.
 */

/** How many overlapping LOCK HOLDS to name before summarising the rest. */
export const DERIVATION_LOCKS_NAMED = 2;

/** The roster fields this derivation reads. Structural, so any roster row fits.
 *
 *  Every field here is a REAL emitted roster field — `PRESENCE_IDENTITY_FIELDS` /
 *  `PRESENCE_STATE_FIELDS` in presence-payload.ts. That is asserted by a contract
 *  test (coupling-derivation.test.ts) rather than left to review, because this
 *  interface is structural: a typo or a renamed producer field would still
 *  typecheck and every hand-built fixture would still pass. */
export interface DerivationRow {
  ownerId?: string | null;
  fleetSlug?: string | null;
  awaitingEventKey?: string | null;
  currentPlanSlug?: string | null;
  claimedItems?: readonly string[] | null;
  /** Plan-QUALIFIED (`<slug>#<item>`) occupancy from held, non-terminal work-items —
   *  see {@link planItemsHeldOn}. Produced by presence-tier1, emitted in the STATE
   *  lane. */
  claimedPlanItemRefs?: readonly string[] | null;
}

/** Split a `<plan_slug>#<item_id>` occupancy ref. The producer builds these with
 *  `planItemRef`; this is the only place that takes one apart, so the format has
 *  exactly two sites and a test pins them to each other.
 *
 *  Splits on the FIRST `#`: plan slugs never contain one, and splitting last would
 *  mis-parse an item id that did. */
function splitPlanItemRef(ref: string): { plan: string; item: string } | null {
  const at = ref.indexOf('#');
  if (at <= 0 || at === ref.length - 1) return null;
  return { plan: ref.slice(0, at), item: ref.slice(at + 1) };
}

/**
 * Every plan item this row occupies ON `planSlug`, from BOTH surfaces that record
 * occupancy — the union that makes this signal reachable at all.
 *
 * `claimedItems` (from `plan_item_claims`) holds PLAN-LOCAL ids, so it counts only
 * when the row's declared `currentPlanSlug` IS this plan — a bare `P-003` compared
 * across plans is an identifier collision, not a match.
 *
 * `claimedPlanItemRefs` (from held work-items' `payload.plan_item` stamp) is already
 * plan-qualified, so it needs no declared plan and CANNOT collide. That is why a peer
 * counts as being on this plan through work it holds here even when it declares a
 * different `currentPlanSlug` — a strictly safer match than the declaration, since
 * holding the work is the stronger evidence.
 *
 * ⚠ EI-20200393414409502: keying this to `plan_item_claims` ALONE is what made
 * `blocks-me`/`blocked-by-me` unfirable. Fleet-wide, 31 agents held work-items and 5
 * held live plan-item claims; NO plan had the two co-holders the signal required, so
 * it censused a permanent, error-free zero — indistinguishable from "this never
 * happens" — while 6 plans had co-located agents and blocked items.
 */
function planItemsHeldOn(row: DerivationRow | undefined, planSlug: string): Set<string> {
  const out = new Set<string>();
  if (!row || !planSlug) return out;
  if (cleanId(row.currentPlanSlug) === planSlug) {
    for (const item of itemList(row.claimedItems)) out.add(item);
  }
  for (const ref of itemList(row.claimedPlanItemRefs)) {
    const parsed = splitPlanItemRef(ref);
    if (parsed && parsed.plan === planSlug) out.add(parsed.item);
  }
  return out;
}

/** One `blocked-by` edge within a single plan: `item` cannot start until each of
 *  `blockedBy` is done. Mirrors `PlanItem.blockedBy` (libs/generic/plan-parser). */
export interface PlanBlockingEdge {
  item: string;
  blockedBy: readonly string[];
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

/**
 * Derive coupled peers from the caller's own roster.
 *
 * Emits ONE {@link DerivedCoupling} per (peer, signal) pair — the union
 * accumulates them into a single `derivedBecause` per peer (D-078 (a)), which is
 * why a peer coupled three ways reads "same fleet; both working in x; ..." and
 * not just the first signal that happened to fire.
 *
 * Rows are visited in the order given, so two readers with the same roster
 * derive the same string.
 *
 * ⛔ NO `shared-file` EDGE HERE — the `currentFiles` signal was REMOVED
 * 2026-08-10 (D-093) after measuring ZERO shared-file edges across 14 days of
 * production divergence stamps. It was never a bug, just permanently starved:
 * `current_files` is populated ONLY by an explicit
 * `coord:declare-intent { current_files }`, and every declare that OMITS the arg
 * RESETS it to `[]`, so measured live 2026-07-27 (EI-18772330418885814) 119 live
 * presence rows carried ZERO non-empty `current_files`. A live FILE LOCK is the
 * strongest, and the only AUTOMATIC, "this agent is on this file" signal there
 * is, so `deriveCouplingsFromHeldFiles` fully supersedes it. Keeping a signal
 * that cannot fire is not free: it sat in the dead-signal census forever, where
 * a permanently-starved leg is indistinguishable from a newly-broken one.
 *
 * ⚠ THE ROSTER FIELD `current_files` ITSELF STAYS — do not "finish the job" by
 * removing it (D-095). It has a real writer (session-brief.ts) and live
 * consumers (adv-roster.ts, agent-orders-notify.ts). Only the COUPLING SIGNAL
 * derived from it is gone. The comment this file used to carry — "populated only
 * by explicit declare-intent, 119 live rows zero populated" — is a statement
 * about AGENTS not populating the field, NOT about the code lacking a writer,
 * and it was misread as the latter once already.
 *
 * The general lesson, since it nearly shipped silently here: a green unit test
 * over hand-built fixtures cannot distinguish "field is wrong" from "field is
 * real but always empty" — both pass. Only a check against the PRODUCER can.
 */
/**
 * THE BINDING INPUT OF THE `awaits` LEG — how many peers this run could actually
 * have matched, which is ZERO whenever the caller is not itself awaiting anything.
 *
 * ── WHY THIS EXISTS (EI-20088486454213771) ──────────────────────────────────
 *
 * The census used to report this leg's `inputs` as the PEER ROW COUNT, while the
 * computation is decided by a SELF-side field before the peer loop begins:
 * `myAwait` empty ⇒ zero edges however many peers there are. So a short-circuited
 * run published "armed, 1023 inputs, 0 edges", which reads unambiguously as *we
 * compared 1023 candidates and rejected them all* — a predicate-bug signature.
 * That exact number sent three separate readings hunting a phantom bug in correct
 * code before each was refuted by reading the writer.
 *
 * The verdict vocabulary in `check-derived-signal-firings.mjs` could ALREADY tell
 * the two cases apart — `starved` (consulted, input empty: nothing was evaluated)
 * versus `armed-silent` (had input, emitted nothing: a true negative). It was
 * simply being fed a number that made a starved run look armed-silent. So the
 * repair is to count the input that BINDS, not to add a verdict.
 *
 * GENERAL RULE THIS INSTANTIATES: a metric that counts the candidates a
 * computation WOULD have examined, without recording whether it examined any,
 * cannot distinguish a true negative from a skipped evaluation — and a reader
 * resolves that ambiguity toward the alarming reading every time.
 */
export function awaitsBindingInputs(selfOwnerId: string, rows: readonly unknown[]): number {
  const self = cleanId(selfOwnerId);
  if (!self) return 0;
  let myAwait = '';
  const peers = new Set<string>();
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) {
      // First self row wins, matching the derivation's own `selfRow ??=`.
      if (!myAwait) myAwait = cleanId(row.awaitingEventKey);
      continue;
    }
    peers.add(id);
  }
  // The self-side precondition decides the run BEFORE any peer is examined, so an
  // empty key means nothing was measured — not that every peer was rejected.
  return myAwait ? peers.size : 0;
}

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

  // ⚠ EARLY-RETURN THROUGH THE CENSUS'S OWN COUNTER, ON PURPOSE — do not inline
  // this back into the loop guard. Routing both through `awaitsBindingInputs`
  // makes "the census recorded 0 inputs" and "this leg could not emit" the SAME
  // fact rather than two facts that agree until someone edits one of them
  // (EI-20088486454213771). See that helper for the defect it repairs.
  if (awaitsBindingInputs(self, rows) === 0) return [];

  const myAwait = cleanId(selfRow.awaitingEventKey);

  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const row of peers) {
    const ownerId = cleanId(row.ownerId);
    // A roster can legitimately repeat an ownerId (federated/overlay rows); the
    // first row wins so the derivation stays deterministic.
    if (seen.has(ownerId)) continue;
    seen.add(ownerId);

    // ⛔ NO `same-fleet` EDGE HERE — D-054 cut it and this file emitted it anyway for 12 days.
    // Do not "restore the missing fleet signal": fleet membership is already on every roster
    // row as `fleetSlug`, so deriving an edge from it buys volume and no information. See
    // DERIVED_COUPLING_RELATIONS for the measured blast radius (18-member fleet ⇒ 306 edges).

    if (myAwait && cleanId(row.awaitingEventKey) === myAwait) {
      out.push({ ownerId, relation: 'awaits', because: `both awaiting ${myAwait}` });
    }
  }
  return out;
}

/** Render the lock-overlap signal, naming a bounded number of paths. */
function sharedLocksPhrase(shared: readonly string[]): string {
  const named = shared.slice(0, DERIVATION_LOCKS_NAMED);
  const rest = shared.length - named.length;
  const list = named.join(', ');
  return rest > 0
    ? `you both hold locks in ${list} (+${rest} more shared ${rest === 1 ? 'path' : 'paths'})`
    : `you both hold locks in ${list}`;
}

/**
 * THE FILE SIGNAL THAT ACTUALLY FIRES: overlapping live LOCK HOLDS.
 *
 * D-078's item text names "overlapping/adjacent lock holds", and this is it —
 * the automatic signal `current_files` was supposed to be but is not (see
 * `deriveCouplingsFromRoster`'s note). Pure over an INJECTED map so it unit-tests
 * without the lock DB; `fetchPresenceHeldFiles` supplies it in production.
 *
 * NEVER WIDENS: it emits only ownerIds already present in `held`, which the
 * caller's own presence read produced, restricted to its own coordination domain.
 */
/**
 * THE BINDING INPUT OF THE `holds-a-lock-on` LEG — peers whose holds this run
 * could actually have overlapped, which is ZERO whenever the caller holds no
 * files of its own.
 *
 * Same defect and same repair as {@link awaitsBindingInputs}, which carries the
 * full rationale. Two distinct ways the old `held.size` misreported:
 *
 *   · the caller holding NOTHING short-circuits before the loop, yet every
 *     peer's map entry was still counted as an examined input;
 *   · `held` contains the CALLER's own entry, so a run where only the caller
 *     held locks reported `inputs: 1` — an examined-and-rejected reading of a
 *     comparison that had no candidate in it at all.
 */
export function heldFilesBindingInputs(
  selfOwnerId: string,
  held: ReadonlyMap<string, readonly string[]>,
): number {
  const self = cleanId(selfOwnerId);
  if (!self) return 0;
  // The caller's own holds are what every comparison is made AGAINST; with none,
  // the run is decided before any peer is examined.
  if (fileSet(held.get(self) ?? []).size === 0) return 0;
  let peers = 0;
  for (const [rawId] of held) {
    const id = cleanId(rawId);
    if (id && id !== self) peers += 1;
  }
  return peers;
}

export function deriveCouplingsFromHeldFiles(
  selfOwnerId: string,
  held: ReadonlyMap<string, readonly string[]>,
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];
  // Early-return through the census's own counter — see `awaitsBindingInputs`.
  if (heldFilesBindingInputs(self, held) === 0) return [];
  const mine = fileSet(held.get(self) ?? []);
  if (mine.size === 0) return [];

  const out: DerivedCoupling[] = [];
  for (const [rawId, paths] of held) {
    const ownerId = cleanId(rawId);
    if (!ownerId || ownerId === self) continue;
    const shared: string[] = [];
    for (const p of fileSet(paths)) if (mine.has(p)) shared.push(p);
    if (shared.length === 0) continue;
    shared.sort();
    out.push({ ownerId, relation: 'holds-a-lock-on', because: sharedLocksPhrase(shared) });
  }
  // Map iteration order is insertion order, which the caller controls; sort so the
  // derived string is identical for two readers with the same holds (D-006).
  out.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return out;
}

/**
 * Plan `blocked-by` edges — the dependency signal, and the only one here that is
 * DIRECTIONAL. Both directions are emitted because they mean opposite things to
 * the reader: a peer holding what blocks you is who to CHASE; a peer blocked on
 * what you hold is who is waiting on YOU. The second is the more actionable and
 * the one an agent is least likely to discover on its own.
 *
 * Scoped to a single plan — `edges` are the caller's OWN plan's item graph, which
 * the caller can already read, and a peer is considered only when the roster says
 * it is working that same plan. Pure over injected edges, so no PG in tests.
 */
export function deriveCouplingsFromPlanBlocking(
  selfOwnerId: string,
  rows: readonly unknown[],
  edges: readonly PlanBlockingEdge[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self || edges.length === 0) return [];

  let selfRow: DerivationRow | undefined;
  const peers: DerivationRow[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) selfRow ??= row;
    else peers.push(row);
  }
  if (!selfRow) return [];

  // The plan under comparison still comes from the caller's DECLARATION, so exactly
  // one plan's edges are ever read. Widening `myPlan` to every plan the caller holds
  // stamped work on would multiply the expensive plan read — the cost this signal is
  // gated on — for a case the declaration already covers (43 agents declare a plan).
  const myPlan = cleanId(selfRow.currentPlanSlug);
  if (!myPlan) return [];
  const myItems = planItemsHeldOn(selfRow, myPlan);
  if (myItems.size === 0) return [];

  /** item → the items it is blocked BY. */
  const blockedBy = new Map<string, Set<string>>();
  for (const e of edges) {
    const item = cleanId(e.item);
    if (!item) continue;
    const deps = new Set(itemList(e.blockedBy));
    if (deps.size > 0) blockedBy.set(item, deps);
  }

  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const row of peers) {
    const ownerId = cleanId(row.ownerId);
    if (seen.has(ownerId)) continue;
    // Same plan only: a `blocked-by` id is plan-local, so comparing it against an
    // item claimed on a DIFFERENT plan would couple two agents over a collision of
    // identifiers ("P-003") that mean unrelated things. `planItemsHeldOn` IS that
    // scoping now — it admits a peer's plan-local `claimedItems` only when the peer
    // declares this same plan, and admits its work-item occupancy only through refs
    // already qualified with this plan. So the guard moved INTO the helper; it did
    // not go away, and a peer on another plan still yields an empty set here.
    const theirItems = [...planItemsHeldOn(row, myPlan)].sort();
    if (theirItems.length === 0) continue;
    seen.add(ownerId);

    for (const mineItem of [...myItems].sort()) {
      const deps = blockedBy.get(mineItem);
      if (!deps) continue;
      for (const t of theirItems) {
        if (deps.has(t)) {
          out.push({
            ownerId,
            relation: 'blocks-me',
            because: `your ${mineItem} is blocked by ${t}, which they hold`,
          });
        }
      }
    }
    for (const t of [...theirItems].sort()) {
      const deps = blockedBy.get(t);
      if (!deps) continue;
      for (const mineItem of myItems) {
        if (deps.has(mineItem)) {
          out.push({
            ownerId,
            relation: 'blocked-by-me',
            because: `their ${t} is blocked by ${mineItem}, which you hold`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Recent DIRECTED coord exchange.
 *
 * ⚠ BROADCASTS ARE EXCLUDED AT THE SOURCE, and that exclusion is the whole design
 * of this signal. A `to:['*']` message reaches the entire fleet, so counting it as
 * an exchange would couple every agent to every other after a single broadcast —
 * turning `expanded[]` from a relevance signal into a roster copy and making
 * `expandedBecause` meaningless. Only a message naming a concrete counterpart
 * says these two agents are actually working together.
 *
 * Pure over an injected partner list (already deduped + broadcast-filtered by the
 * source), keyed to the roster by the caller in `deriveCouplings`.
 */
export function deriveCouplingsFromCoordExchange(
  selfOwnerId: string,
  partnerIds: readonly string[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];
  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const raw of partnerIds) {
    const ownerId = cleanId(raw);
    if (!ownerId || ownerId === self || seen.has(ownerId)) continue;
    seen.add(ownerId);
    out.push({ ownerId, relation: 'coord-exchange', because: 'recent coord exchange' });
  }
  out.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return out;
}

/** Normalize a claimed-items / blocked-by list to clean ids. */
function itemList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = cleanId(x);
    if (s) out.push(s);
  }
  return out;
}

/** The bounded, caller-scoped reads the querying signals need. Each is OPTIONAL:
 *  an unavailable source degrades that one signal, never the whole derivation. */
export interface CouplingDerivationSources {
  /** ownerId → live lock paths, for the roster's own agents. */
  heldFiles?: () => Promise<ReadonlyMap<string, readonly string[]>>;
  /** The caller's OWN plan's `blocked-by` graph. */
  planEdges?: (planSlug: string) => Promise<readonly PlanBlockingEdge[]>;
  /** Concrete peers the caller exchanged DIRECTED messages with recently. */
  recentPartners?: () => Promise<readonly string[]>;
  /**
   * P-007 — the DEAD-SIGNAL CENSUS sink. Optional and fail-soft: a caller that
   * wires it gets one `DerivedSignalCensus` per run (see derived-signal-census.ts
   * for why `armed` is recorded separately from `edges`); a caller that does not
   * changes nothing. Never let it affect the derivation's result — an observer
   * that can alter or break what it observes is worse than no observer.
   */
  observe?: (census: DerivedSignalCensus) => void;
}

/**
 * THE ORCHESTRATOR: the pure roster derivation ∪ the querying signals.
 *
 * FAIL-SOFT PER LEG, deliberately: each source is awaited independently and a
 * thrown/rejected one contributes nothing while the others still land. A single
 * dead source must not cost the reader every OTHER signal — and none of them may
 * cost it the roster, which is why `coord:presence` also wraps the whole call.
 *
 * ⚠ THE ROSTER IS THE ACCESS BOUNDARY. Every derived edge is filtered to ownerIds
 * present in `rows` before it is returned. The querying sources are already
 * caller-scoped, so this is belt-and-braces — but it is what makes "coupling may
 * re-rank what a reader can already see and may never widen it" (D-044 / D-078
 * (c)) true STRUCTURALLY for the querying half, exactly as purity makes it true
 * for the roster half, instead of resting on each source staying well-behaved.
 */
export async function deriveCouplings(
  selfOwnerId: string,
  rows: readonly unknown[],
  sources: CouplingDerivationSources = {},
): Promise<DerivedCoupling[]> {
  const self = cleanId(selfOwnerId);
  if (!self) return [];

  const inRoster = new Set<string>();
  let selfRow: DerivationRow | undefined;
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    inRoster.add(id);
    if (id === self) selfRow ??= row;
  }

  const settle = async <T>(f: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!f) return fallback;
    try {
      return await f();
    } catch {
      return fallback;
    }
  };

  // The plan read is the EXPENSIVE leg — `readPlanBySlug` fetches and PARSES a
  // whole plan, and plans in this repo reach 90KB+ of prose. So it is gated on a
  // precondition computed purely from rows already in hand: the signal can only
  // fire if the caller claims items on a plan AND some peer in the roster is on
  // that same plan holding items of its own. In the common case (nobody else on
  // your plan) the read never happens at all, rather than being paid on every
  // poll to produce nothing — the P-013 analogue of the per-process fleet-wide
  // recomputation costed in WI-6126.
  //
  // ⚠ THE PEER CONDITION STAYS (D-004). EI-20200393414409502 made this precondition
  // unsatisfiable fleet-wide, and the tempting one-line "fix" is to drop the peer
  // clause so a lone claimant triggers the read. That would put the 90KB+ plan parse
  // back on the common path — the cost argument above is still sound. What was wrong
  // was never the SHAPE of the gate, only the narrow surface it measured occupancy
  // on: `plan_item_claims` alone, while the fleet records its work in work-items.
  // `planItemsHeldOn` reads both, so the same two-holder gate is now REACHABLE
  // instead of being a permanent false.
  const myPlan = cleanId(selfRow?.currentPlanSlug);
  let planSignalPossible = false;
  if (myPlan && planItemsHeldOn(selfRow, myPlan).size > 0) {
    for (const raw of rows) {
      const row = (raw ?? {}) as DerivationRow;
      const id = cleanId(row.ownerId);
      if (!id || id === self) continue;
      if (planItemsHeldOn(row, myPlan).size > 0) {
        planSignalPossible = true;
        break;
      }
    }
  }

  const [held, partners, edges] = await Promise.all([
    settle(sources.heldFiles, new Map<string, readonly string[]>() as ReadonlyMap<string, readonly string[]>),
    settle(sources.recentPartners, [] as readonly string[]),
    planSignalPossible && myPlan && sources.planEdges
      ? settle(() => sources.planEdges!(myPlan), [] as readonly PlanBlockingEdge[])
      : Promise.resolve([] as readonly PlanBlockingEdge[]),
  ]);

  const all = [
    ...deriveCouplingsFromRoster(self, rows),
    ...deriveCouplingsFromHeldFiles(self, held),
    ...deriveCouplingsFromPlanBlocking(self, rows, edges),
    ...deriveCouplingsFromCoordExchange(self, partners),
  ];
  const delivered = all.filter((d) => d.ownerId !== self && inRoster.has(d.ownerId));

  // P-007: census the run for the dead-signal detector. Censused from `delivered`,
  // NOT `all` — an edge dropped by the roster access boundary reached nobody, so
  // counting it would report a signal alive on output no caller received.
  //
  // `armed` is the wiring bit, deliberately independent of whether the leg found
  // anything: `heldFiles` absent is the exact shape that hid `holds-a-lock-on` for
  // 12 days, and it is indistinguishable from honest scarcity in an emit count.
  // `planEdges` counts as armed whenever the SOURCE is wired even if
  // `planSignalPossible` short-circuited the read, so an unreachable precondition
  // reports as starved-of-input rather than as a dead gate — different defect,
  // different remedy.
  if (sources.observe) {
    try {
      sources.observe(
        censusDerivedSignals(
          {
            // ⚠ `inputs` IS THE BINDING INPUT, NOT THE CANDIDATE POOL — via the same
            // helper each leg early-returns on, so a censused 0 and an unemittable
            // run are one fact (EI-20088486454213771). A pool count here republishes
            // the defect: it makes a short-circuited run read `armed-silent`
            // (evaluated, found nothing) when the honest verdict is `starved`.
            roster: { armed: true, inputs: awaitsBindingInputs(self, rows) },
            heldFiles: { armed: !!sources.heldFiles, inputs: heldFilesBindingInputs(self, held) },
            planEdges: { armed: !!sources.planEdges, inputs: edges.length },
            recentPartners: { armed: !!sources.recentPartners, inputs: partners.length },
          },
          delivered,
        ),
      );
    } catch {
      /* an observer must never degrade what it observes */
    }
  }

  return delivered;
}
