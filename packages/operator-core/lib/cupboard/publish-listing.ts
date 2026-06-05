/**
 * Reusable Cupboard listing-publish core (revive-cupboard-distribution-2026-06-04).
 *
 * The ShareWizard's harness publish has its own route
 * (`harness/cupboard-publish.ts`); the snapshot (P1) and plugin (P2) publish
 * bridges need the SAME server-side publish behavior — add the gh-token +
 * channel-2 attestation, POST the generalized `/listings` surface — without
 * going through an internal HTTP hop. This extracts that core as a plain
 * function, reusing cupboard-publish's already-exported `resolveCupboardBaseUrl`
 * + `resolvePublisherAttestation` so there is one publish path, not three.
 *
 * The `/harnesses` fallback (for a pre-migration-004 worker) is harness-only —
 * a non-harness kind can't be stored by the old worker, so it surfaces the 404.
 */
import { getGhAuthToken } from '../identity/gh-token';
import {
  resolveCupboardBaseUrl,
  resolvePublisherAttestation,
} from '../endpoint-route/routes/harness/cupboard-publish';
import type { ListingKind } from './types';

/** A validated listing-publish payload (mirrors the Cupboard `/listings` body). */
export interface CupboardListingInput {
  listing_kind: ListingKind;
  /** Papercupai project remote (D-008). */
  project_ref?: string;
  /** Within-project discriminator — REQUIRED for non-harness kinds (snapshot id / plugin slug). */
  listing_ref?: string;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  /** Required only for kind='harness' (the Hypercore join topic). */
  topic_hex?: string;
  // ── snapshot R2 blob fields (revive-cupboard-distribution, owner decision
  //    2026-06-04: snapshots are cross-machine forkable NOW via an R2 blob store
  //    behind the Cupboard). Optional + snapshot-only; the R2 blob layer
  //    (worker mig 005 + upload/download routes + the publish.ts tarball upload)
  //    is owned by su-d998e63a. Carried here so the listing publish passes them.
  /** Content-addressed R2 object key for the snapshot tarball (`snapshots/<sha256>.tar.gz`). */
  tarball_r2_key?: string;
  /** sha256 of the snapshot tarball (integrity check on fork-download). */
  tarball_content_hash?: string;
  /** Compressed byte size of the snapshot tarball. */
  tarball_bytes?: number;
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
