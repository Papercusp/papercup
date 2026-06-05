/**
 * POST /api/cupboard/publish-plugin — publish an installed plugin TO the Cupboard
 * as a `kind=plugin` listing (revive-cupboard-distribution-2026-06-04 D-003 / P2).
 *
 * The cupboard-publish primitive already accepts `listing_kind=plugin` +
 * `listing_ref`; nothing called it for plugins until now. A plugin listing is
 * GitHub-repo-backed: it points at the plugin's repo (+ `listing_ref` = the
 * plugin slug). We resolve the repo coords from an explicit `github_url` or from
 * the installed plugin dir's `origin` remote, default title/description from the
 * manifest, then publish via the shared listing-publish core.
 *
 * Body: { slug, github_url?, project_ref?, listing_ref?, title?, description? }
 *   - slug         the installed plugin's manifest name (used as listing_ref unless overridden)
 *   - github_url   override the repo (else resolved from the installed plugin's git origin)
 *
 * `auth: 'public'` — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { findInstalledPlugin } from '../../cupboard/plugin-listings';
import { publishListingToCupboard } from '../../cupboard/publish-listing';
import {
  resolveRepoCoordsFromDir,
  parseGithubRemote,
  gitOriginUrl,
  fetchGithubRepoMeta,
  type RepoCoords,
} from '../../cupboard/resolve-repo-coords';

export default defineTool({
  method: 'POST',
  path: '/cupboard/publish-plugin',
  auth: 'public',
  async handler(req) {
    let body: {
      slug?: string;
      github_url?: string;
      project_ref?: string;
      listing_ref?: string;
      title?: string;
      description?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const slug = String(body.slug ?? '').trim();
    if (!/^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(slug)) {
      return Response.json({ ok: false, error: `invalid plugin slug "${slug}"` }, { status: 400 });
    }

    const installed = await findInstalledPlugin(slug);

    // Resolve the plugin repo's GitHub coords: explicit github_url wins, else the
    // installed plugin dir's `origin` remote.
    let coords: RepoCoords | { error: string };
    if (typeof body.github_url === 'string' && body.github_url.trim()) {
      const parsed = parseGithubRemote(body.github_url.trim());
      if (!parsed) {
        return Response.json({ ok: false, error: `invalid github_url "${body.github_url}"` }, { status: 400 });
      }
      const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
      coords = meta
        ? {
            github_repository_id: meta.id,
            github_owner: parsed.owner,
            github_name: parsed.repo,
            github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
          }
        : { error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` };
    } else if (installed) {
      coords = await resolveRepoCoordsFromDir(installed.path, {
        getOriginUrl: gitOriginUrl,
        fetchRepoMeta: fetchGithubRepoMeta,
      });
    } else {
      return Response.json(
        { ok: false, error: `plugin "${slug}" is not installed and no github_url was given` },
        { status: 404 },
      );
    }

    if ('error' in coords) {
      return Response.json({ ok: false, error: coords.error }, { status: 422 });
    }

    const result = await publishListingToCupboard({
      listing_kind: 'plugin',
      listing_ref: typeof body.listing_ref === 'string' && body.listing_ref.trim() ? body.listing_ref.trim() : slug,
      project_ref: typeof body.project_ref === 'string' ? body.project_ref : undefined,
      ...coords,
      title: typeof body.title === 'string' ? body.title : (installed?.name ?? slug),
      description:
        typeof body.description === 'string'
          ? body.description
          : typeof installed?.description === 'string'
            ? installed.description
            : undefined,
    });

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error, detail: result.detail, upstream_status: result.upstream_status },
        { status: result.status },
      );
    }
    return Response.json({ ok: true, listing: result.data });
  },
});
