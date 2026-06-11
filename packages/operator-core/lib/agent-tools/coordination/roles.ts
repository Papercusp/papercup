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
  // (coord:presence/inbox, work_items:list) → place (fleet:spawn — note
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
  // resolves. Excluded from fleet:spawn (placement is the Queen's, not the
  // watcher's — see fleet/spawn.ts, same carve-out as bee).
  'sentinel',
] as const;
