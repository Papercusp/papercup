/**
 * memory:list — browse all entries for the current user.
 *
 * Mostly used by the /settings/user/memory UI and the TUI Memory tab.
 * Brain can call it for filter-only queries (e.g. "show me all
 * corrections") that don't benefit from semantic search.
 *
 * Storage rides the neutral `MemoryBackend` seam. RESPONSE CONTRACT
 * (byte-stable — the TUI Memory tab consumes it): { ok, reason?,
 * results: [{ id, memory, metadata }] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { toWireRow } from './search';

// `ephemeral` retired (docs-and-memory-as-projections D-006) — the store holds
// only stable facts. Filter enum unified on the Claude-file taxonomy
// (memory-taxonomy-and-debt-followups D-001); the live store's legacy mem0
// rows were migrated in the same pass, so no legacy kinds linger.
const KINDS = ['user', 'feedback', 'project', 'reference'] as const;

export default defineTool({
  name: 'memory:list',
  capability: 'memory:read',
  description:
    'List all memories for the current user. Supports filtering by kind and harness scope.',
  guidance: {
    when:
      'When the user asks to inspect their memory ("what have you stored about me?") or you need a filter-only query.',
    notWhen:
      'For semantic lookup ("what did I say about X?"), use memory:search instead.',
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so this works from a psu / fleet
  // session instead of failing `workspace_required` (EI-210 — the workspace-tx
  // gate was wrongly applied to memory:list; search + remember already carry this).
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    kind: z.enum(KINDS).optional(),
    harness_slug: z.string().optional(),
    hive_slug: z.string().optional()
      .describe("Also list the Hive's shared pool (seeded learnings + recorded conventions — learning-packs P-004)."),
  }),
  async handler(args) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, results: [] }) }],
      };
    }

    // User pool + (when requested) one harness pool + one hive pool. Kind
    // filtering and the per-pool fan-out are the backend's concern.
    const entries = await backend.list({
      scope: [
        user.id,
        ...(args.harness_slug ? [`harness:${args.harness_slug}`] : []),
        ...(args.hive_slug ? [`hive:${args.hive_slug}`] : []),
      ],
      kind: args.kind,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: entries.map(toWireRow) }) }],
    };
  },
});
