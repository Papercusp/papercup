/**
 * frontier-readiness — the ONE shared readiness predicate, two consumers
 * (queen-wave-dispatch-2026-06-13 W-01 / P-010, D-002: "one frontier, two views").
 *
 * "Readiness" is the answer to *which* dispatchable items are eligible right now:
 * a node whose status is dispatchable, that isn't already in-flight (`owned`), and
 * whose every `blocked_by` edge is SATISFIED. A blocker is satisfied iff it is
 * TERMINAL (passed/deprecated) OR absent from the known node set (an absent id
 * never deadlocks; a non-terminal blocker — todo/wip/failing/building — correctly
 * keeps its dependents blocked). This is the EXACT semantics the DBOS feature
 * orchestrator has always used inside `computeFrontier`; it is lifted here so the
 * Queen's placement survey (lib/hive/survey.ts) reuses it verbatim rather than
 * forking a second readiness — so a wave's `blocked_by` ordering sequences bee
 * placement the same way it sequences feature-pipeline dispatch.
 *
 * ORDERING is deliberately NOT shared: the orchestrator dispatches in strict
 * plan-priority + feature_order (computeFrontier), the Queen ranks by the
 * placement-ranker's weighted score (placement-ranker.ts via the one queue-ranker).
 * Two views, two ordering policies — the keystone they share is READINESS.
 *
 * Pure (no IO) so both consumers unit-test the predicate with no database.
 */

/** Statuses that make a node TERMINAL — a blocker in this set is satisfied. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['passed', 'deprecated']);

/** The minimum a node needs to be partitioned: its id, status, and resolved blockers. */
export interface ReadinessNode {
  id: string;
  status: string;
  /** Resolved canonical blocker ids (coord_links rel='blocks'). Empty when unblocked. */
  blockedBy: readonly string[];
}

/**
 * A blocker is satisfied iff it is terminal OR absent from the known node set.
 * `present` = ids of every node considered; `terminal` = ids whose status is
 * terminal. An absent id can never deadlock (it isn't a live blocker); a present
 * non-terminal id keeps its dependents blocked.
 */
export function blockerSatisfied(
  blockerId: string,
  present: ReadonlySet<string>,
  terminal: ReadonlySet<string>,
): boolean {
  return !present.has(blockerId) || terminal.has(blockerId);
}

/**
 * Partition nodes into READY (dispatchable status, not owned, every blocker
 * satisfied) and BLOCKED (dispatchable + not owned, but ≥1 blocker unsatisfied).
 * Non-dispatchable or owned nodes are neither — they still populate `present`/
 * `terminal` so they can satisfy others' blockers.
 *
 * `readiness` = the dispatchable-status set (the orchestrator's blueprint policy,
 * defaulting to its legacy NEEDS_WORK; the survey passes its own `todo`-only set).
 * `terminalStatuses` defaults to passed/deprecated.
 */
export function selectReady<T extends ReadinessNode>(
  nodes: readonly T[],
  owned: ReadonlySet<string>,
  readiness: ReadonlySet<string>,
  terminalStatuses: ReadonlySet<string> = TERMINAL_STATUSES,
): { ready: T[]; blocked: T[] } {
  const present = new Set(nodes.map((n) => n.id));
  const terminal = new Set(nodes.filter((n) => terminalStatuses.has(n.status)).map((n) => n.id));
  const ready: T[] = [];
  const blocked: T[] = [];
  for (const n of nodes) {
    if (!readiness.has(n.status) || owned.has(n.id)) continue;
    if (n.blockedBy.every((b) => blockerSatisfied(b, present, terminal))) ready.push(n);
    else blocked.push(n);
  }
  return { ready, blocked };
}
