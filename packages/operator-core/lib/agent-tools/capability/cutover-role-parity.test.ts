/**
 * Drift guard (agent-capability-confinement-2026-06-13 B-18 / P-020), UPDATED by the
 * most-permissive directive (owner 2026-06-25):
 *
 * The SAFETY-critical invariant is preserved and still pinned below: every role in the
 * orchestrator's `FLEET_CAPABILITY_ROLES` (the set whose NATIVE write/exec/fetch tools the
 * fleet cutover strips) MUST be able to call the gated `capability:*` replacement — else the
 * cutover would strand a confined role with no Bash at all. That is the `it.each` block.
 *
 * What CHANGED: the capability tools' `agentRoles` are now open to EVERY role (a deliberate
 * SUPERSET of the cutover set), so the relationship is `FLEET_CAPABILITY_ROLES ⊆ capability-roles`,
 * no longer strict equality. The native-tool-strip set itself (`FLEET_CAPABILITY_ROLES` in the
 * orchestrator) is UNCHANGED — we widened who may CALL the capability tools, not whose native
 * tools get stripped. Roles outside the cutover keep their native tools AND may also use the
 * gated capability tools; the capability ENVELOPE remains the real per-role boundary.
 */
import { describe, it, expect } from 'vitest';
import { SU_ROLES, AGENT_ROLES, lookupByMcpName } from '@papercusp/agent-mcp';
import { FLEET_CAPABILITY_ROLES } from '@papercusp/orchestrator';

// Importing a capability tool module projects it into the shared catalog.
import './bash';
import './read';
import './write';
import './edit';
import './git';
import './fetch';

/** The canonical role set the capability tools declare: SU_ROLES ∪ {bee}. */
const EXPECTED_ROLES = new Set<string>([...SU_ROLES, 'bee']);

describe('B-18 cutover role parity — FLEET_CAPABILITY_ROLES ≡ capability tools agentRoles', () => {
  it('FLEET_CAPABILITY_ROLES (orchestrator) equals SU_ROLES ∪ {bee}', () => {
    expect(new Set(FLEET_CAPABILITY_ROLES)).toEqual(EXPECTED_ROLES);
  });

  it.each(['capability:bash', 'capability:read', 'capability:write', 'capability:edit', 'capability:git', 'capability:fetch'])(
    'every cutover role can call %s (so the cutover never strands a confined role)',
    (toolName) => {
      const tool = lookupByMcpName(toolName);
      expect(tool, `${toolName} not registered`).toBeDefined();
      const roles = new Set(tool!.agentRoles ?? []);
      for (const r of FLEET_CAPABILITY_ROLES) {
        expect(roles.has(r), `${toolName} must be callable by cutover role "${r}"`).toBe(true);
      }
    },
  );

  it('the capability tools are open to EVERY role (most-permissive directive 2026-06-25), a deliberate superset of the cutover set', () => {
    const allRoles = new Set<string>(AGENT_ROLES);
    for (const toolName of ['capability:bash', 'capability:read', 'capability:write', 'capability:edit', 'capability:git', 'capability:fetch']) {
      const tool = lookupByMcpName(toolName);
      const roles = new Set(tool!.agentRoles ?? []);
      expect(roles, `${toolName} should be open to all roles`).toEqual(allRoles);
      // The cutover set must remain a SUBSET (safety invariant — re-asserted here for locality).
      for (const r of EXPECTED_ROLES) expect(roles.has(r)).toBe(true);
    }
  });
});
