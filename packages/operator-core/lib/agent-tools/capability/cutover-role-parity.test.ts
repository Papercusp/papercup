/**
 * Drift guard (agent-capability-confinement-2026-06-13 B-18 / P-020): the
 * orchestrator's `FLEET_CAPABILITY_ROLES` — the set of roles the fleet cutover
 * strips native write/exec/fetch tools from — MUST stay in lockstep with the
 * roles that actually HAVE the `capability:*` defineTools (their `agentRoles`).
 *
 * If they drift, the cutover could strip a role's native Bash WITHOUT giving it
 * the gated `capability:bash` replacement (stranding it), or keep native tools on
 * a role that has the replacements (leaving an un-confined hole). The orchestrator
 * can't import `@papercusp/agent-mcp` (no dep), so it hard-codes the set literally;
 * THIS test (in operator-core, which imports both) pins the two together. Touch
 * one ⇒ touch the other, or this fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { SU_ROLES, lookupByMcpName } from '@papercusp/agent-mcp';
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

  it('the capability bash tool declares EXACTLY the cutover role set (no silent widening either direction)', () => {
    const tool = lookupByMcpName('capability:bash');
    expect(new Set(tool!.agentRoles ?? [])).toEqual(EXPECTED_ROLES);
  });
});
