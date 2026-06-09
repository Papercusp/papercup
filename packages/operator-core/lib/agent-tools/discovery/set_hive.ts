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
import { saveOwnedHiveMeta } from '../../hive-directory-meta';
import { publishHiveToDirectory, type HiveDirectoryMeta, type HiveOwnerIdentity } from '../../hive-publish';
import { getHiveDirectory } from '../../hive-directory-deps';
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
    const meta: HiveDirectoryMeta = {
      hiveId: args.hiveId,
      title: args.title,
      description: args.description ?? '',
      visibility: args.visibility as HiveDirectoryMeta['visibility'],
      memberTopics: args.memberTopics ?? [],
      ...(args.memberLinks ? { memberLinks: args.memberLinks } : {}),
      createdAt: args.createdAt ?? Date.now(),
      ...(args.inviteSecret ? { inviteSecret: args.inviteSecret } : {}),
    };

    // Persist the listing (durable — survives restart, read by the boot-join).
    await saveOwnedHiveMeta(meta, activeWorkspaceId());

    // Announce it now (best-effort — a no-op broadcast until the boot-join wires
    // the transport; the boot-join re-announces every owned hive on its own).
    let announced = false;
    let announceError: string | undefined;
    try {
      const owner = await resolveOwnerIdentity();
      // Attach the Hive's identity pubkey (the cross-Hive dial address, P-006) for
      // the announce only — sourced from the keychain/hives table, NOT persisted in
      // the registry meta (it lives in hives.public_key).
      const { loadHivePubkey } = await import('../../identity/hive-keypair');
      const hivePubkey = await loadHivePubkey(activeWorkspaceId(), meta.hiveId).catch(() => null);
      const res = await publishHiveToDirectory(
        getHiveDirectory(),
        hivePubkey ? { ...meta, hivePubkey } : meta,
        owner,
      );
      announced = res.announced;
    } catch (e) {
      announceError = e instanceof Error ? e.message : String(e);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            hiveId: meta.hiveId,
            visibility: meta.visibility,
            saved: true,
            announced,
            ...(announceError ? { announceError } : {}),
          }),
        },
      ],
    };
  },
});

/**
 * Resolve this device's owner identity for the announce. Best-effort: the
 * announce path is non-essential (the metadata save is the durable part), so a
 * gh-unauthenticated box throws here and the tool still reports saved:true.
 */
async function resolveOwnerIdentity(): Promise<HiveOwnerIdentity> {
  const { resolveLocalAnnounceIdentity } = await import('../../sync/hyperbee/local-announce-identity');
  // The hive announce carries no log_core_key; resolveLocalAnnounceIdentity only
  // requires logCoreKeyHex to be non-empty (it builds a peer-announce body we
  // don't use), so a placeholder is fine — we only read the device identity.
  const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: '0'.repeat(64) });
  return {
    githubLogin: id.githubLogin,
    githubUserId: id.githubUserId,
    devicePubkey: id.devicePubkeyBase64,
    attestationGistId: id.attestationGistId,
  };
}
