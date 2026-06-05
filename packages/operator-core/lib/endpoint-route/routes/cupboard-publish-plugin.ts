/**
 * POST /api/cupboard/publish-plugin — publish an installed distribution unit
 * (plugin OR runtime-less code-tool pack) TO the Cupboard as a `kind=plugin` /
 * `kind=pack` listing (revive-cupboard-distribution-2026-06-04 D-003 / P2;
 * pack kind: tool-distribution-granularity-2026-06-05 P-005).
 *
 * The cupboard-publish primitive already accepts `listing_kind` +
 * `listing_ref`; the listing kind follows the installed manifest's `kind`
 * field ('pack' → kind=pack listing, else plugin). A unit listing is
 * GitHub-repo-backed: it points at the unit's repo (+ `listing_ref` = the
 * unit slug). We resolve the repo coords from an explicit `github_url` or from
 * the installed unit dir's `origin` remote, default title/description from the
 * manifest, and declare the unit's tools (`provides_tools` — explicit body
 * value, else derived from the manifest's `tools[]`) so the Cupboard's
 * tool→provider discovery can resolve each tool to this listing.
 *
 * Body: { slug, github_url?, project_ref?, listing_ref?, title?, description?,
 *         provides_tools? }
 *   - slug            the installed unit's manifest name (used as listing_ref unless overridden)
 *   - github_url      override the repo (else resolved from the installed unit's git origin)
 *   - provides_tools  override the declared MCP tool names (else manifest-derived)
 *
 * `auth: 'public'` — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { findInstalledPlugin } from '../../cupboard/plugin-listings';
import { manifestToolNames } from '../../cupboard/pack-catalog';
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
      provides_tools?: unknown;
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

    // Explicit provides_tools override (validated to the worker's shape); else
    // derived from the installed manifest below.
    let providesToolsOverride: string[] | undefined;
    if (body.provides_tools != null) {
      const pt = body.provides_tools;
      if (
        !Array.isArray(pt) ||
        pt.length === 0 ||
        pt.length > 200 ||
        !pt.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 128)
      ) {
        return Response.json({ ok: false, error: 'invalid provides_tools (string[], 1–200 entries, ≤128 chars)' }, { status: 400 });
      }
      providesToolsOverride = pt;
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

    // A runtime-less code-tool pack manifest (kind:'pack') lists as kind=pack;
    // everything else stays a plugin listing (D-001: plugin = pack + runtime).
    const listingKind = installed?.kind === 'pack' ? ('pack' as const) : ('plugin' as const);
    const providesTools =
      providesToolsOverride ?? (installed ? manifestToolNames(installed) : []);

    const result = await publishListingToCupboard({
      listing_kind: listingKind,
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
      ...(providesTools.length > 0 ? { provides_tools: providesTools } : {}),
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
