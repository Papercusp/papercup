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
] as const;
