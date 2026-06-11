/**
 * POST /api/discovery/join-invite — the INVITEE side of a hive invite
 * (hive-from-repo-hardening-2026-06-11 P-006 / D-006).
 *
 * Body: { link: 'papercusp://hive?pubkey=…&secret=…&title=…' }. Parses the
 * invite artifact strictly (parseHiveInviteLink — null on anything off-shape),
 * lazily wires the hive directory if needed, and joins the invite-scoped
 * directory topic derived from the secret so the invite hive's announce is
 * ingested + listed in the Hives panel. Idempotent (the gossip topic join is).
 *
 * A box where the directory can't wire (gh-unauthenticated — no announce
 * identity) returns 503 `directory_unavailable` rather than pretending.
 *
 * `auth: 'loopback'` (auth-tier Wave 1), same perimeter as
 * /discovery/set-hive — the desktop webview is cookie-less.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { parseHiveInviteLink } from '../../../harness/hive-invite-link';

export default defineTool({
  method: 'POST',
  path: '/discovery/join-invite',
  auth: 'loopback',
  async handler(req) {
    let body: { link?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const invite = parseHiveInviteLink(String(body.link ?? ''));
    if (!invite) {
      return Response.json(
        { error: 'malformed hive invite link', code: 'invalid_link' },
        { status: 400 },
      );
    }
    const { ensureHiveDirectoryWired } = await import('../../../hive-directory-boot');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const wiring = await ensureHiveDirectoryWired(activeWorkspaceId());
    if (!wiring) {
      return Response.json(
        {
          ok: false,
          code: 'directory_unavailable',
          error: 'hive directory is not wired on this box (GitHub auth required)',
        },
        { status: 503 },
      );
    }
    try {
      await wiring.joinInviteTopic(invite.secret);
    } catch (e) {
      return Response.json(
        { ok: false, code: 'join_failed', error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
    return Response.json({ ok: true, joined: true });
  },
});
