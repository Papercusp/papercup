/**
 * pot:create_from_repo — create a Hive FROM a GitHub URL
 * (hive-from-github-url-2026-06-11 P-006; the headline Entry-2-at-Hive-level
 * flow). Paste a URL → repo→Hive lookup (join offer when one exists) → clone →
 * test-verified blueprint detection → Hive home + member harness → auto-publish.
 * Visibility is DERIVED from the repo: public repo → discoverable directory
 * listing; private repo → 'invite' (hidden, secret-gated), surfaced as "Private".
 *
 * ROOT-ONLY like pot:create — hives are peers, never nested.
 * The composition lives in `_create_from_repo.ts` (seam-injected, unit-tested);
 * this is the guard + arg surface. The HTTP face for the CreateHarnessPicker is
 * POST /harness/pots/from-repo (routes/harness/projects.ts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { createHiveFromRepo } from './_create_from_repo';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:create_from_repo',
  profile: 'engineer',
  description:
    'Create a Hive FROM a GitHub URL: repo→Hive lookup first (an existing Hive returns a JOIN OFFER, zero side effects), then clone, blueprint detect + test-verify, Hive home + first member harness, upstream coords stamped, auto-publish. Visibility is derived from the repo: public repo → discoverable directory listing; private repo → Private (invite-only, hidden, secret-gated). Returns {ok, existing?} or {ok, created:{hiveSlug, memberSlug, memberPath}, publish}.',
  guidance: {
    when: 'Onboarding a GitHub repository as a NEW Hive in one call — the paste-a-URL creation flow. Also the backend the CreateHarnessPicker GitHub-URL entry drives.',
    notWhen:
      'The repo may already have a Hive and you only want the answer — lookup happens inside, but a read-only check is the picker flow. An existing LOCAL repo — harness:generate-from-repo. A repo-less hive — pot:create. Adding a repo into an EXISTING hive — harness:create { hive } after cloning (the into-hive picker mode).',
    chaining:
      'pot:create_from_repo { githubUrl } → on {existing} drive the join (POST /api/harness/join-link per member link) → on {created} pot:get / discovery:set_hive to edit the listing.',
    seeAlso: [
      'pot:create (stand up a hive without a repo)',
      'pot:get (inspect / edit the created hive)',
      'discovery:set_hive (edit the public listing)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    githubUrl: z.string().min(1).max(500).describe('The GitHub repo URL (https or git@).'),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .optional()
      .describe('Base slug (default: repo name). Member = <base>, Hive home = <base>-hive; auto-suffixed on collision.'),
    shallow: z.boolean().optional().describe('Shallow clone (--depth 1) for large repos.'),
    runTests: z.boolean().default(false).describe('OPT-IN: run the detected test command once to verify it — this EXECUTES CODE from the pasted repo (hardening D-001). Default false; verify after create via harness:generate-from-repo on the clone if preferred.'),
    testTimeoutMs: z.number().int().positive().optional().describe('Budget for the test-verify run (default 120s).'),
    parentDir: z.string().min(1).optional().describe('Parent dir for the HIVE HOME folder (default ~/.papercusp/hives).'),
    force: z
      .boolean()
      .optional()
      .describe('Create-anyway past an existing hive/share for this repo (P-008): the result is flagged duplicateOf for the claim/supersede flow. Default false — an existing hive returns a join offer instead.'),
    intoHive: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("P-009 into-hive mode: add the repo as a member of this EXISTING kind:'hive' home instead of standing up a new hive (no new identity/listing; the existing listing re-publishes with the new member)."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (mirrors pot:create D-002): hives are peers, never nested.
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_create_root_only',
        message:
          'pot:create_from_repo cannot be called from a bee (a spawned/parented agent). Hives are peers, never nested.',
      });
    }

    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );
    const res = await createHiveFromRepo({
      githubUrl: args.githubUrl,
      ...(args.slug ? { slug: args.slug } : {}),
      ...(args.shallow !== undefined ? { shallow: args.shallow } : {}),
      runTests: args.runTests,
      ...(args.testTimeoutMs ? { testTimeoutMs: args.testTimeoutMs } : {}),
      ...(args.parentDir ? { parentDir: args.parentDir } : {}),
      ...(args.force !== undefined ? { force: args.force } : {}),
      ...(args.intoHive ? { intoHive: args.intoHive } : {}),
      workspaceId,
    });
    return text(res as unknown as Record<string, unknown>);
  },
});
