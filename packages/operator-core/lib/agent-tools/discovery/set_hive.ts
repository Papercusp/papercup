/**
 * discovery:set_hive — the hive create/edit surface (p2p-hive-directory P-004).
 *
 * Carries a hive's directory metadata (title + description + visibility +
 * member harness topics) and, on save, announces it per its visibility:
 * `public` → the global directory topic, `invite` → an invite-scoped topic,
 * `private` → never announced. The metadata persists in the workspace registry
 * (hive-directory-meta.ts); the announce rides the live directory singleton
 * (a no-op broadcast until the substrate boot-join wires the transport).
 *
 * Idempotent create-or-edit: calling again with the same hiveId edits +
 * re-announces (the directory converges on the newer ts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { HIVE_VISIBILITIES } from '../../sync/hyperbee/hive-announce';
import type { HiveDirectoryMeta } from '../../hive-publish';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'discovery:set_hive',
  description:
    "Create or edit a hive's P2P directory listing — title, description, and visibility (public = announce to the global directory; invite = invite-scoped topic only; private = never announced). Saves the metadata to the workspace registry and announces it per visibility so peers can browse + join it.",
  capability: 'discovery:write',
  guidance: {
    when: 'You want to publish a hive to the P2P directory so other peers can discover + join it, or edit an existing listing (title/description/visibility).',
    notWhen:
      'To deploy a hive’s execution frames use deploy:hive. To browse OTHERS’ hives use discovery:hives. Setting visibility:private withdraws a hive from the directory (it stops being re-announced; peers age it out via TTL).',
  },
  requirePrincipal: false,
  args: z.object({
    hiveId: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    visibility: z.enum(HIVE_VISIBILITIES as unknown as [string, ...string[]]).default('public'),
    /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
    memberTopics: z.array(z.string().min(1)).max(64).optional(),
    /** Full papercusp://harness?... join links per member harness (one-click join). */
    memberLinks: z.array(z.string().min(1)).max(64).optional(),
    /** Required for visibility:invite — the secret whose topic invitees join. */
    inviteSecret: z.string().min(1).optional(),
    /** Epoch-ms created stamp (defaults to now on first create). */
    createdAt: z.number().int().positive().optional(),
  }),
  async handler(args) {
    // The composition (save → withdraw|publish) is shared with the HTTP face
    // (POST /api/discovery/set-hive) — one flip surface (P-015).
    const { setHiveListing } = await import('../../hive-set-listing');
    const res = await setHiveListing(
      {
        hiveId: args.hiveId,
        title: args.title,
        description: args.description,
        visibility: args.visibility as HiveDirectoryMeta['visibility'],
        ...(args.memberTopics ? { memberTopics: args.memberTopics } : {}),
        ...(args.memberLinks ? { memberLinks: args.memberLinks } : {}),
        ...(args.inviteSecret ? { inviteSecret: args.inviteSecret } : {}),
        ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      },
      activeWorkspaceId(),
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
