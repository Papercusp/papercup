/**
 * coord:orient — the COMPOUND agent wake-orientation read (code-execution-tool-
 * orchestration B-CX-1B). The worker's "where do I stand / what should I work on" in
 * ONE call: my current assignments (+ lane + load), the claimable backlog, and my
 * inbox summary.
 *
 * Measured (harness_shared.tool_invocations, mcp transport, 14d): the
 * `fleet:assignments ↔ coord:inbox ↔ work_items:list/get` cluster is the dominant
 * orientation flow — triples like `memory:search → coord:inbox → fleet:assignments`
 * (36), `fleet:assignments → coord:inbox → work_items:get` (35), `work_items:list →
 * fleet:assignments → work_items:list` (47). Agents pay 3 inference round-trips to
 * answer one question.
 *
 * orient collapses it: fleet:assignments(me) + work_items:list(claimable) +
 * coord:inbox(summary) → 1 round-trip. It is the worker/work-centric sibling of
 * coord:glance (the fleet-HEALTH read for status surfaces). Composition is the
 * in-process re-dispatch pattern (see `_compound-dispatch.ts`) — each sub-read is
 * gated + telemetry-logged like a direct call. Sub-calls run SEQUENTIALLY (not
 * Promise.all) so they never contend on the caller's single ctx connection; the
 * server-side cost is negligible against the inference round-trip saved.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { inProcessCall, type InnerCall } from '../../_compound-dispatch';

export interface OrientArgs {
  harness?: string;
  claimableState?: string;
  claimableLimit?: number;
  inboxLimit?: number;
}

export interface OrientResult {
  ok: boolean;
  /** fleet:assignments scoped to me (assignments, lane, load, orphans). */
  me: unknown;
  /** The claimable backlog (work_items:list, default state=todo). */
  claimable: unknown[];
  /** coord:inbox folded down to its summary + the most-recent bounded entries. */
  inbox: { summary?: unknown; recent?: unknown };
}

/**
 * Pure composition: fleet:assignments(me) → work_items:list(claimable) →
 * coord:inbox(summary), over an injected `call`, run sequentially. `ownerId` scopes the
 * assignments to the caller; when undefined (unresolved loopback identity) the
 * assignments read is fleet-wide.
 */
export async function composeOrient(
  args: OrientArgs,
  call: InnerCall,
  ownerId: string | undefined,
): Promise<OrientResult> {
  const me = await call('fleet:assignments', {
    ...(ownerId ? { agent: ownerId } : {}),
    ...(args.harness ? { harness: args.harness } : {}),
  });
  const list = await call('work_items:list', {
    ...(args.harness ? { harness: args.harness } : {}),
    state: args.claimableState ?? 'todo',
    limit: args.claimableLimit ?? 20,
  });
  const inbox = (await call('coord:inbox', {
    limit: args.inboxLimit ?? 10,
    max_body_chars: 300,
  })) as { summary?: unknown; entries?: unknown } | undefined;

  // work_items:list returns the bare array (its `result` schema), but be defensive
  // about the wrapped shapes the unwrap may yield.
  const claimable = Array.isArray(list)
    ? list
    : ((list as { data?: unknown[]; items?: unknown[] } | null)?.data ??
       (list as { data?: unknown[]; items?: unknown[] } | null)?.items ??
       []);

  return {
    ok: true,
    me,
    claimable,
    inbox: { summary: inbox?.summary, recent: inbox?.entries },
  };
}

export default defineTool({
  name: 'coord:orient',
  description:
    "One agent wake-orientation read: your assignments (+ lane + load), the claimable " +
    "backlog, and your inbox summary — fleet:assignments + work_items:list + coord:inbox " +
    "in ONE round-trip. The worker's 'what should I work on' read (coord:glance is the " +
    'fleet-health read).',
  guidance: {
    when:
      'At the start of a turn / on waking, to see your current assignments + the ' +
      'claimable backlog + your unread inbox in one round-trip instead of ' +
      'fleet:assignments + work_items:list + coord:inbox.',
    notWhen:
      'Fleet-wide wake/health state for a status surface (coord:glance); full message ' +
      'bodies or history (coord:inbox); the whole presence roster (coord:presence).',
    chaining: 'coord:orient → work_items:pickup { id, intent } the item you will take.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(80).optional().describe('Scope assignments + claimable list to this harness.'),
    claimableState: z.string().max(40).optional().describe("Work-item state for the claimable list (default 'todo')."),
    claimableLimit: z.number().int().positive().max(100).optional().describe('Max claimable items (default 20).'),
    inboxLimit: z.number().int().positive().max(50).optional().describe('Max recent inbox entries (default 10).'),
  }),
  async handler(args, ctx) {
    // Soft identity resolve — orient is a READ; a bare loopback caller without an
    // attributable coord identity still gets a (fleet-wide) orientation.
    let ownerId: string | undefined;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = undefined;
    }
    const result = await composeOrient(args, inProcessCall(ctx), ownerId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
