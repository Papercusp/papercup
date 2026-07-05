/**
 * pot:beacon_consent — owner/Queen management of a Hive's beacon-publish consent
 * (hive-network-surface-2026-06-11 P-005 / brief B-07; contract C-2).
 *
 * The agent-surface twin of the desktop consent UX (the creation-form checkbox +
 * the hive header toggle): enable / disable / read whether THIS Hive publishes a
 * live status beacon (active agents · queue depth · focus) onto the directory
 * gossip. Owner-consent, DEFAULT-OFF (D-002) — absent = OFF. Consent lives in
 * hive_settings (federates to every Swarm of the Hive) and is the gate B-06's
 * publisher (`maybeBuildHiveBeacon`) checks before a beacon rides the re-announce.
 *
 * Sibling of `pot:cross_grant` (the other owner hive_settings policy verb).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { getBeaconPublishConsent, setBeaconPublishConsent } from '../../beacon-consent';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'pot:beacon_consent',
  profile: 'engineer',
  description:
    "Manage whether THIS Hive publishes a live status beacon (active agents, queue depth, focus, last-completed) onto the directory gossip — the owner-consent gate, default-OFF (D-002). Pass `consent` to set it (true = publish, false = stop); omit `consent` to read the current state. The consent federates to every Swarm of the Hive and gates B-06's beacon publisher. The beacon only rides a PUBLISHED (public/invite) hive's re-announce — enabling it on a private hive has no effect until the hive is published.",
  guidance: {
    when: "Enabling, disabling, or checking this Hive's status-beacon publishing — the same consent the desktop publish-flow asks for, managed from the agent surface. Pass consent:true to opt a published hive into the beacon, consent:false to withdraw it, or omit consent to read the current value.",
    notWhen:
      "Directory visibility (public/invite/private) — that's discovery:set_hive. Cross-Hive ask/work-request grants — pot:cross_grant. Within-Hive coordination — coord:* / topics.",
    chaining:
      "discovery:set_hive { visibility:'public' } (make the hive discoverable) → pot:beacon_consent { hive, consent:true } (opt the now-public hive into the live beacon).",
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z
      .string()
      .min(1)
      .max(120)
      .describe("This Hive's home slug (consent is Hive-scoped + federates to its Swarms)."),
    consent: z
      .boolean()
      .optional()
      .describe('true = publish a status beacon; false = stop. Omit to just READ the current consent (absent = OFF).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    if (args.consent === undefined) {
      return json({ ok: true, action: 'get', hive: args.hive, consent: await getBeaconPublishConsent(ws, args.hive) });
    }
    try {
      await setBeaconPublishConsent(ws, args.hive, args.consent);
    } catch (e) {
      // setHiveSetting rejects when the hive doesn't exist (logical scope, no FK).
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), hive: args.hive });
    }
    return json({ ok: true, action: 'set', hive: args.hive, consent: args.consent });
  },
});
