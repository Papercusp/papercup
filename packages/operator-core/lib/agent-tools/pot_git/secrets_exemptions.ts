/**
 * pot_git:secrets_exemptions — WI-5591: the operator/agent lever for the
 * own-head publish guard's RUNTIME secrets-guard path exemption table
 * (harness_shared.secrets_guard_path_exemptions, migration 644).
 *
 * Root cause this tool exists to close: a false-positive credential-shape
 * match in the publish-guard secrets scanner permanently freezes ALL git
 * egress for a hive (own_head_publish.refused:'secrets') because the guard
 * baseline never advances past a refused range — the SAME historical blob is
 * rescanned and re-refused forever. Before this table, the only remedy was a
 * human editing the hardcoded FIXTURE_FILES source Set and restarting
 * papercup-bg-host. This tool lets an agent (or the operator UI later)
 * add/list/remove a path exemption directly — no code edit, no restart; the
 * very next git-sync tick picks it up.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'pot_git:secrets_exemptions',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    "Owner: the RUNTIME (no-restart) escape hatch for the pot-git secrets scanner (WI-5591) — clears a false positive that would otherwise permanently freeze git egress for the hive. Covers BOTH the own-head publish guard and the GitHub-bridge EGRESS guard (WI-5738). Actions: list {} | add {path, reason} — exempt from the scan starting the NEXT git-sync tick | remove {path} — re-arm.",
  capability: 'audit:write',
  guidance: {
    when:
      "own_head_publish.refused === 'secrets' (harness_shared.routines.metadata->'own_head_publish'->>'refused') AND you have ADJUDICATED the flagged finding as a false positive (a detector fixture, a documented example credential, a placeholder — never a REAL live secret) — {action:'add', path, reason}.",
    notWhen:
      "The finding might be a genuine leaked credential — rotate/revoke it and fix the source instead. A false-positive class across many DIFFERENT trees — that needs a rule fix in secrets-guard.ts, not N exemptions. A prefix is a broad waiver: scope it to the actual accident.",
    chaining:
      "{action:'list'} (don't duplicate a row) → ADJUDICATE: `npx tsx scripts/adjudicate-publish-refusal.mts --commit <own_head_publish.blockedAtCommit> --exemptions` replays the guard and prints every finding it saw, so 'false positive' is MEASURED, not assumed — exit 2 means the scanner is UNUSABLE, never read that as clean → {action:'add', path, reason} → the next git-sync tick (or dev:restart) retries the publish.",
    seeAlso: ['pot_git:integration_requests (a different G-10-adjacent queue — below-tier member heads, not secrets)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      action: z.enum(['list', 'add', 'remove']),
      workspaceId: z
        .string()
        .optional()
        .describe('Workspace id — UNSCOPED (--all-workspaces) sessions only; a workspace-scoped session always acts on its own workspace and is refused if this names another. Defaults to the active workspace when omitted.'),
      path: z
        .string()
        .optional()
        .describe("Repo-relative path: an exact file, or a directory prefix (`dir/` / `dir/**`) to exempt a whole tree (WI-5738 — one bad extraction was 4,174 files). Required for action:'add'/'remove'."),
      reason: z
        .string()
        .optional()
        .describe("Why this path is a false positive. Required for action:'add' (recorded for audit)."),
    })
    .refine((a) => a.action !== 'add' || (Boolean(a.path) && Boolean(a.reason)), {
      message: "action:'add' needs path and reason",
    })
    .refine((a) => a.action !== 'remove' || Boolean(a.path), {
      message: "action:'remove' needs path",
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const {
      listSecretsGuardPathExemptions,
      addSecretsGuardPathExemption,
      removeSecretsGuardPathExemption,
    } = await import('../../sync/pot-git/secrets-guard-exemptions');
    // SELF-CONFINEMENT (WI-6641). `crossWorkspace: true` above exists ONLY so an
    // UNSCOPED psu gets the getOrgPg admin handle (this table is not RLS-scoped) —
    // the same reason memory:* and autonomy:record_disposition carry it. For that to
    // be true rather than merely intended, a SCOPED principal must be unable to reach
    // another workspace's rows: refuse an explicit `workspaceId` that names one, and
    // pin `ws` to the principal's own workspace. Refuse rather than silently clamp —
    // a waiver written to a workspace the caller did not name is worse than an error.
    // This is what makes the tool eligible for SCOPED_SAFE_CROSSWORKSPACE, so the
    // agents who actually trip the guard can run the documented recovery.
    const principalWs = ctx?.principal?.workspaceId;
    const scopedWs = principalWs && principalWs !== '*' ? principalWs : null;
    if (scopedWs && args.workspaceId && args.workspaceId !== scopedWs) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `workspace_forbidden: this session is scoped to workspace "${scopedWs}" and cannot target "${args.workspaceId}". Omit workspaceId to act on your own workspace, or use an unscoped (--all-workspaces) superuser session to target another.`,
        }],
      };
    }
    const ws = scopedWs ?? args.workspaceId ?? activeWorkspaceId();
    const createdBy = ctx?.principal?.slug ?? ctx?.principal?.workspaceId ?? 'agent';
    let payload: Record<string, unknown>;
    if (args.action === 'list') {
      const exemptions = await listSecretsGuardPathExemptions(ws);
      payload = { ok: true, workspaceId: ws, count: exemptions.length, exemptions };
    } else if (args.action === 'add') {
      await addSecretsGuardPathExemption({ workspaceId: ws, path: args.path!, reason: args.reason!, createdBy: String(createdBy) });
      payload = { ok: true, workspaceId: ws, added: args.path };
    } else {
      await removeSecretsGuardPathExemption(ws, args.path!);
      payload = { ok: true, workspaceId: ws, removed: args.path };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
