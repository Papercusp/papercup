/**
 * p2p-lane-fence.ts — the single, reusable source of truth for the p2p/federation/
 * rig title exclusion fence a single-box drain fleet's claim spec needs (WI-5268,
 * hardening the fix history from WI-5265/WI-5272).
 *
 * History: the `backlog-drain` fleet's claim spec has had this fence REGRESSED
 * TWICE by hand-edits that silently dropped the p2p/federation/rig excludes
 * (stripped at rev5, restored at rev6, regressed again at rev9, fixed again at
 * rev10). Nothing stopped a NEXT hand-edit from doing it a third time — the
 * fence lived only as ad hoc glob clauses typed directly into the spec JSON via
 * scheduler:set_claim_spec, with no shared source any two edits could diverge
 * from or agree with, and no test would fail if a future edit dropped a clause.
 *
 * This module is that shared source: `P2P_LANE_EXCLUSION_TERMS` names exactly
 * what a single-box fleet must exclude, and `buildP2pLaneFence()` composes it
 * into a `FilterNode` any TypeScript caller can splice into a `view.filter`
 * `all: [...]` list instead of re-typing per-term glob/word clauses by hand.
 * p2p-lane-fence.test.ts pins its CONTENT against representative
 * p2p/federation/rig-titled items, so a future edit that shrinks or drops a
 * term fails a test instead of silently leaking rig-only work to a single-box
 * fleet member who can't execute it (WI-5265's original incident).
 *
 * WI-6050: the ORIGINAL gap this history left open — a leader authoring a spec
 * over MCP (raw JSON, `scheduler:set_claim_spec`) cannot `import
 * buildP2pLaneFence()`, so the fence could still only ever be reached by
 * hand-retyping its terms, which regressed a THIRD time (rev9 leaked WI-5639).
 * `claim-spec.ts`'s `CLAIM_SPEC_FENCE_MACROS` registry now closes that: a spec
 * author sets `view:{ fence:"p2p-lane" }` and `validateClaimSpec` expands it
 * from THIS module's current `P2P_LANE_EXCLUSION_TERMS` at write time — a name
 * that cannot drift, instead of terms that could.
 *
 * Uses the `word` filter op (EI-18690730909662985), not `glob`: a whole-word
 * match avoids `glob`'s bare-substring false positive (e.g. a `*p2p*` glob
 * wrongly excluding a fleet literally named "nonp2p-bug-drain", whose own
 * title mentions its own name) and is already case-insensitive, so — unlike the
 * live rev10 spec's separate `*p2p*`/`*P2P*` glob pairs — one entry here covers
 * both cases.
 */
import type { FilterNode } from './claim-spec';

/**
 * The exact terms a single-box drain fleet's claim spec must exclude by TITLE —
 * cross-machine p2p/federation/rig-only work a single-box fleet member cannot
 * execute (per the owner directive that P2P/federation is deferred post-V1 for
 * release-readiness fleets). Whole-word matched (case-insensitive) via the
 * `word` filter op — see the module doc for why `word`, not `glob`.
 *
 * Mirrors the live `backlog-drain` fleet's rev10 title-glob terms
 * (`*p2p*`/`*P2P*`, `*hared-hive*`, `*federation*`/`*Federation*`,
 * `*holepunch*`, `*teering lease*`) collapsed to their case-insensitive
 * whole-word equivalents.
 */
export const P2P_LANE_EXCLUSION_TERMS = [
  // Core p2p / federation vocabulary.
  'p2p',
  'shared-hive',
  'federation',
  'holepunch',
  'steering lease',
  // Replication subsystem. In this pot "replication" IS the p2p transport surface
  // (replication_soak, no_replicator, connected_never_replicated, the
  // [replication-liveness] EI stream) — not database replication.
  // WI-5639 leaked into fleet nonp2p-bug-drain-0725 purely because this term was
  // absent; it is the single highest-value entry in this list.
  'replication',
  // Named p2p stack components. These were live in nonp2p-bug-drain-0725's
  // hand-typed rev9 spec but were MISSING from this supposedly-canonical fence —
  // so importing the fence as it stood would have WIDENED the leak, not closed
  // it. Folded in here so the shared source is a true superset and the next
  // editor has nothing left to hand-type.
  'swarm',
  'hyperswarm',
  'hyperdht',
  'hyperbee',
  'dht',
  'udx',
  'relay',
] as const;

/**
 * Build the `not: { any: [...] } }` FilterNode excluding every
 * {@link P2P_LANE_EXCLUSION_TERMS} title match. Compose this into a spec's
 * `view.filter` `all: [...]` array alongside the kind/state/plan clauses,
 * instead of hand-typing a title glob/word exclusion per term — that
 * hand-typing is exactly the drift this module exists to stop.
 */
export function buildP2pLaneFence(): FilterNode {
  return {
    not: {
      any: P2P_LANE_EXCLUSION_TERMS.map((value) => ({ field: 'title', op: 'word', value }) as const),
    },
  };
}
