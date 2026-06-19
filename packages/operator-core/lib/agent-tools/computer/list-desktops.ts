/**
 * computer:list_desktops — observability for the per-hive sandbox-desktop leases held in
 * THIS operator process: which hives hold a desktop and on what display/geometry. Use to
 * verify a provision landed, to grab the display for a VNC view, or to find leaks.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { hiveDesktop, leasedHiveDesktops } from './desktop-lease';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:list_desktops',
  profile: 'engineer',
  description:
    'List the sandbox-desktop leases held in this operator process — each hive that holds a desktop and its display/width/height. Use to confirm computer:provision_desktop landed or to spot a leaked lease.',
  guidance: {
    when: 'Checking which hives currently hold a sandbox desktop — after provisioning, before a VNC view, or auditing for leaks.',
    notWhen: 'Driving a desktop (capability:computer) or standing one up (computer:provision_desktop).',
    chaining: 'computer:provision_desktop → computer:list_desktops (verify) → computer:release_desktop.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel' && r !== 'overwatch'),
  args: z.object({}).strict(),
  async handler() {
    const desktops = leasedHiveDesktops().map((hive) => {
      const d = hiveDesktop(hive);
      return { hive, display: d?.display ?? null, width: d?.width ?? null, height: d?.height ?? null };
    });
    return text({ ok: true, count: desktops.length, desktops });
  },
});
