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
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { resolvePresenceScope, assemblePresenceSnapshot } from '../presence-snapshot';
import { readIdentity } from '../../locks/identity';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { shapeCoordPresence } from './presence-shape';
import { COORD_ROLES } from '../roles';
import { getModesForOwners } from '../../../modes/store';

export default defineTool({
  name: 'coord:presence',
  description:
    'List coordination agents and whether each can take work now. Active rows are the actionable roster; ended rows are excluded except in an owner-targeted lookup. Read summary.wakeable plus each row\'s sessionState and wakeable before dispatching. Defaults to your hive; admins/queen may widen scope. Re-poll cheaply with since:<etag>.',
  guidance: {
    when: 'Use before dispatch or handoff to see who is live, parked, wakeable, and already occupied. Parked + wakeable is the normal dispatch target; ended needs relaunch. Pass owner:<id> for one specific agent.',
    notWhen: 'Not for file freedom (locks:queue), not as a default every-turn poll when coord deltas already cover changes, and not for a full historical ended-agent dump.',
    chaining:
      'Read once, then follow coord deltas. If you must re-poll, pass since:<etag>; unchanged state returns a tiny stub instead of the full roster.',
    // Result-aware (D-003): the who-was-ever-here history pointer surfaces with the
    // REAL ended count ONLY when the roster has dead sessions — the "N ended → history"
    // discovery pointer WI-1348 asks for. The adjacent-lens pointers are always
    // relevant, so they stay static in the returned list.
    seeAlso: (result) => {
      const j = readJsonResult<{ summary?: { byState?: { ended?: number } } }>(result);
      // seeAlso runs on the SERIALIZED result — on the MCP transport the {data}
      // envelope may be TOON (readJsonResult → undefined). TOON renders nested
      // scalars as `ended: N` lines, so a cheap regex keeps the conditional
      // pointer alive on compact responses too (fail-open to 0).
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const ended =
        j?.summary?.byState?.ended ??
        Number(/\bended\b["']?\s*:\s*(\d+)/.exec(text)?.[1] ?? 0);
      const out: SeeAlsoEntry[] = [
        'coord:roster { view:"live" } (the unified presence/roster door with lenses)',
        'coord:glance (one-line fleet headline for a status surface)',
        'coord:dispatch (wake/dispatch a parked agent you spotted)',
      ];
      if (ended > 0) {
        out.push({
          tool: 'coord:roster',
          selector: '{ view:"history" }',
          reason: `${ended} ended — who-was-ever-here`,
        });
      }
      return out;
    },
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe('hive (DEFAULT) = your Hive\'s agents + federated peers for it; workspace = the whole workspace; all = every workspace (admin/Mug). A caller with no Hive (SU/operator) falls back to workspace.'),
    hive: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z
      .string()
      .optional()
      .describe('Workspace id for workspace/hive scope; omit to use the caller\'s.'),
    owner: z
      .string()
      .optional()
      .describe('TARGETED lookup: return ONLY the row(s) matching this agent id/label (exact, else a substring either-way) — and INCLUDE it even if `ended`. The replacement for the removed `include_stale` full dump: use it to inspect/wake ONE specific dead agent, never to expand the whole stale roster.'),
    include_detail: z
      .boolean()
      .optional()
      .describe('P-011 Tier-2/3 detail: add each agent\'s `heldFiles` (its live file-lock nodes, read from the separate papercusp_su lock DB — opt-in + fail-soft). Off by default; the lean roster already carries the Tier-1 scalars.'),
    since: z
      .string()
      .optional()
      .describe('CHEAP UNCHANGED-READ (poll-storm guard): pass the `etag` from your PRIOR coord:presence read. If the roster\'s identity+state (intent / plan / claimed lane / await / fleet membership — NOT liveness) is unchanged, you get back a ~100B `{ unchanged:true, etag, as_of }` instead of the full 20KB roster. Read once, then re-read with `since:<etag>` and only pay the full payload when it actually changed. Liveness (live↔parked, lastActiveSecAgo) is deliberately NOT tracked by the etag — re-read WITHOUT `since:` right before you actually dispatch.'),
  }),
  // context-trimming-tiers P-022: trimmed/standard sessions get projected roster
  // rows (dispatch core only — see presence-shape.ts); summary stays verbatim.
  // The pui reads this over HTTP (no ctx_tier) → always full.
  shape: {
    standard: (data) => shapeCoordPresence(data, 'standard'),
    trimmed: (data) => shapeCoordPresence(data, 'trimmed'),
  },
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
      ...(args.owner ? { owner: args.owner } : {}),
      ...(detail ? { detail } : {}),
    });
    // P-006 `since:` short-circuit — if the caller passes the etag from its prior read
    // and the delta-eligible roster (identity+state) is byte-identical, return a ~100B
    // stub instead of the full payload. Liveness churn (heartbeat / live↔parked) is
    // deliberately excluded from the etag (D-005/D-006), so a poll that only wants "did
    // anything actionable change" stays cheap; a caller about to DISPATCH re-reads
    // without `since:` to get fresh liveness. An `owner`-targeted read still honors it.
    if (args.since && args.since === snapshot.etag) {
      return {
        data: {
          unchanged: true,
          etag: snapshot.etag,
          as_of: snapshot.as_of,
          scope: snapshot.scope,
          note: 'roster identity+state unchanged since your etag; liveness (live↔parked) is not tracked here — re-read without since: before you dispatch',
        },
      };
    }
    // Self-identification overlay (caller-dependent, so applied HERE, after the
    // shared/byte-stable snapshot — never inside it; see self-marker.ts): a
    // top-level `self` names the caller's own ownerId, and `isSelf:true` is
    // stamped on the caller's own row. A reader of its own roster can now tell
    // which agent is itself without a separate coord:whoami. Best-effort: an
    // unattributable caller just gets no marker (`self` omitted).
    const self = resolveSelfRef(ctx);
    // modes-and-intake-ux-2026-07-05 P-007: ambient mode visibility — attach each
    // ACTIVE row's official modes (e.g. modes:['auto','grade']) in ONE batched read,
    // AFTER the byte-stable snapshot (mode churn is deliberately etag-excluded, same
    // as liveness churn — a `since:` stub may lag a mode flip; mode:get is the fresh
    // point read). Best-effort: a mode-read failure never degrades the roster.
    let active = markSelfRows(snapshot.active, self);
    try {
      const ids = active.map((r) => String((r as { ownerId?: unknown }).ownerId ?? '')).filter(Boolean);
      if (ids.length) {
        const modeMap = await getModesForOwners(c.workspaceId ?? 'default', ids);
        if (modeMap.size) {
          active = active.map((r) => {
            const m = modeMap.get(String((r as { ownerId?: unknown }).ownerId ?? ''));
            return m?.length ? { ...r, modes: m.map((x) => x.mode) } : r;
          });
        }
      }
    } catch { /* fail-soft */ }
    const out = {
      ...snapshot,
      ...(self ? { self } : {}),
      active,
    };
    // {data} envelope so the payload-tier shapers apply; HTTP consumers (the
    // pui roster panes) still read identical lossless JSON text.
    return { data: out };
  },
});
