/**
 * Server capability projection (P-004, read side).
 *
 * Projects the live tooldef catalog (`getCatalog()`) into palette-eligible
 * `Capability` records for a given principal:
 *   - principal capability gate (mirrors dispatch: `*` or holds the cap),
 *   - the §3 palette safety filter (excludes streaming/interactive/required-arg;
 *     keeps non-destructive low/med as fire-and-toast and destructive/high as confirm).
 *
 * Read-only: it never invokes anything. The MCP `tools/list` projection is
 * untouched (D-002 non-goal). Execution authority is re-checked at dispatch
 * (the invoke endpoint), so this projection is a UX convenience, not the gate
 * of record.
 */
import { getCatalog } from '@papercusp/agent-mcp';
import type { Principal } from '@papercusp/agent-mcp';
import type { ToolDefinitionMeta } from './from-tooldef';
import { toolDefinitionToCapability } from './from-tooldef';
import { paletteEligibility } from './safety-filter';
import type { Capability } from './types';

export interface ServerCapability extends Capability {
  /** How the palette must run it (never `'exclude'` — those are filtered out here). */
  eligibility: 'fire-and-toast' | 'confirm';
}

function principalAllows(
  principal: Pick<Principal, 'capabilities'>,
  requiredCapability: string,
): boolean {
  const caps = principal.capabilities;
  return caps.has('*') || !requiredCapability || caps.has(requiredCapability);
}

/**
 * Palette-eligible server capabilities the principal may invoke. `catalog`
 * is injectable for tests; defaults to the live `getCatalog()`.
 */
export function getServerCapabilities(opts: {
  principal: Pick<Principal, 'capabilities'>;
  /**
   * Agent persona the palette invokes as (the run-tool ctx uses `operator`).
   * When set, tools whose `agentRoles` allowlist excludes it are filtered out
   * so the listing matches invocability — a tool that would 403 at dispatch
   * never appears. Tools with no allowlist are available to every role.
   */
  role?: string;
  catalog?: readonly ToolDefinitionMeta[];
}): ServerCapability[] {
  const defs: readonly ToolDefinitionMeta[] = opts.catalog ?? getCatalog();
  const out: ServerCapability[] = [];
  for (const def of defs) {
    if (!principalAllows(opts.principal, def.capability)) continue;
    const cap = toolDefinitionToCapability(def);
    if (
      opts.role &&
      cap.gating.agentRoles &&
      cap.gating.agentRoles.length > 0 &&
      !cap.gating.agentRoles.includes(opts.role)
    ) {
      continue;
    }
    const eligibility = paletteEligibility(cap);
    if (eligibility === 'exclude') continue;
    out.push({ ...cap, eligibility });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
