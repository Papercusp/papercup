/**
 * POST /api/cupboard/publish-blueprint — publish a blueprint TO the Cupboard
 * as a `kind=blueprint` listing
 * (official-blueprints-cupboard-publish-2026-06-05 P-003 / D-003).
 *
 * The cupboard-publish primitive already accepts `listing_kind=blueprint` +
 * `listing_ref`; nothing called it for blueprints until now. A blueprint
 * listing is GitHub-repo-backed: it points at a PUBLIC repo whose
 * `<listing_ref>/blueprint.yaml` is the blueprint (the official library is one
 * repo hosting all the official blueprints, one listing per blueprint). The
 * blueprint is resolved locally (installed → built-in) to default the
 * title/description from its manifest, then published via the shared
 * listing-publish core — gh-token + channel-2 attestation + the worker's
 * standard gates (rate limit, public-repo check, dedup). The OFFICIAL
 * blueprints go through THIS exact path, authored by the papercupai account —
 * no special built-in treatment (D-003).
 *
 * Body: { id, github_url, listing_ref?, project_ref?, title?, description? }
 *   - id           the blueprint id (resolved installed → built-in; used as
 *                  listing_ref unless overridden)
 *   - github_url   the PUBLIC repo backing the listing (required: the bundled
 *                  blueprints live in a private monorepo, so the content repo
 *                  is always explicit)
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { publishListingToCupboard } from '../../cupboard/publish-listing';
import {
  parseGithubRemote,
  fetchGithubRepoMeta,
  type RepoCoords,
} from '../../cupboard/resolve-repo-coords';

export default defineTool({
  method: 'POST',
  path: '/cupboard/publish-blueprint',
  auth: 'loopback',
  async handler(req) {
    let body: {
      id?: string;
      github_url?: string;
      listing_ref?: string;
      project_ref?: string;
      title?: string;
      description?: string;
    };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const id = String(body.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) {
      return Response.json({ ok: false, error: `invalid blueprint id "${id}"` }, { status: 400 });
    }

    // Resolve the blueprint locally (installed → built-in) — the publisher must
    // actually have the blueprint, and its manifest defaults title/description.
    const file = operatorResolveExtends()(id);
    if (!file) {
      return Response.json(
        { ok: false, error: `blueprint "${id}" not found (installed or built-in)` },
        { status: 404 },
      );
    }
    let manifest: Record<string, unknown> = {};
    try {
      const parsed = parseYaml(readFileSync(file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
      }
    } catch {
      return Response.json({ ok: false, error: `blueprint "${id}" failed to parse at ${file}` }, { status: 422 });
    }

    // The content repo is always explicit for blueprints (the bundled set lives
    // in a private monorepo — the listing must point at the PUBLIC repo).
    const githubUrl = typeof body.github_url === 'string' ? body.github_url.trim() : '';
    const parsed = parseGithubRemote(githubUrl);
    if (!parsed) {
      return Response.json({ ok: false, error: `invalid github_url "${githubUrl}"` }, { status: 400 });
    }
    const meta = await fetchGithubRepoMeta(parsed.owner, parsed.repo);
    if (!meta) {
      return Response.json(
        { ok: false, error: `could not resolve GitHub repo ${parsed.owner}/${parsed.repo}` },
        { status: 422 },
      );
    }
    const coords: RepoCoords = {
      github_repository_id: meta.id,
      github_owner: parsed.owner,
      github_name: parsed.repo,
      github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
    };

    // Worker caps: title ≤ 200, description ≤ 280.
    const description = (
      typeof body.description === 'string'
        ? body.description
        : typeof manifest.description === 'string'
          ? manifest.description.replace(/\s+/g, ' ').trim()
          : ''
    ).slice(0, 280);

    const result = await publishListingToCupboard({
      listing_kind: 'blueprint',
      listing_ref: typeof body.listing_ref === 'string' && body.listing_ref.trim() ? body.listing_ref.trim() : id,
      project_ref: typeof body.project_ref === 'string' ? body.project_ref : undefined,
      ...coords,
      title: (typeof body.title === 'string' ? body.title : id).slice(0, 200),
      description: description || undefined,
      // P-018: the blueprint.yaml `kind` drives the Cupboard "Hive Templates" tab — a
      // kind:'hive' blueprint (generic-hive, …) is a hive template; everything else is a
      // harness blueprint. Default 'harness' (the schema default) when unset.
      blueprint_kind: manifest.kind === 'hive' ? 'hive' : 'harness',
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
