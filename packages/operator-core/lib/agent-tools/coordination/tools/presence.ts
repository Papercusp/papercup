/**
 * coord:presence — list active coordination agents and what they are
 * doing right now.
 *
 * Joins the live liveness layer (harness_shared.coord_presence) with
 * the durable record (harness_shared.power_user_sessions). Sessions
 * whose heartbeat is older than 10 min are returned in `stale`, not
 * `active`. agent-coordination-architecture-v2 §4.2 / §4.3.
 *
 * The scope-resolution + snapshot assembly live in `../presence-snapshot`
 * (shared with the coord:inbox P-010 re-bootstrap, so both read the SAME
 * hive-scoped roster); this tool is the thin read surface over it.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolvePresenceScope, assemblePresenceSnapshot } from '../presence-snapshot';
import { readIdentity } from '../../locks/identity';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:presence',
  description:
    "List coordination agents + whether each can actually TAKE WORK. The result's top-level `self` is YOUR own ownerId+label and your own row is stamped `isSelf:true` — so you can always tell which agent in the roster is THIS session (no separate coord:whoami needed). Each row carries `wakeable` (an inbox-wake await exists) and `sessionState` (live = in a turn now · parked = idle-but-wakeable, ideal dispatch target · ended = needs relaunch, NOT wake). Read `summary.wakeable`, not `active` (a fresh heartbeat can be ended). `intentStale:true` ⇒ declared `intent`/`claimedItems` is not progressing; do NOT treat its work as handled, its items are fair to pick up / re-place. Defaults to your HIVE; scope=workspace|all for admin/Queen. Stale (>10 min) sessions are summarised unless include_stale.",
  guidance: {
    when: '"Who can take work right now, and on what?" — before dispatching/handing off. Read `sessionState`/`wakeable` per row + `summary.wakeable`, NOT raw `active`. Hand a lane to a `parked` agent via coord:dispatch (assign+wake+confirm); an `ended` target needs a relaunch.',
    notWhen: 'Checking whether a specific file is free — use locks:queue. Re-reading the roster every turn — the [coord+N] lifecycle deltas already carry intent/claim/completion; tail those (see chaining).',
    chaining:
      'Read-once + tail: snapshot is byte-stable, so read it ONCE then tail [coord+N] lifecycle deltas for peer transitions. lastActiveSecAgo is point-in-time at as_of. After compaction the roster baseline re-injects automatically.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe('hive (DEFAULT) = your Hive\'s agents + federated peers for it; workspace = the whole workspace; all = every workspace (admin/Queen). A caller with no Hive (SU/operator) falls back to workspace.'),
    hive: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z
      .string()
      .optional()
      .describe('Workspace id for workspace/hive scope; omit to use the caller\'s.'),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also return the full stale roster (default false — stale is summarised only; the live answer is `active`).'),
    include_detail: z
      .boolean()
      .optional()
      .describe('P-011 Tier-2/3 detail: add each agent\'s `heldFiles` (its live file-lock nodes, read from the separate papercusp_su lock DB — opt-in + fail-soft). Off by default; the lean roster already carries the Tier-1 scalars.'),
  }),
  async handler(args, ctx) {
    // P-004 hive-scoped read (D-002): resolve the effective scope from ctx + args
    // (hive default → caller's home Hive; SU/unmapped → workspace fallback), then
    // assemble the byte-stable snapshot (P-009). Both steps are the SAME functions
    // the coord:inbox re-bootstrap uses, so the roster never diverges.
    const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null; isSuperuser?: boolean };
    // F-M2 (workspace-data-isolation-leaks): scope=all (EVERY workspace's roster) is an
    // admin/Queen view — gate it behind superuser. A non-SU caller asking for 'all' is
    // downgraded to 'workspace' (its own), so a bee can't snoop other workspaces' agents.
    const effScope = args.scope === 'all' && !c.isSuperuser ? 'workspace' : args.scope;
    const resolved = await resolvePresenceScope(c, {
      scope: effScope,
      hive: args.hive,
      workspace: args.workspace,
    });
    // P-011: include_detail adds the cross-DB held-files lane. The lock store is
    // keyed by coordinationDomain (the repo root, not workspaceId) — resolve it
    // defensively so an anonymous caller never breaks the lean read.
    let detail: { coordinationDomain: string } | undefined;
    if (args.include_detail) {
      try {
        detail = { coordinationDomain: readIdentity(ctx).coordinationDomain };
      } catch {
        detail = undefined;
      }
    }
    const snapshot = await assemblePresenceSnapshot(resolved, {
      includeStale: args.include_stale,
      ...(detail ? { detail } : {}),
    });
    // Self-identification overlay (caller-dependent, so applied HERE, after the
    // shared/byte-stable snapshot — never inside it; see self-marker.ts): a
    // top-level `self` names the caller's own ownerId, and `isSelf:true` is
    // stamped on the caller's own row. A reader of its own roster can now tell
    // which agent is itself without a separate coord:whoami. Best-effort: an
    // unattributable caller just gets no marker (`self` omitted).
    const self = resolveSelfRef(ctx);
    const out = {
      ...snapshot,
      ...(self ? { self } : {}),
      active: markSelfRows(snapshot.active, self),
      ...(snapshot.stale ? { stale: markSelfRows(snapshot.stale, self) } : {}),
    };
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(out),
        },
      ],
    };
  },
});
