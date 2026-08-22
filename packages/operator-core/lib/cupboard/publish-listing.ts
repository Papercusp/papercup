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
import type { ListingKind, RubricRequirement } from './types';
import type { ProvidedEventFamily, RequiredEventFamily } from '@papercusp/blueprint-distribution';

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
  /**
   * The EVENT half of the same pack model (worker migration 012 / D-003, P-007):
   * the awaitable event-key families this unit provides when installed. Kinds
   * plugin|pack only — the worker 400s it elsewhere.
   *
   * ⚠ This field is why the event axis WORKS AT ALL in production. P-007 landed
   * the column, the worker's accept+validate, the catalog read, the resolver and
   * the install gate — but nothing ever SENT it, so `cupboardEventIndex` was
   * permanently empty, `resolveEventProvider` could never return 'installable',
   * and an event dep could never pull its providing unit in. The whole
   * installable rung was inert. Every publish path that lists a plugin/pack must
   * populate this from the manifest's `provides.events`, or its listing is
   * invisible to event resolution.
   */
  provides_events?: ProvidedEventFamily[];
  /**
   * The event families this unit REQUIRES (worker migration 013 / D-003, P-008),
   * from the manifest's `dependencies.events`. Kinds plugin|pack only.
   *
   * Published so a user can see a unit's requirements BEFORE installing: the
   * P-007 install gate HARD-FAILS an install whose required family nothing
   * provides, so without this the refusal arrives as a surprise toast after the
   * click. It is a DECLARATION, never a resolution — whether family X is
   * actually available is the resolver's answer, against the local catalog.
   */
  requires_events?: RequiredEventFamily[];
  /**
   * The rubrics this unit REQUIRES (worker migration 015 /
   * cupboard-plan-rubric-recipe-sharing D-001, P-009). Kind `plan` only today — the
   * worker 400s (`plan_kind_only`) on any other kind, deliberately, so a declaration
   * no install-time resolver reads can never be stored as a silent no-op.
   *
   * Published for the same reason as `requires_events`: the install gate
   * (rubric-requirements.ts) HARD-FAILS an install whose required rubric nothing
   * provides, and a refusal that arrives only after the click is a worse refusal. It
   * is a DECLARATION, never a resolution — whether the installing workspace already
   * has the rubric (its BUNDLED first-party set often does) is the resolver's answer.
   */
  requires_rubrics?: RubricRequirement[];
  /**
   * App distribution (worker migration 014 / cupboard-app-distribution-2026-07-14
   * P-003, D-001). Kind `app` only — the worker 400s these on any other kind.
   * `delivery_type` discriminates the model: 'standalone' (a separate downloadable
   * product — "install" DOWNLOADS the platform installer from its own release;
   * the Cupboard never re-hosts the binary) | 'bundle' (a papercusp-native
   * composition, Phase 2). Omitted ⇒ the worker treats it as 'standalone'.
   */
  delivery_type?: 'standalone' | 'bundle';
  /**
   * STANDALONE: URL of the app's signed `latest.json` updater manifest
   * (@papercusp/tauri-release-kit `buildLatestManifest` output). The download
   * flow (P-005) reads it to resolve the platform-specific installer URL. The
   * `cupboard:publish-app` tool VALIDATES this RESOLVES before publishing
   * (assertAppManifestResolves) so a broken release can't publish a dead listing.
   */
  latest_json_url?: string;
  /** STANDALONE: `<owner>/<repo>` whose GitHub Releases host the installers, when
   *  distinct from the source repo. Omit ⇒ falls back to the listing's repo. */
  release_repo?: string;
  /** App icon URL for the storefront card/detail (an app is a whole product, so
   *  it gets a real icon rather than a kind glyph). */
  icon_url?: string;
  /** Denormalized OS keys present in `latest.json` (e.g.
   *  ["darwin-aarch64","linux-x86_64"]) so the card shows availability without
   *  fetching the manifest. Derived from the validated manifest by the tool. */
  platforms?: string[];
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
