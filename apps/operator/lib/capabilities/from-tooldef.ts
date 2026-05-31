/**
 * Adapter: tooldef catalog (`ToolDefinition`) → `Capability[]` (P-003, server half).
 *
 * The mapper takes a structural `ToolDefinitionMeta` (the subset of tooldef's
 * `ToolDefinition` we read) so it carries no dependency on `@papercusp/tooldef`
 * and is trivially testable. The server-side enumerator (P-004) passes real
 * `ToolDefinition`s — structurally compatible — and the `tools/list` MCP
 * projection is unchanged.
 */
import type { Capability, CapabilityRiskTier } from './types';
import { schemaRequiresArgs } from './introspection';
import { humanizeCapabilityId, shorten } from './format';

/** The fields of tooldef's `ToolDefinition` this adapter reads. */
export interface ToolDefinitionMeta {
  name: string;
  description: string;
  capability: string;
  tier: CapabilityRiskTier; // tooldef CapabilityTier === our CapabilityRiskTier
  args?: unknown;
  guidance?: { when?: string };
  /** Agent-persona allowlist (`tool.roles`), if the def carries one. */
  roles?: Iterable<string>;
}

// Conservative heuristics: better to over-confirm / over-exclude than to fire a
// destructive or streaming tool from a single keystroke. Phase 2 replaces these
// with explicit flags on the tool definition (P-006).
// Token-boundary-aware so substrings don't false-match (e.g. "proce[sse]s"
// must NOT count as streaming). Boundaries are the id/capability separators.
const DESTRUCTIVE_RE = /(?:^|[._:-])(delete|remove|kill|destroy|reset|rollback|cancel|dismiss|purge|drop|promote|restore|revoke|deprecate)(?:$|[._:-])/i;
const STREAMING_RE = /(?:^|[._:-])(sse|stream|streaming|realtime|voice|conv|converse)(?:$|[._:-])/i;
const INTERACTIVE_RE = /(?:^|[._:-])(converse|conv|chat|ask|askchoice)(?:$|[._:-])/i;

export function toolDefinitionToCapability(def: ToolDefinitionMeta): Capability {
  const id = def.name;
  const destructive =
    DESTRUCTIVE_RE.test(id) || DESTRUCTIVE_RE.test(def.capability) || def.tier === 'high';

  return {
    id,
    title: humanizeCapabilityId(id),
    description: shorten(def.description),
    agentDescription: def.guidance?.when ?? def.description,
    runsIn: 'server',
    requiresArgs: schemaRequiresArgs(def.args),
    destructive,
    streaming: STREAMING_RE.test(id),
    interactive: INTERACTIVE_RE.test(id),
    tier: def.tier,
    gating: {
      agentRoles: def.roles ? [...def.roles] : undefined,
      // The tool's required capability string becomes a principal-capability requirement.
      auth: { capabilities: [def.capability] },
    },
    surfaces: { mcp: true },
  };
}

export function tooldefCatalogToCapabilities(defs: readonly ToolDefinitionMeta[]): Capability[] {
  return defs.map(toolDefinitionToCapability);
}
