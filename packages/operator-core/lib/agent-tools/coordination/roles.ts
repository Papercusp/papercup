/**
 * Roles permitted to call coord:* tools. Superuser and power-user
 * callers bypass the role gate entirely (dispatch-stack.ts); this list
 * only matters for role-gated callers. It mirrors the SU role set the
 * sibling locks:* tools use.
 */
export const COORD_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
  // The generic Hive worker (local-hive-orchestration D-003 / P-011). The bee
  // coordinates via coord:* (declare-intent, send, await-inbox) and maintains its
  // ordered work-list via work_items:* — both gated on this list — so it MUST be a
  // coord role. Same gate the pipeline worker passes, minus the chunk coupling.
  'bee',
  // The QUEEN — the hive's placement decider (operator specialized; local-hive
  // D-001/P-030). Her whole loop is coord/fleet/work_items: survey
  // (coord:presence/inbox, work_items:list) → place (cup:spawn — note
  // fleet/spawn.ts filters OUT bee+sentinel but keeps queen; placement is hers)
  // → warm-inject (coord:send {wake}) → drain (fleet:drain). EI-286 follow-up:
  // the role existed only in the blueprint, so every gate here filtered her out.
  'queen',
  // The SENTINEL — the fleet watcher (unify-launch-mechanics-2026-06-09 D-004).
  // Its core surface IS coord: it READS the substrate (coord:presence/inbox/feed)
  // + the fleet (fleet:assignments/tree — both COORD_ROLES-gated, surfacing stuck/
  // orphaned spawns) and RAISES ALARMS (coord:escalate/send). Its caps
  // (BLUEPRINT_ROLE_CAPS.sentinel) are read-mostly, so the COORD_ROLES write tools
  // it cannot use (work_items:write etc.) stay capped out — only coord:write
  // resolves. Excluded from cup:spawn (placement is the Queen's, not the
  // watcher's — see fleet/spawn.ts, same carve-out as bee).
  'sentinel',
  // The OVERWATCH — the autonomous system-health supervisor (overwatch-role-2026-06-15
  // C-2 / B-01). Like the sentinel, its core surface IS coord: it READS the substrate
  // (coord:presence/inbox/feed, improvements:digest, topics:feed) + the fleet
  // (fleet:assignments/tree) + the work frontier (work_items:list) + the ledgers
  // (decision_ledger, pot:status) and its ONLY writes are NUDGES + observations
  // (coord:send / coord:escalate / improvements:capture). Its caps
  // (BLUEPRINT_ROLE_CAPS.overwatch) are read-mostly (coord:write for nudges only), so the
  // COORD_ROLES write tools it cannot use stay capped out. Excluded from cup:spawn
  // (placement is the Queen's — the overwatch NUDGES her to re-place, never re-places
  // itself; D-001 — same carve-out as bee/sentinel).
  'overwatch',
  // The DOC-STEWARD — the automated doc-freshness fixer (docs-corpus-audit P-008;
  // the `doc-steward` launch blueprint). Its prompt calls `work_items:get` (to read
  // WHY the anchored code changed) and `coord:escalate` (when it can't faithfully fix
  // a doc) — both COORD_ROLES-gated. It was never a registered role, so those failed
  // `role_not_allowed` for a doc-steward-scoped URL, forcing a scripts/mcp-call.mjs
  // fallback (EI-6643). Same registered-late class as bee/sentinel/overwatch above.
  'doc-steward',
] as const;
