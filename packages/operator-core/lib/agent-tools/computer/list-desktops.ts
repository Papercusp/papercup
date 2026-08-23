/**
 * computer:list_desktops — observability for the per-hive sandbox-desktop leases held in
 * THIS operator process: which hives hold a desktop and on what display/geometry. Use to
 * verify a provision landed, to grab the display for a VNC view, or to find leaks.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { hiveDesktop, leasedHiveDesktops } from './desktop-lease';
import { activeWorkspaceId } from '../../workspace-registry';
import { listDesktopSessions } from '../../desktop/desktop-session-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:list_desktops',
  profile: 'engineer',
  description:
    'List desktop sessions for this workspace from the registry — every kind (local Xvfb, frame slot, VM guest), with display/geometry, state, measured capabilities, and whether THIS process holds the live handle. Use to confirm computer:provision_desktop landed or to spot a leaked lease.',
  guidance: {
    when: 'Checking which desktops exist — after provisioning, before a VNC view, or auditing for leaks. liveHandleInThisProcess:false means the row is not backed here; it is not proof the desktop is dead.',
    notWhen: 'Driving a desktop (capability:computer) or standing one up (computer:provision_desktop).',
    chaining: 'computer:provision_desktop → computer:list_desktops (verify) → computer:release_desktop.',
    seeAlso: [
      'computer:provision_desktop (stand one up)',
      'computer:release_desktop (reclaim one)',
      'capability:computer (drive a desktop)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({}).strict(),
  async handler() {
    // In-process leases: the LIVENESS authority (these hold the actual child).
    const localByPot = new Map(
      leasedHiveDesktops().map((hive) => [hive, hiveDesktop(hive)] as const),
    );

    // P-003 (D-004): the registry is the INVENTORY, so this enumerates EVERY kind —
    // frame slots and VM guests included — not just the sessions this one process
    // happens to hold in its Map.
    let registryRows: Awaited<ReturnType<typeof listDesktopSessions>> = [];
    let registryError: string | null = null;
    try {
      registryRows = await listDesktopSessions({ workspaceId: activeWorkspaceId() });
    } catch (e) {
      // Degrade to the local view rather than failing the call — but SAY SO, so a
      // short list is never silently mistaken for "no desktops exist".
      registryError = e instanceof Error ? e.message : String(e);
    }

    const desktops = registryRows.map((s) => {
      const local = s.scope === 'pot' ? localByPot.get(s.scopeRef) : undefined;
      return {
        id: s.id,
        kind: s.kind,
        scope: s.scope,
        scopeRef: s.scopeRef,
        pot: s.scope === 'pot' ? s.scopeRef : null,
        hostRef: s.hostRef,
        display: s.display,
        width: s.displayGeometry.width,
        height: s.displayGeometry.height,
        captureWidth: s.captureGeometry.width,
        captureHeight: s.captureGeometry.height,
        state: s.state,
        capabilities: s.capabilities,
        lastActiveAt: s.lastActiveAt,
        // ⚠ D-004's invariant made visible: a row is a CLAIM about a process, not
        // proof of one. `true` only when THIS process holds the handle; `false` on a
        // remote-owned or unreconciled row — never read a row alone as liveness.
        liveHandleInThisProcess: Boolean(local),
      };
    });

    // Anything this process holds that the registry does not know about (a failed
    // best-effort write, or a pre-migration lease). Surfacing it beats pretending
    // the registry is complete.
    const registered = new Set(
      registryRows.filter((s) => s.scope === 'pot').map((s) => s.scopeRef),
    );
    const unregistered = [...localByPot.entries()]
      .filter(([hive]) => !registered.has(hive))
      .map(([hive, d]) => ({
        pot: hive,
        display: d?.display ?? null,
        width: d?.width ?? null,
        height: d?.height ?? null,
        liveHandleInThisProcess: true,
        note: 'held in this process but absent from the registry',
      }));

    return text({
      ok: true,
      count: desktops.length + unregistered.length,
      desktops,
      ...(unregistered.length > 0 ? { unregistered } : {}),
      ...(registryError ? { registryError, degraded: 'local-only' } : {}),
    });
  },
});
