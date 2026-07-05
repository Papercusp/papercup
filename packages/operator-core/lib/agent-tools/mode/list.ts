/**
 * mode:list — the mode catalog: every official mode's id, axis, and one-liner,
 * plus which ones YOU currently have active
 * (modes-and-intake-ux-2026-07-05 P-006/P-008).
 *
 * This is the cheap INDEX (P-008 context diet): one line per mode. The full
 * binding contract loads at activation — mode:set returns it; coord:orient
 * re-injects active contracts each wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { MODES } from '../../modes/registry';
import { getModes } from '../../modes/store';

export default defineTool({
  name: 'mode:list',
  profile: 'engineer',
  description:
    'The official mode catalog: id, axis (autonomy | work-source | overlay), one-liner, and which modes you have ' +
    'active. Same-axis modes exclude each other (mode:set auto-switches); cross-axis modes stack.',
  guidance: {
    when: 'Orienting on what modes exist / which apply to a user ask, before offering one or calling mode:set.',
    notWhen: 'Reading a PEER’s modes — that is mode:get { agent } (or coord:presence ambiently).',
    chaining: 'mode:list → mode:set { mode, reason } → read the returned contract.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const active = await getModes(ident.workspaceId ?? 'default', ident.ownerId).catch(() => []);
    const activeIds = new Set(active.map((r) => r.mode));
    const catalog = MODES.map((m) => ({ mode: m.id, axis: m.axis, title: m.title, oneLiner: m.oneLiner, active: activeIds.has(m.id) }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          axes: 'same-axis modes exclude each other (auto-switch on set); cross-axis modes stack; overlays stack with everything',
          modes: catalog,
        }),
      }],
    };
  },
});
