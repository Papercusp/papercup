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
import {
  FLEET_CAPABILITY_ROLES,
  FLEET_CAPABILITY_REPLACED_TOOLS,
  fleetAllowedToolsForRole,
  fleetDisallowedToolsForRole,
} from '@papercusp/orchestrator';

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

/**
 * Drift guard #2 (autonomous-loop-canary-reliability D-002 / P-005): the bee + queen kit
 * MUST carry the capability:* replacements, and a cut-over role's allow-list must NOT list a
 * native that its deny-list strips. Before P-005, BEE_MCP_TOOL_NAMES lacked capability:* AND
 * BEE_ALLOWED_TOOLS early-returned BEFORE the cutover filter, so under the cutover a confined
 * bee's allow-list still LISTED Bash/Edit/Write/WebFetch while the deny-list removed them — a
 * stranded role with no working write surface (the daily-canary break). This pins both the kit
 * additions and the allow/deny-asymmetry fix in fleetAllowedToolsForRole.
 *
 * Asserted through the orchestrator's public functions (the index does not re-export the raw
 * kit arrays), so the test tracks the SHIPPED resolution, not an internal constant.
 */
const mcpName = (short: string) => `mcp__papercusp__${short.replace(':', '_')}`;
const CAPABILITY_REPLACEMENT_MCP_NAMES = [
  'capability:bash',
  'capability:edit',
  'capability:write',
  'capability:fetch',
  'capability:git',
  'capability:read',
].map(mcpName);

describe('D-002 cut-over allow/deny asymmetry — confined bee/queen kit carries capability:* and lists no stripped native', () => {
  const CUTOVER_ROLES = ['bee', 'queen'] as const;

  it.each(CUTOVER_ROLES)(
    'under the cutover, %s allow-list excludes every replaced native (no tool both allowed and denied)',
    (role) => {
      const allow = new Set(fleetAllowedToolsForRole(role, /* capabilityOnly */ true));
      const deny = new Set(fleetDisallowedToolsForRole(role, /* capabilityOnly */ true));
      // Every native the cutover replaces must be ABSENT from the allow-list…
      for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
        expect(allow.has(native), `${role} allow-list must not list replaced native "${native}"`).toBe(false);
        // …and PRESENT on the deny-list (airtight removal, not mere omission).
        expect(deny.has(native), `${role} deny-list must strip replaced native "${native}"`).toBe(true);
      }
      // The asymmetry invariant in one line: allow ∩ deny is empty.
      for (const t of allow) expect(deny.has(t), `"${t}" is both allowed and denied for ${role}`).toBe(false);
    },
  );

  it.each(CUTOVER_ROLES)(
    'under the cutover, %s allow-list still carries the capability:* replacement surface',
    (role) => {
      const allow = new Set(fleetAllowedToolsForRole(role, /* capabilityOnly */ true));
      for (const name of CAPABILITY_REPLACEMENT_MCP_NAMES) {
        expect(allow.has(name), `${role} must keep capability replacement "${name}" under the cutover`).toBe(true);
      }
    },
  );

  it('cutover OFF leaves the bee native write surface intact (no regression to the unconfined path)', () => {
    const allow = new Set(fleetAllowedToolsForRole('bee', /* capabilityOnly */ false));
    for (const native of FLEET_CAPABILITY_REPLACED_TOOLS) {
      expect(allow.has(native), `cutover-off bee must keep native "${native}"`).toBe(true);
    }
  });
});
