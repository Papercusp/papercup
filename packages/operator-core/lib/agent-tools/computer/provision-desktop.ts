/**
 * computer:provision_desktop — equip a hive with a sandboxed GUI desktop so its bees
 * can drive it through capability:computer (computer-tool-plan Gap A — the provisioning
 * trigger). The EXPLICIT operator/Queen surface chosen for the lease lifecycle.
 *
 * Stands up an isolated Xvfb + openbox (+ any requested apps) on a free display (NEVER
 * host :0) IN THE OPERATOR PROCESS and records it in the per-hive lease Map. From then on
 * a bee in this hive whose capability:computer call lands at the operator resolves THIS
 * display via ctx.harnessSlug (the bee's spawn-env never reaches the operator-process
 * handler — that is the whole reason resolution is ctx → lease, not env).
 *
 * Idempotent: a hive that already holds a lease gets the SAME desktop back (the `apps`
 * are launched only on the first provision). Tear down with computer:release_desktop, or
 * automatically on hive:dissolve.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { ensureHiveDesktop, hiveDesktop } from './desktop-lease';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:provision_desktop',
  profile: 'engineer',
  description:
    'Provision a sandboxed GUI desktop (isolated Xvfb + openbox, never host :0) for a hive so its bees can operate it via capability:computer. Optionally launches GUI apps on it. Idempotent (returns the existing desktop; apps launch only on first provision). Tear down with computer:release_desktop or hive:dissolve.',
  guidance: {
    when: 'Equipping a hive for visual/GUI work — before a bee in that hive uses capability:computer. Pass `apps` to pre-launch the programs the bee will operate (e.g. a browser, a spreadsheet).',
    notWhen:
      'For scriptable work (files/CLIs/APIs) no desktop is needed — bees use capability:bash. On a deployed desktop FRAME the per-slot Xvfb is leased by the frame bootstrap (acquireAgentDisplay), not this tool.',
    chaining:
      'computer:provision_desktop { hive, apps } → spawn/let a bee in that hive call capability:computer → computer:list_desktops to inspect → computer:release_desktop when done.',
    seeAlso: [
      'capability:computer (drive the provisioned desktop)',
      'computer:list_desktops (verify it stood up)',
      'computer:release_desktop (reclaim when done)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  // Placement/infra authority — same allowlist as bee:spawn (operator + Queen + the SU
  // roles, NOT a worker-bee: a bee does not equip its own hive; the operator/Queen does).
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel' && r !== 'overwatch'),
  args: z
    .object({
      hive: z.string().min(1).max(120).describe("The hive's home-harness slug to equip with a desktop."),
      apps: z
        .array(z.array(z.string().min(1)).min(1).max(16))
        .max(16)
        .optional()
        .describe('GUI apps to launch on the desktop, each an argv array — e.g. [["firefox","--no-remote"],["soffice","--calc"]].'),
      width: z.number().int().positive().max(7680).optional().describe('Screen width in px (default 1024 — best computer-use grounding).'),
      height: z.number().int().positive().max(4320).optional().describe('Screen height in px (default 768).'),
    })
    .strict(),
  async handler(args) {
    const already = hiveDesktop(args.hive);
    const d = await ensureHiveDesktop(args.hive, {
      ...(args.apps ? { apps: args.apps } : {}),
      ...(args.width ? { width: args.width } : {}),
      ...(args.height ? { height: args.height } : {}),
    });
    return text({
      ok: true,
      hive: args.hive,
      display: d.display,
      width: d.width,
      height: d.height,
      reused: !!already,
      note: already
        ? 'hive already had a desktop — returned the existing lease (apps NOT re-launched).'
        : 'capability:computer for bees in this hive now resolves this display (server-side, via ctx.harnessSlug).',
    });
  },
});
