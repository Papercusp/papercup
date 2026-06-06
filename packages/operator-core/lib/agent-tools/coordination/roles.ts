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
] as const;
