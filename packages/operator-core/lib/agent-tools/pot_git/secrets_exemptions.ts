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
    "Owner: the RUNTIME (no-restart) escape hatch for the git-sync own-head publish guard's secrets scanner (WI-5591) — clears a false-positive that would otherwise permanently freeze git egress for the hive. Actions: list {} — every exempted path + reason/who/when | add {path, reason} — exempt a repo path from the secrets scan starting the NEXT git-sync tick | remove {path} — re-arm scanning for a path. This is a data-driven sibling of secrets-guard.ts's hardcoded FIXTURE_FILES set; use it INSTEAD of editing that source + restarting papercup-bg-host.",
  capability: 'audit:write',
  guidance: {
    when:
      "own_head_publish.refused === 'secrets' (readable at harness_shared.routines.metadata->'own_head_publish'->>'refused', or git-sync's own console warning) AND you've confirmed the flagged finding is a false positive (a detector fixture, a documented example credential, a placeholder — never a REAL live secret) — {action:'add', path, reason}. Check {action:'list'} first so you don't duplicate an existing exemption.",
    notWhen:
      "The finding might be a genuine leaked credential — rotate/revoke it and fix the source instead of exempting the path. A repeat false-positive class across many paths (not one specific file) — that calls for a rule-precision fix in secrets-guard.ts itself, not N one-off exemptions here.",
    chaining:
      "{action:'list'} → confirm the path isn't already exempt → {action:'add', path, reason} → the next git-sync tick (or dev:restart of the affected host if you need it sooner) retries the publish.",
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
        .describe('Workspace id. Defaults to the active workspace when omitted.'),
      path: z
        .string()
        .optional()
        .describe("Exact repo-relative path (matches secrets-guard.ts's FIXTURE_FILES semantics exactly). Required for action:'add'/'remove'."),
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
    const principalWs = ctx?.principal?.workspaceId;
    const ws = args.workspaceId ?? (principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId());
    const createdBy = ctx?.principal?.id ?? ctx?.principal?.workspaceId ?? 'agent';
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
