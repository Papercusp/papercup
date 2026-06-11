/**
 * POST /api/harness/cupboard/publish — Phase 9 P-053 server-side proxy.
 *
 * The ShareWizard's shared-public finalize step calls this route. The
 * operator forwards the publish to the Cupboard server with the user's
 * gh-token added server-side, so the browser never holds the token.
 *
 * Request body (mirrors apps/operator-public CupboardPublishInput):
 *   {
 *     github_repository_id: number,
 *     github_owner: string,
 *     github_name: string,
 *     github_url: string,
 *     title?: string,
 *     description?: string,
 *     topic_hex: string,
 *   }
 *
 * Response: { ok: true, id: string, harness: HarnessRow } on success,
 *           { ok: false, error: string, detail?: string } otherwise.
 *
 * Cupboard URL resolution:
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else 'https://cupboard.papercusp.com' (canonical hostname per 2026-05-26 deploy)
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getGhAuthToken } from '../../../identity/gh-token';
import { isListingKind, type ListingKind } from '../../../cupboard/types';

const DEFAULT_CUPBOARD_URL = 'https://cupboard.papercusp.com';
const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;
// Slug-ish within-project discriminator (blueprint stream / snapshot id / plugin slug).
const LISTING_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PROJECT_REF_MAX = 300;

interface PublishInput {
  /** Storefront kind (D-005); defaults to 'harness' for the ShareWizard flow. */
  listing_kind: ListingKind;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Within-project discriminator; required for non-harness kinds. */
  listing_ref?: string;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  /** Required only for kind='harness'. */
  topic_hex?: string;
}

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}

export function validatePublishInput(raw: unknown): { ok: true; input: PublishInput } | { ok: false; error: string; field?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_body' };
  const b = raw as Record<string, unknown>;

  // Kind: default 'harness' (the ShareWizard flow); validated when present.
  let kind: ListingKind = 'harness';
  if (b.listing_kind != null) {
    if (!isListingKind(b.listing_kind)) return { ok: false, error: 'invalid_field', field: 'listing_kind' };
    kind = b.listing_kind;
  }

  if (typeof b.github_repository_id !== 'number' || !Number.isInteger(b.github_repository_id) || b.github_repository_id <= 0) {
    return { ok: false, error: 'invalid_field', field: 'github_repository_id' };
  }
  if (typeof b.github_owner !== 'string' || !b.github_owner) {
    return { ok: false, error: 'invalid_field', field: 'github_owner' };
  }
  if (typeof b.github_name !== 'string' || !b.github_name) {
    return { ok: false, error: 'invalid_field', field: 'github_name' };
  }
  if (typeof b.github_url !== 'string' || !/^https:\/\/github\.com\//.test(b.github_url)) {
    return { ok: false, error: 'invalid_field', field: 'github_url' };
  }
  // topic_hex: required for harness; optional (but hex when present) otherwise.
  if (kind === 'harness') {
    if (typeof b.topic_hex !== 'string' || !TOPIC_HEX_RE.test(b.topic_hex)) {
      return { ok: false, error: 'invalid_field', field: 'topic_hex' };
    }
  } else if (b.topic_hex != null && (typeof b.topic_hex !== 'string' || !TOPIC_HEX_RE.test(b.topic_hex))) {
    return { ok: false, error: 'invalid_field', field: 'topic_hex' };
  }
  // listing_ref: required for non-harness kinds (the within-project discriminator).
  if (kind !== 'harness') {
    if (typeof b.listing_ref !== 'string' || !LISTING_REF_RE.test(b.listing_ref)) {
      return { ok: false, error: 'invalid_field', field: 'listing_ref' };
    }
  }
  if (b.project_ref != null && (typeof b.project_ref !== 'string' || b.project_ref.length < 1 || b.project_ref.length > PROJECT_REF_MAX)) {
    return { ok: false, error: 'invalid_field', field: 'project_ref' };
  }
  if (b.title != null && (typeof b.title !== 'string' || b.title.length > 200)) {
    return { ok: false, error: 'invalid_field', field: 'title' };
  }
  if (b.description != null && (typeof b.description !== 'string' || b.description.length > 280)) {
    return { ok: false, error: 'invalid_field', field: 'description' };
  }
  return {
    ok: true,
    input: {
      listing_kind: kind,
      project_ref: typeof b.project_ref === 'string' ? b.project_ref : undefined,
      listing_ref: typeof b.listing_ref === 'string' ? b.listing_ref : undefined,
      github_repository_id: b.github_repository_id,
      github_owner: b.github_owner,
      github_name: b.github_name,
      github_url: b.github_url,
      title: typeof b.title === 'string' ? b.title : undefined,
      description: typeof b.description === 'string' ? b.description : undefined,
      topic_hex: typeof b.topic_hex === 'string' ? b.topic_hex : undefined,
    },
  };
}

/**
 * Channel-2 publisher attestation (item 1). Resolves the local GitHub
 * identity + device keypair + idempotent device-binding gist so the publish
 * can be attributed to a verifiable, bannable device identity. Reuses the
 * gist `share-finalize` already ensured (find-or-create → no spam).
 *
 * Deps are injectable for testing; defaults lazily import the real identity
 * modules (only the deps actually used are imported). Returns `null` on ANY
 * failure (no gh auth, keychain miss, gist API down) — attestation is
 * best-effort and must NEVER block a publish.
 */
export interface AttestationDeps {
  resolveIdentity: () => Promise<{
    kind: string;
    githubUserId?: number;
    githubLogin?: string;
    token?: string;
  }>;
  keychainIdFor: (githubUserId: number) => string | Promise<string>;
  loadKeypair: (keychainId: string) => Promise<{ pubkeyBase64: string }>;
  ensureGist: (input: {
    keychainId: string;
    pubkeyBase64: string;
    deviceLabel: string;
    githubUserId: number;
    githubLogin: string;
    token: string;
  }) => Promise<string>;
}

export async function resolvePublisherAttestation(
  deps?: Partial<AttestationDeps>,
): Promise<{ attestation_gist_id: string; publisher_device_pubkey: string } | null> {
  try {
    const resolveIdentity =
      deps?.resolveIdentity ??
      (async () =>
        (await import('../../../identity/resolve-local-github-identity')).resolveLocalGithubIdentity());
    const keychainIdFor =
      deps?.keychainIdFor ??
      (async (id: number) =>
        (await import('../../../identity/device-keychain-id')).resolveDeviceKeychainId(id));
    const loadKeypair =
      deps?.loadKeypair ??
      (async (k: string) => (await import('../../../identity/attest')).loadOrGenerateDeviceKeypair(k));
    const ensureGist =
      deps?.ensureGist ??
      (async (i: Parameters<AttestationDeps['ensureGist']>[0]) =>
        (await import('../../../identity/attest')).ensureAttestationGist(i));

    const identity = await resolveIdentity();
    // The identity union is `{kind:'ok', githubUserId, githubLogin, token}` |
    // `{kind:'gh_auth_required'}` — only the 'ok' variant carries the fields. A
    // positive `kind !== 'ok'` narrow (rather than the negative `=== 'gh_auth_required'`
    // disjunction) lets TS narrow before we read githubUserId/githubLogin/token.
    if (identity.kind !== 'ok') return null;
    const { githubUserId, githubLogin, token } = identity as {
      githubUserId?: number;
      githubLogin?: string;
      token?: string;
    };
    if (githubUserId == null || !githubLogin || !token) return null;
    const keychainId = await keychainIdFor(githubUserId);
    const keypair = await loadKeypair(keychainId);
    const gistId = await ensureGist({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      deviceLabel: 'unnamed-device',
      githubUserId,
      githubLogin,
      token,
    });
    if (!gistId) return null;
    return { attestation_gist_id: gistId, publisher_device_pubkey: keypair.pubkeyBase64 };
  } catch {
    return null; // best-effort — publish proceeds without attestation
  }
}

const cupboardPublish = defineTool({
  method: 'POST',
  path: '/harness/cupboard/publish',
  auth: 'loopback',                       // loopback-only via the operator's Host header gate
  async handler(req) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const v = validatePublishInput(body);
    if (!v.ok) {
      return Response.json({ ok: false, error: v.error, field: 'field' in v ? v.field : undefined }, { status: 400 });
    }

    const tokenRes = await getGhAuthToken();
    if (tokenRes.kind !== 'ok') {
      return Response.json(
        { ok: false, error: 'gh_auth_required', detail: tokenRes.error.kind },
        { status: 401 },
      );
    }

    // Best-effort channel-2 attestation (item 1): attach the publisher's
    // device-binding gist + pubkey so Cupboard can attribute + the operator
    // can ban by a verifiable device identity. Idempotent (share-finalize
    // already ensured the gist). null on any failure → publish unchanged.
    const attestation = await resolvePublisherAttestation();
    const publishBody = attestation ? { ...v.input, ...attestation } : v.input;

    // Publish to the generalized /listings surface (kind-aware, migration 004).
    const base = resolveCupboardBaseUrl();
    const headers = {
      Authorization: `Bearer ${tokenRes.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'papercusp-operator-cupboard-proxy',
    };
    const payload = JSON.stringify(publishBody);
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/listings`, { method: 'POST', headers, body: payload });
      // Transitional: a worker not yet on migration 004 has no /listings. For a
      // harness publish, fall back to /harnesses (identical behavior). Non-harness
      // kinds can't be stored by the old worker, so they surface its 404.
      if (upstream.status === 404 && v.input.listing_kind === 'harness') {
        upstream = await fetch(`${base}/harnesses`, { method: 'POST', headers, body: payload });
      }
    } catch (e) {
      return Response.json(
        { ok: false, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }

    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json(
        { ok: false, error: 'cupboard_bad_response', detail: text.slice(0, 200), upstream_status: upstream.status },
        { status: 502 },
      );
    }

    if (!upstream.ok) {
      return Response.json(
        { ok: false, error: 'cupboard_error', detail: parsed, upstream_status: upstream.status },
        { status: upstream.status },
      );
    }

    return Response.json(parsed, { status: 200 });
  },
});

export default cupboardPublish;
