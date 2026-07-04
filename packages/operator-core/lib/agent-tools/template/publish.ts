/**
 * template:publish — list a repo-authored template on the Comb
 * (app-templates-2026-07-04 P-010).
 *
 * The publish entry point for templates, mirroring `blueprint:publish`: it
 * resolves the repo's GitHub coords and publishes a `kind='template'` listing
 * (listing_ref = templateId) through THE shared Cupboard publish core
 * (gh token + channel-2 attestation). The install side is
 * cupboard/install-template-core.ts (+ POST /api/cupboard/install-template);
 * this closes the loop by adding the way to promote a repo `templates/<id>/`
 * dir to a published listing.
 *
 * REPO-BACKED, DELTA-NOT-COPY: the listing points at the repo location
 * (`templates/<listing_ref>/`); the publish never materializes or flattens
 * the template — installers clone the repo at install time, so the listing
 * inherits repo improvements until re-pinned.
 *
 * Review policy (D-007): a `template` listing lands PENDING and is publicly
 * invisible until an operator approves it — its GUIDE.md is a composition
 * prompt injected into the building agent's context (instruction-carrying,
 * exactly the learning-pack/blueprint rationale).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { validateTemplateManifest } from '@papercusp/template-kit';
import { activeWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'template:publish',
  capability: 'harness:write',
  description:
    "List a repo-authored template on the Comb: resolves the repo's GitHub coords + publishes a kind='template' listing (listing_ref = templateId, pointing at <repo>/templates/<id>/) with the operator's gh token + attestation. REPO-BACKED — installers clone the repo, so the listing tracks the repo until re-pinned. Lands PENDING (D-007) — an operator must approve it before it is publicly visible.",
  guidance: {
    when: 'Sharing a template you authored — a {components + GUIDE.md + checks} dir living at <repo>/templates/<id>/ — so agents on other installs can install + compose from it via the Cupboard Templates section.',
    notWhen:
      'Browsing/installing templates (the Cupboard Templates section / POST /api/cupboard/install-template); authoring one (edit the repo templates/<id>/ dir — see agent-insights/templates-system-design); or when the template files are not on GitHub yet — publish points at the repo, so commit + push first.',
    chaining:
      "Run after the template dir is committed + pushed via the project's normal flow. The response carries review_status=pending — operators approve at /admin/cupboard-moderation; once approved it installs to ~/.papercusp/templates/<id>/ like any repo-backed listing.",
    seeAlso: ['blueprint:publish (the sibling publish for blueprints)'],
  },
  crossWorkspace: true,
  args: z.object({
    templateId: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'The template id to list — its dir is <repoDir>/templates/<templateId>/, and it becomes the Comb listing_ref.',
      ),
    // The Cupboard worker hard-caps title at 200 and description at 280
    // (listings.ts publish validation) — enforce HERE so a too-long value
    // fails at the tool boundary with a clear message instead of an opaque
    // worker `invalid_field` 400 that also burns a publish rate-limit slot.
    title: z.string().min(1).max(200).describe('Listing title (≤200 chars — the worker cap).'),
    description: z.string().min(1).max(280).describe('Listing description (≤280 chars — the worker cap).'),
    repoDir: z
      .string()
      .min(1)
      .describe(
        'Absolute path of the repo (its origin remote names the GitHub repo; must contain templates/<templateId>/template.yaml).',
      ),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    // 1. The template must already be a file tree in the repo (repo-backed:
    //    we list it, never materialize/flatten it). Validate the manifest
    //    locally BEFORE listing — publishing a template whose template.yaml
    //    doesn't parse would strand every installer at clone time.
    const tplYaml = join(args.repoDir, 'templates', args.templateId, 'template.yaml');
    if (!existsSync(tplYaml)) {
      return text({
        ok: false,
        error: 'template_not_in_repo',
        hint: `Expected ${tplYaml}. Author the template into the repo's templates/<id>/ and push it before publishing.`,
      });
    }
    let manifestScope: string | undefined;
    try {
      const parsed = parseYaml(readFileSync(tplYaml, 'utf8'));
      const check = validateTemplateManifest(parsed);
      if (!check.ok) {
        return text({ ok: false, error: 'template_manifest_invalid', detail: check.errors.join('; ') });
      }
      manifestScope = (parsed as { scope?: string }).scope;
    } catch (e) {
      return text({
        ok: false,
        error: 'template_manifest_unreadable',
        detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }

    // 2. Resolve the repo's GitHub coords — the SAME path blueprint:publish uses.
    const { resolveRepoCoordsFromDir, gitOriginUrl, fetchGithubRepoMeta } = await import(
      '../../cupboard/resolve-repo-coords'
    );
    const coords = await resolveRepoCoordsFromDir(args.repoDir, {
      getOriginUrl: gitOriginUrl,
      fetchRepoMeta: fetchGithubRepoMeta,
    });
    if (!coords || 'error' in coords) {
      return text({
        ok: false,
        error: 'repo_coords_unresolvable',
        ...(coords && 'error' in coords ? { detail: coords.error } : {}),
        hint: 'repoDir must be a git repo with a GitHub origin remote.',
      });
    }

    // 3. Publish the kind='template' listing through the one shared Cupboard core.
    const { publishListingToCupboard } = await import('../../cupboard/publish-listing');
    const result = await publishListingToCupboard({
      listing_kind: 'template',
      listing_ref: args.templateId,
      project_ref: `${coords.github_owner}/${coords.github_name}`,
      github_repository_id: coords.github_repository_id,
      github_owner: coords.github_owner,
      github_name: coords.github_name,
      github_url: coords.github_url,
      title: args.title,
      description: args.description,
    });
    if (!result.ok) {
      return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.data as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      scope: manifestScope,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an operator must approve it before it is publicly visible (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});
