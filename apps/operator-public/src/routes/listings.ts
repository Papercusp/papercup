/**
 * /listings — the generalized storefront surface (migration 004 / D-005).
 *
 * ONE storefront, five listing kinds:
 *   harness   → join     (shared-harness via the Hypercore topic_hex)
 *   blueprint → fork     (a blueprint stream within a project)
 *   snapshot  → fork     (a captured snapshot)
 *   plugin    → install  (a distributable plugin — a pack WITH a runtime)
 *   pack      → install  (a runtime-less code-tool pack; migration 006,
 *                         tool-distribution-granularity D-001/D-004)
 *
 * Project-centric 1:N (D-008): listings key on the papercupai project remote
 * (`project_ref`) and a project hosts N non-harness listings, discriminated by
 * `listing_ref`. GitHub-repo-backed identity stays for v1, so every kind still
 * carries the project remote's github repo fields + the publisher-collaborator
 * trust signal.
 *
 * Endpoints (registered under BOTH /listings and /harnesses):
 *   GET    /listings            — list (public, paginated, ?kind= / ?project= filters)
 *   GET    /listings/:id        — single listing detail
 *   POST   /listings            — publish (GitHub auth + 5/hr cap; body.listing_kind)
 *   DELETE /listings/:id        — unlist (publisher or claimant)
 *   POST   /listings/:id/claim  — claim by maintain/admin perm
 *
 * /harnesses* is the same surface pinned to kind='harness' — the back-compat
 * view the deployed desktop client + operator proxy use today. Once the
 * operator proxy is cut over to /listings?kind=harness, /harnesses can be
 * dropped (it carries no behavior the generalized surface doesn't).
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import {
  audit,
  clientIp,
  getActiveListingByRefs,
  getHarnessById,
  getHarnessByGithubRepoId,
  insertHarness,
  isListingKind,
  listBannedPubkeySet,
  listHarnesses,
  markHarnessUnlisted,
  setHarnessClaim,
  type ListingKind,
} from '../db.ts';
import {
  AuthError,
  extractBearer,
  resolveGithubBearer,
  checkRepoPermission,
} from '../auth.ts';
import { checkAndRecordUserPublishHourly, checkIpListPerMinute, RateLimitError } from '../ratelimit.ts';

interface PublishBody {
  listing_kind?: string;             // migration 004; defaults to 'harness'
  project_ref?: string;              // papercupai project remote (D-008)
  listing_ref?: string;              // within-project discriminator; REQUIRED for non-harness kinds
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  topic_hex?: string;                // 32-byte hex Hypercore topic; REQUIRED for kind='harness'
  attestation_gist_id?: string;      // channel-2 (item 1): gist binding device pubkey ↔ login
  publisher_device_pubkey?: string;  // channel-2 (item 1): device Ed25519 pubkey (base64)
  // Pack model (migration 006). MCP tool names the unit registers when
  // installed; kinds plugin|pack only. Stored as a JSON TEXT column and
  // returned verbatim on GET (the operator's resolver parses it).
  provides_tools?: unknown;          // expected: string[]
}

/** provides_tools caps (migration 006): bounded so a listing can't smuggle a payload. */
const PROVIDES_TOOLS_MAX_ENTRIES = 200;
const PROVIDES_TOOLS_MAX_NAME_LEN = 128;

const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;
// Slug-ish: blueprint stream name / snapshot id / plugin slug. Permits path-y
// refs (a/b) and dotted versions; bounded length.
const LISTING_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PROJECT_REF_MAX = 300;

function uuidv4(): string {
  // crypto.randomUUID is available in Workers + Node 19+ + browser
  return (crypto as { randomUUID: () => string }).randomUUID();
}

/**
 * Derive a single permission level from GitHub's repo `permissions`
 * object (booleans), returned by GET /repos/:owner/:repo when fetched
 * with a user token. Highest applicable wins. For a PUBLIC repo a
 * non-collaborator still gets `pull: true` ⇒ 'read'; an actual
 * collaborator gets push/maintain/admin. So 'read'/'none' ⇒ not a
 * collaborator. Item 2 of the cupboard-provisional-listing-trust memo.
 */
export function derivePublisherPermission(
  perms: Record<string, boolean> | undefined | null,
): 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' {
  if (!perms) return 'none';
  if (perms.admin) return 'admin';
  if (perms.maintain) return 'maintain';
  if (perms.push) return 'write';
  if (perms.triage) return 'triage';
  if (perms.pull) return 'read';
  return 'none';
}

interface MountOpts {
  /** When set, the mount serves exactly this kind (the /harnesses back-compat view). */
  fixedKind?: ListingKind;
}

/** Register the five listing endpoints under `base`, kind-pinned or kind-aware. */
function registerListingEndpoints(
  app: Hono<{ Bindings: Env }>,
  base: string,
  opts: MountOpts = {},
): void {
  const { fixedKind } = opts;

  // GET base — public listing.
  app.get(base, async (c) => {
    const ip = clientIp(c.req.raw);
    try {
      await checkIpListPerMinute(c.env, ip);
    } catch (e) {
      if (e instanceof RateLimitError) return c.json({ error: 'rate_limited' }, 429);
      throw e;
    }
    const url = new URL(c.req.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
    const cursor = url.searchParams.get('cursor');
    const search = url.searchParams.get('q') ?? undefined;
    const claim_status_raw = url.searchParams.get('claim');
    const claim_status =
      claim_status_raw === 'claimed' || claim_status_raw === 'unclaimed'
        ? claim_status_raw
        : undefined;
    // Kind: pinned on /harnesses; from ?kind= on /listings (omit ⇒ all kinds).
    let kind: ListingKind | undefined = fixedKind;
    if (!kind) {
      const kindRaw = url.searchParams.get('kind');
      if (kindRaw != null && kindRaw !== '' && kindRaw !== 'all') {
        if (!isListingKind(kindRaw)) return c.json({ error: 'invalid_field', field: 'kind' }, 400);
        kind = kindRaw;
      }
    }
    const project_ref = url.searchParams.get('project') ?? undefined;
    const rows = await listHarnesses(c.env.DB, {
      limit,
      cursor: cursor ? parseInt(cursor, 10) : null,
      search,
      claim_status,
      kind,
      project_ref,
    });
    // Filter out listings whose publisher device pubkey is operator-banned
    // (channel-2 ban-list, item 1). next_cursor stays keyed on the fetched
    // page so pagination is stable even when a page is partially banned.
    const banned = await listBannedPubkeySet(c.env.DB);
    const results = rows.filter(
      (r) => !r.publisher_device_pubkey || !banned.has(r.publisher_device_pubkey),
    );
    const next_cursor =
      rows.length === limit ? rows[rows.length - 1].last_activity_at : null;
    return c.json({ results, next_cursor });
  });

  // GET base/:id — single listing.
  app.get(`${base}/:id`, async (c) => {
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: 'not_found' }, 404);
    // On the kind-pinned mount, a row of another kind is not found here.
    if (fixedKind && row.listing_kind !== fixedKind) return c.json({ error: 'not_found' }, 404);
    if (row.publisher_device_pubkey) {
      const banned = await listBannedPubkeySet(c.env.DB);
      if (banned.has(row.publisher_device_pubkey)) return c.json({ error: 'not_found' }, 404);
    }
    return c.json(row);
  });

  // POST base — publish.
  app.post(base, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const now = Date.now();

    try {
      await checkAndRecordUserPublishHourly(c.env, user.id, now);
    } catch (e) {
      if (e instanceof RateLimitError) {
        await audit(c.env.DB, now, 'publish_rate_limited', { user_id: user.id });
        return c.json({ error: 'rate_limited', bucket: e.bucket }, 429);
      }
      throw e;
    }

    let body: PublishBody;
    try {
      body = (await c.req.json()) as PublishBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Resolve the kind: pinned on /harnesses; from body on /listings (default harness).
    let kind: ListingKind;
    if (fixedKind) {
      kind = fixedKind;
    } else if (body.listing_kind == null) {
      kind = 'harness';
    } else if (isListingKind(body.listing_kind)) {
      kind = body.listing_kind;
    } else {
      return c.json({ error: 'invalid_field', field: 'listing_kind' }, 400);
    }

    // Common field validation (every kind is project-remote-backed in v1).
    if (typeof body.github_repository_id !== 'number' || body.github_repository_id <= 0) {
      return c.json({ error: 'invalid_field', field: 'github_repository_id' }, 400);
    }
    if (typeof body.github_owner !== 'string' || !body.github_owner) {
      return c.json({ error: 'invalid_field', field: 'github_owner' }, 400);
    }
    if (typeof body.github_name !== 'string' || !body.github_name) {
      return c.json({ error: 'invalid_field', field: 'github_name' }, 400);
    }
    if (typeof body.github_url !== 'string' || !/^https:\/\/github\.com\//.test(body.github_url)) {
      return c.json({ error: 'invalid_field', field: 'github_url' }, 400);
    }
    if (body.description != null && (typeof body.description !== 'string' || body.description.length > 280)) {
      return c.json({ error: 'invalid_field', field: 'description' }, 400);
    }
    if (body.title != null && (typeof body.title !== 'string' || body.title.length > 200)) {
      return c.json({ error: 'invalid_field', field: 'title' }, 400);
    }

    // Kind-specific shape.
    //  harness   → topic_hex REQUIRED (the Hypercore join topic).
    //  non-harness → topic_hex optional; listing_ref REQUIRED (the within-project
    //               discriminator); project_ref optional.
    if (kind === 'harness') {
      if (typeof body.topic_hex !== 'string' || !TOPIC_HEX_RE.test(body.topic_hex)) {
        return c.json({ error: 'invalid_field', field: 'topic_hex' }, 400);
      }
    } else {
      if (body.topic_hex != null && (typeof body.topic_hex !== 'string' || !TOPIC_HEX_RE.test(body.topic_hex))) {
        return c.json({ error: 'invalid_field', field: 'topic_hex' }, 400);
      }
      if (typeof body.listing_ref !== 'string' || !LISTING_REF_RE.test(body.listing_ref)) {
        return c.json({ error: 'invalid_field', field: 'listing_ref' }, 400);
      }
    }
    if (
      body.project_ref != null &&
      (typeof body.project_ref !== 'string' || body.project_ref.length < 1 || body.project_ref.length > PROJECT_REF_MAX)
    ) {
      return c.json({ error: 'invalid_field', field: 'project_ref' }, 400);
    }

    // provides_tools (migration 006) — pack-model tool metadata. Only the
    // installable kinds (plugin|pack) register tools; a bounded array of
    // non-empty tool-name strings, stored as JSON TEXT.
    let providesToolsJson: string | null = null;
    if (body.provides_tools != null) {
      if (kind !== 'plugin' && kind !== 'pack') {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'plugin_or_pack_kind_only' }, 400);
      }
      const pt = body.provides_tools;
      if (!Array.isArray(pt) || pt.length === 0 || pt.length > PROVIDES_TOOLS_MAX_ENTRIES) {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'array_1_to_200' }, 400);
      }
      if (!pt.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= PROVIDES_TOOLS_MAX_NAME_LEN)) {
        return c.json({ error: 'invalid_field', field: 'provides_tools', reason: 'non_empty_strings_max_128' }, 400);
      }
      providesToolsJson = JSON.stringify(pt);
    }

    // Channel-2 attestation (item 1) — optional, but both-or-neither.
    const hasGist = body.attestation_gist_id != null;
    const hasPubkey = body.publisher_device_pubkey != null;
    if (hasGist !== hasPubkey) {
      return c.json(
        { error: 'invalid_field', field: 'attestation_gist_id|publisher_device_pubkey', reason: 'both_or_neither' },
        400,
      );
    }
    if (
      hasGist &&
      (typeof body.attestation_gist_id !== 'string' ||
        body.attestation_gist_id.length > 100 ||
        !/^[A-Za-z0-9]+$/.test(body.attestation_gist_id))
    ) {
      return c.json({ error: 'invalid_field', field: 'attestation_gist_id' }, 400);
    }
    if (
      hasPubkey &&
      (typeof body.publisher_device_pubkey !== 'string' ||
        body.publisher_device_pubkey.length < 1 ||
        body.publisher_device_pubkey.length > 200)
    ) {
      return c.json({ error: 'invalid_field', field: 'publisher_device_pubkey' }, 400);
    }

    // Reject if the GitHub repo is private. Check via authed GitHub API
    // — we already have the publisher's token, and they must have at
    // least read perm on a repo they're publishing.
    const ghCheck = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(body.github_owner)}/${encodeURIComponent(body.github_name)}`,
      {
        headers: {
          Authorization: `Bearer ${extractBearer(c.req.raw)}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'papercusp-cupboard',
        },
      },
    );
    if (!ghCheck.ok) {
      return c.json({ error: 'github_repo_unreachable', status: ghCheck.status }, 400);
    }
    const repoMeta = (await ghCheck.json()) as {
      id?: number;
      private?: boolean;
      permissions?: Record<string, boolean>;
    };
    if (repoMeta.private) {
      return c.json({ error: 'private_repo_rejected' }, 400);
    }
    if (repoMeta.id !== body.github_repository_id) {
      return c.json({ error: 'repository_id_mismatch', expected: repoMeta.id }, 400);
    }
    // Publisher-permission signal (item 2): same trust signal for every kind.
    const publisher_permission = derivePublisherPermission(repoMeta.permissions);

    // Dedup. Harness → one active listing per repo. Non-harness → one active
    // listing per (repo, kind, listing_ref). A dedup hit returns the existing
    // listing rather than minting a second.
    const existing =
      kind === 'harness'
        ? await getHarnessByGithubRepoId(c.env.DB, body.github_repository_id)
        : await getActiveListingByRefs(c.env.DB, body.github_repository_id, kind, body.listing_ref as string);
    if (existing && !existing.unlisted_at) {
      await audit(c.env.DB, now, 'publish_dedup', {
        listing_kind: kind,
        github_repository_id: body.github_repository_id,
        listing_ref: existing.listing_ref,
        existing_id: existing.id,
        user_id: user.id,
      });
      return c.json({ ok: true, id: existing.id, harness: existing, listing: existing, dedup: true });
    }

    const id = uuidv4();
    await insertHarness(c.env.DB, {
      id,
      listing_kind: kind,
      project_ref: body.project_ref ?? null,
      listing_ref: kind === 'harness' ? null : (body.listing_ref ?? null),
      github_repository_id: body.github_repository_id,
      github_owner: body.github_owner,
      github_name: body.github_name,
      github_url: body.github_url,
      title: body.title ?? body.github_name,
      description: body.description ?? null,
      topic_hex: body.topic_hex ?? null,
      publisher_github_user_id: user.id,
      publisher_github_login: user.login,
      publisher_permission,
      publisher_device_pubkey: body.publisher_device_pubkey ?? null,
      publisher_attestation_gist_id: body.attestation_gist_id ?? null,
      provides_tools: providesToolsJson,
      created_at: now,
    });
    await audit(c.env.DB, now, 'published', {
      id,
      listing_kind: kind,
      github_repository_id: body.github_repository_id,
      listing_ref: kind === 'harness' ? null : body.listing_ref,
      publisher_github_user_id: user.id,
    });
    const listing = await getHarnessById(c.env.DB, id);
    return c.json({ ok: true, id, harness: listing, listing });
  });

  // DELETE base/:id — unlist (publisher or claimant).
  app.delete(`${base}/:id`, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ ok: true, already_unlisted: true });
    const isPublisher = row.publisher_github_user_id === user.id;
    const isClaimant = row.claimant_github_user_id === user.id;
    if (!isPublisher && !isClaimant) return c.json({ error: 'forbidden' }, 403);
    const now = Date.now();
    await markHarnessUnlisted(c.env.DB, id, 'by_publisher', now);
    await audit(c.env.DB, now, 'unlisted', { id, listing_kind: row.listing_kind, by_user_id: user.id });
    return c.json({ ok: true });
  });

  // POST base/:id/claim — claim by maintain/admin perm.
  app.post(`${base}/:id/claim`, async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ error: 'unlisted' }, 410);
    if (row.claim_status === 'claimed') {
      return c.json({ error: 'already_claimed', claimant_github_user_id: row.claimant_github_user_id }, 409);
    }
    const perm = await checkRepoPermission(
      extractBearer(c.req.raw),
      row.github_owner,
      row.github_name,
      'maintain',
    );
    if (!perm.has_permission) {
      return c.json({ error: 'insufficient_permission', required: 'maintain' }, 403);
    }
    const now = Date.now();
    await setHarnessClaim(c.env.DB, id, { user_id: user.id, login: user.login }, now);
    await audit(c.env.DB, now, 'claimed', { id, listing_kind: row.listing_kind, user_id: user.id, permission: perm.permission });
    const updated = await getHarnessById(c.env.DB, id);
    return c.json({ ok: true, harness: updated, listing: updated });
  });
}

/**
 * The generalized storefront route. Registers the kind-aware /listings surface
 * AND the kind='harness' /harnesses back-compat view (same handlers).
 */
export function listingsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  registerListingEndpoints(app, '/listings');
  registerListingEndpoints(app, '/harnesses', { fixedKind: 'harness' });
  return app;
}
