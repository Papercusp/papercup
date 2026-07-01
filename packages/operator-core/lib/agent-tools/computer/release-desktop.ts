/**
 * computer:release_desktop — tear down a hive's sandbox desktop (kill the in-process
 * Xvfb + apps, free the display) without dissolving the hive. The inverse of
 * computer:provision_desktop. hive:dissolve also releases automatically (step 3.6); this
 * is the standalone teardown for a demo / when a hive no longer needs GUI work.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { hiveDesktop, releaseHiveDesktop } from './desktop-lease';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:release_desktop',
  profile: 'engineer',
  description:
    "Tear down a hive's sandbox desktop (kill its Xvfb + apps, free the display) without dissolving the hive. Idempotent — a no-op if the hive holds no desktop. (hive:dissolve releases automatically.)",
  guidance: {
    when: 'A hive is done with GUI work but stays alive — reclaim the Xvfb/display. Also good demo hygiene after computer:provision_desktop.',
    notWhen: 'Tearing down the whole hive — hive:dissolve already releases the desktop. There is nothing to release if the hive never provisioned one.',
    chaining: 'computer:list_desktops to see what is leased → computer:release_desktop { hive }.',
    seeAlso: [
      'computer:list_desktops (see what is leased first)',
      'computer:provision_desktop (stand one back up)',
      'hive:dissolve (tears down the whole hive incl desktop)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel' && r !== 'overwatch'),
  args: z
    .object({
      hive: z.string().min(1).max(120).describe("The hive's home-harness slug whose desktop to release."),
    })
    .strict(),
  async handler(args) {
    const had = !!hiveDesktop(args.hive);
    await releaseHiveDesktop(args.hive);
    return text({ ok: true, hive: args.hive, released: had, note: had ? 'desktop torn down.' : 'no desktop was leased (no-op).' });
  },
});
