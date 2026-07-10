/**
 * POST /api/cupboard/publish-template — publish an app-template TO the Cupboard as
 * a `kind=template` listing (cupboard-full-dogfood-2026-07-10 P-003 / P-004). The
 * template-store sibling of cupboard-publish-plugin / cupboard-publish-blueprint:
 * rides the one server-side `publishListingToCupboard` core (gh-token + channel-2
 * attestation → POST /listings), so first-party templates list "as authored by
 * papercusp" via the STANDARD publish flow instead of the direct D1 seed the 11
 * official rows were created by (publisher_login=null).
 *
 * A template listing is mirror-repo-backed: it points at the public templates repo
 * (`github_url`, e.g. Papercusp/templates) with `listing_ref` = the per-template
 * subdir. Unlike a plugin (installed from a clone with a git origin), a template's
 * content lives on-disk in the bundled store with NO origin remote — so
 * `github_url` is REQUIRED here; we resolve its GitHub coords and default the
 * title/description from the local template when the ref resolves.
 *
 * Body: { ref, github_url, listing_ref?, project_ref?, title?, description? }
 *   - ref          the template's local ref/id (defaults title+description; also the
 *                  default listing_ref)
 *   - github_url   the mirror repo the template lives in (REQUIRED)
 *   - listing_ref  override the within-repo subdir (else `ref`)
 *
 * `auth: 'loopback'` (auth-tier Wave 1) — loopback-only via the operator's Host-header gate.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { publishListingToCupboard } from '../../cupboard/publish-listing';
import { resolveLocalTemplate } from '../../cupboard/template-store';
import { parseGithubRemote, fetchGithubRepoMeta } from '../../cupboard/resolve-repo-coords';

// A template ref is a within-repo subdir + the human handle — a safe single
// segment (mirrors templates.ts SAFE_REF_RE). UNTRUSTED (from the caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export default defineTool({
  method: 'POST',
  path: '/cupboard/publish-template',
  auth: 'loopback',
  async handler(req) {
    let body: {
      ref?: string;
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
    const ref = String(body.ref ?? '').trim();
    if (!SAFE_REF_RE.test(ref)) {
      return Response.json({ ok: false, error: `invalid template ref "${ref}"` }, { status: 400 });
    }

    const githubUrl = typeof body.github_url === 'string' ? body.github_url.trim() : '';
    if (!githubUrl) {
      return Response.json(
        { ok: false, error: 'github_url required (the public mirror repo the template lives in)' },
        { status: 400 },
      );
    }
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

    // Default title/description from the local template when the ref resolves in
    // the bundled/user store (a publish of a ref not present locally still works —
    // title/description then come from the body).
    const local = resolveLocalTemplate(ref);

    const result = await publishListingToCupboard({
      listing_kind: 'template',
      listing_ref: typeof body.listing_ref === 'string' && body.listing_ref.trim() ? body.listing_ref.trim() : ref,
      project_ref: typeof body.project_ref === 'string' ? body.project_ref : undefined,
      github_repository_id: meta.id,
      github_owner: parsed.owner,
      github_name: parsed.repo,
      github_url: meta.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`,
      title: typeof body.title === 'string' ? body.title : (local?.title ?? ref),
      description:
        typeof body.description === 'string'
          ? body.description
          : typeof local?.description === 'string' && local.description
            ? local.description
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
