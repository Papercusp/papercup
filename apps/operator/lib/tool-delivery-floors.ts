/**
 * tool-delivery-floors.ts — the tools that must be advertised regardless of
 * measured demand, and the machine-readable reason each one is owed.
 * (deterministic-tool-definition-delivery-2026-09-21 P-004, ruled by D-004.)
 *
 * ── WHAT A FLOOR IS, AND WHAT IT IS NOT ────────────────────────────────────
 *
 * Four classes of tool must be reachable whatever the measurement says, because
 * their absence does not degrade gracefully. A floor guarantees a tool is at
 * least COMPACT. It does NOT guarantee FULL: the policy may still hold a floor
 * at COMPACT when bytes demand it (D-004). That is what keeps the budget binding
 * without letting it break a mandate.
 *
 * ── THIS REPLACES A PROSE DOCSTRING, WHICH IS THE POINT ────────────────────
 *
 * These four tiers previously lived as comment headings inside
 * `psu-launcher.mjs`'s `CLAUDE_MINIMAL_SEED_TOOL_NAMES`, where the reason for a
 * name was a `//` comment beside it and nothing could check that a name had one.
 * Here the reason is DATA on the entry, so a floor declared without one is a
 * build failure rather than an omission nobody notices. Same ladder rung the
 * repo applies elsewhere: a value that describes code is derived, pinned or
 * attested — hand-maintained prose is the last resort and owes a reason.
 *
 * ── TIER 2 IS DERIVED, NEVER RE-LISTED ─────────────────────────────────────
 *
 * The routing-table mandates already have a single source of truth: the
 * bash→tool substitution registry that `npm run gen:tool-routing` projects into
 * root CLAUDE.md, read here through `seed-mandate-coverage`. Re-listing those
 * names would create the exact second copy this plan exists to remove — and it
 * would go stale silently, because a name added to the routing table would keep
 * passing a floor check that had never heard of it. So tier 2 is a FUNCTION of
 * the registry, and feeding it a different registry yields a different tier 2.
 *
 * Tiers 1, 3 and 4 have no machine-readable source to derive from — tier 4 is
 * explicitly the set that `seed-mandate-coverage`'s own SCOPE note says it
 * CANNOT see, being prose duties in root CLAUDE.md and the personas. Those are
 * declared here once, each carrying its reason.
 */

import { ALL_PAIRS } from '@papercusp/operator-core/lib/bash-substitution/pairs/index';
import type { SubstitutionPair } from '@papercusp/operator-core/lib/bash-substitution/types';

import { MANDATE_SEED_EXEMPT, promotedMandateToolNames } from './seed-mandate-coverage';

export type FloorTier =
  /** (1) Without these the whole cut strands the catalog. */
  | 'reachability'
  /** (2) Promoted by the generated bash→tool routing table. DERIVED. */
  | 'routing-table-mandate'
  /** (3) Absence does not degrade — it HALTS or strands state. */
  | 'silent-halt-lifecycle'
  /** (4) Required by documentation no machine-readable guard covers. */
  | 'prose-mandate';

export interface FloorEntry {
  name: string;
  tier: FloorTier;
  /** Why this tool cannot be dropped. Non-empty by contract — see {@link assertFloorsAreReasoned}. */
  reason: string;
}

/**
 * Tiers 1, 3 and 4. Tier 2 is absent ON PURPOSE — see {@link routingTableFloors}.
 *
 * Adding a name here is adding a claim that the budget may never drop it, so the
 * reason must say what BREAKS without it, not merely that it is useful.
 */
export const DECLARED_FLOORS: readonly FloorEntry[] = Object.freeze([
  {
    name: 'tools:find',
    tier: 'reachability',
    reason:
      'the only way to locate a deferred tool by intent; without it the entire un-advertised catalog is unreachable rather than one round-trip away',
  },
  {
    name: 'tools:invoke',
    tier: 'reachability',
    reason:
      'dispatches any catalog tool by name under identical gating; without it a tool found by tools:find still cannot be called',
  },

  {
    name: 'session:request-compaction',
    tier: 'silent-halt-lifecycle',
    reason:
      'EI-6770: a session without it self-halts at its context limit instead of compacting, and a halted session looks identical to a finished one',
  },
  {
    name: 'loop:status',
    tier: 'silent-halt-lifecycle',
    reason:
      'the su rule is to VERIFY a wake is armed before ending a turn; unable to check, an agent ends its turn with no re-wake and silently stops',
  },
  {
    name: 'coord:declare-intent',
    tier: 'silent-halt-lifecycle',
    reason: 'an undeclared lane is invisible to peers and the leader, so the same work gets double-placed',
  },
  {
    name: 'coord:inbox',
    tier: 'silent-halt-lifecycle',
    reason: 'a directed question outranks own work; without inbox access a blocked peer waits on an answer that never comes',
  },
  {
    name: 'work_items:claim',
    tier: 'silent-halt-lifecycle',
    reason: 'no code edit without a held work-item; unable to claim, an agent either stalls or edits untracked',
  },
  {
    name: 'scheduler:get_next',
    tier: 'silent-halt-lifecycle',
    reason: 'a fleet member pulls work through it every iteration; without it the member has no way to be fed',
  },

  {
    name: 'state:read',
    tier: 'prose-mandate',
    reason: 'root CLAUDE.md: RE-READ a volatile value rather than transcribing it — the transcribed-stale-value bug class',
  },
  {
    name: 'sessions:search',
    tier: 'prose-mandate',
    reason: 'the compaction strategy names it as the self-recall path for anything a carry document dropped',
  },
  {
    name: 'mode:set',
    tier: 'prose-mandate',
    reason: 'the su persona mandates registering every AUTO/DRAIN/IDEATE flip; an unregistered mode is invisible state',
  },
  {
    name: 'work_items:claimable',
    tier: 'prose-mandate',
    reason: 'the storage-policy table names it as the answer to "what is claimable", against a raw floor query that overcounts ~13x',
  },
  {
    name: 'dev:restart',
    tier: 'prose-mandate',
    reason: 'the two-port model names it as the ONLY sanctioned way to reload :3170',
  },
  {
    name: 'dev:pipeline_position',
    tier: 'prose-mandate',
    reason: 'root CLAUDE.md: "is my change live" is ONE call, against a browser check that reads the wrong build',
  },
  {
    name: 'capability:bash',
    tier: 'prose-mandate',
    reason: 'the long-jobs rule: anything past ~1-2 min is backgrounded through it',
  },
  {
    name: 'capability:bash_output',
    tier: 'prose-mandate',
    reason:
      'INSEPARABLE from capability:bash — advertising the launcher without its reader strands every background job an agent starts',
  },
  {
    name: 'locks:acquire',
    tier: 'prose-mandate',
    reason: 'EI-9011: the PreToolUse lock-block hook names this verb in its refusal text, so the agent is told to call something it cannot see',
  },
  {
    name: 'locks:release',
    tier: 'prose-mandate',
    reason: 'the other half of locks:acquire — without release a granted lock strands a peer behind it',
  },
  {
    name: 'memory:search',
    tier: 'prose-mandate',
    reason: 'user CLAUDE.md routes durable facts to the shared memory store first; a write-only memory is not usable',
  },
  {
    name: 'memory:remember',
    tier: 'prose-mandate',
    reason: 'the write half of the same mandate',
  },
  {
    name: 'docs:search',
    tier: 'prose-mandate',
    reason: '"Before you design or test — read the docs first" is unfollowable without it',
  },
]);

/**
 * Tier 2, DERIVED from the bash→tool substitution registry rather than listed.
 *
 * A promoted mandate carrying an evidence-bearing exemption in
 * `MANDATE_SEED_EXEMPT` is deliberately NOT a floor: those are the rows where the
 * measurement already decided the tool is better reached on demand, and turning
 * them into floors would silently overturn that recorded decision.
 */
export function routingTableFloors(pairs: readonly SubstitutionPair[] = ALL_PAIRS): FloorEntry[] {
  return promotedMandateToolNames(pairs)
    .filter((name) => !MANDATE_SEED_EXEMPT.has(name))
    .map((name) => ({
      name,
      tier: 'routing-table-mandate' as const,
      reason:
        `promoted by the generated bash-to-tool routing table, so an agent is told in root CLAUDE.md to reach for \`${name}\`; ` +
        'unadvertised, ToolSearch answers "no matching deferred tools found", which reads as the tool not existing',
    }));
}

/**
 * Fail loudly on a floor with no stated reason.
 *
 * Exported so the guard can be exercised against a deliberately-bad entry
 * without mutating the shared tree — the same discipline as keeping a wrong
 * implementation in a test file as a permanent control.
 */
export function assertFloorsAreReasoned(entries: readonly FloorEntry[]): void {
  const unreasoned = entries.filter((e) => typeof e.reason !== 'string' || e.reason.trim() === '');
  if (unreasoned.length > 0) {
    throw new Error(
      `tool-delivery-floors: ${unreasoned.length} floor(s) declared with no reason: ${unreasoned
        .map((e) => e.name)
        .join(', ')}. A floor overrides the measured budget, so it owes a statement of what breaks without it.`,
    );
  }
}

/**
 * The complete floor set: declared tiers 1/3/4 plus the derived tier 2.
 *
 * A name reachable through two tiers keeps its DECLARED entry — the hand-written
 * reason says what specifically breaks, where the derived one can only say that
 * the routing table promotes it.
 */
export function resolveDeliveryFloors(pairs: readonly SubstitutionPair[] = ALL_PAIRS): FloorEntry[] {
  const byName = new Map<string, FloorEntry>();
  for (const entry of routingTableFloors(pairs)) byName.set(entry.name, entry);
  for (const entry of DECLARED_FLOORS) byName.set(entry.name, entry);

  const all = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assertFloorsAreReasoned(all);
  return all;
}

/** The floor set as the bare name list `resolveToolDelivery` takes. */
export function deliveryFloorNames(pairs: readonly SubstitutionPair[] = ALL_PAIRS): string[] {
  return resolveDeliveryFloors(pairs).map((e) => e.name);
}
