/**
 * Reusable Cupboard listing-publish core (revive-cupboard-distribution-2026-06-04).
 *
 * THE one server-side publish path: add the gh-token + channel-2 attestation,
 * POST the generalized `/listings` surface — no internal HTTP hop. Hive
 * member-repo rows, blueprint and plugin/pack publishes all ride this core.
 * (The per-harness ShareWizard publish route that used to sit beside it was
 * retired — comb-retire-per-harness-sharing-2026-06-11 P-006.)
 *
 * The `/harnesses` fallback (for a pre-migration-004 worker) is harness-only —
 * a non-harness kind can't be stored by the old worker, so it surfaces the 404.
 */
import { getGhAuthToken } from '../identity/gh-token';
import { resolveCupboardBaseUrl } from './base-url';
import { resolvePublisherAttestation } from './publisher-attestation';
import type { ListingKind } from './types';

/** A validated listing-publish payload (mirrors the Cupboard `/listings` body). */
export interface CupboardListingInput {
  listing_kind: ListingKind;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Within-project discriminator — REQUIRED for non-harness kinds (plugin slug / pack id). */
  listing_ref?: string;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  /** Required only for kind='harness' (the Hypercore join topic). */
  topic_hex?: string;
  /**
   * Repo→Hive binding (worker migration 007 / hive-from-github-url P-004,
   * D-004 HYBRID): the owning Hive's raw 32-byte Ed25519 pubkey, base64 (same
   * encoding as the hive directory announce). One row per member repo of a
   * public hive, all carrying the same pubkey. Omit for non-hive listings.
   */
  hive_pubkey?: string;
  /** Denormalized Hive display title (the directory announce stays the content authority). */
  hive_title?: string;
  /** For a `listing_kind: 'blueprint'` publish: the blueprint.yaml `kind` — 'hive' (a hive
   *  template) | 'harness'. The Cupboard "Hives" tab discriminator (worker migration 009 /
   *  hive-blueprint-generalization P-018). Omit for non-blueprint kinds. */
  blueprint_kind?: 'pot' | 'hive' | 'harness';
  /**
   * Pack model (worker migration 006 / tool-distribution-granularity): the MCP
   * tool names the unit registers when installed. Kinds plugin|pack only — the
   * worker 400s it elsewhere. Powers the Cupboard's tool→provider discovery.
   */
  provides_tools?: string[];
}

export type CupboardPublishResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

/**
 * Publish a listing of any kind to the Cupboard `/listings` surface. Adds the
 * caller's gh-token (the browser/agent never holds it) + a best-effort channel-2
 * publisher attestation, then POSTs the worker. Returns a structured result the
 * caller maps to its own response. Never throws — network failures become a
 * `cupboard_unreachable` 502.
 */
export async function publishListingToCupboard(
  input: CupboardListingInput,
): Promise<CupboardPublishResult> {
  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') {
    return { ok: false, status: 401, error: 'gh_auth_required', detail: tokenRes.error.kind };
  }

  // Best-effort channel-2 attestation (idempotent device-binding gist). null on
  // any failure → publish proceeds unattributed.
  const attestation = await resolvePublisherAttestation();
  const publishBody = attestation ? { ...input, ...attestation } : input;

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
    // Transitional: a worker not yet on migration 004 has no /listings. Only a
    // harness publish can fall back to /harnesses; non-harness kinds surface 404.
    if (upstream.status === 404 && input.listing_kind === 'harness') {
      upstream = await fetch(`${base}/harnesses`, { method: 'POST', headers, body: payload });
    }
  } catch (e) {
    return { ok: false, status: 502, error: 'cupboard_unreachable', detail: (e as Error).message.slice(0, 200) };
  }

  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 502, error: 'cupboard_bad_response', detail: text.slice(0, 200), upstream_status: upstream.status };
  }
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, error: 'cupboard_error', detail: parsed, upstream_status: upstream.status };
  }
  return { ok: true, status: 200, data: parsed };
}
