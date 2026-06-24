/**
 * papercusp-shared-identity-gist — the per-owner store for the SHARED `papercusp`
 * dogfood hive identity (Solution C / DOGFOOD_PAPERCUSP_HIVE_SHARE).
 *
 * The owner's hive identity (Ed25519 keypair DER + the directory invite secret) is
 * stored in a PRIVATE GitHub gist tied to the owner's account, so EVERY one of the
 * owner's devices converges on ONE hive identity WITHOUT baking a secret into the
 * public binary — a stranger who installs the app can't read the owner's private
 * gist. The first device generates + publishes; later devices fetch + adopt.
 *
 * Best-effort: ANY failure (no network, missing `gist` scope, malformed blob)
 * returns null and the caller (papercusp-hive-share) simply skips sharing for this
 * boot and retries on the next one. Nothing here ever throws to the bootstrap.
 *
 * SECURITY: the gist is PRIVATE (`public:false`) — readable only with the owner's
 * gh token, the same surface that already guards their private repos. The private
 * key in it is therefore NOT exposed to strangers (the Solution-C requirement). The
 * stricter "private key never leaves the creating device" posture is the remote-hive
 * JOIN variant (share only the pubkey) — a heavier follow-up, deliberately not done
 * here.
 *
 * Inputs (the gh token, the `fetch` impl) are injectable so unit tests run with no
 * network and no gh.
 */

const GIST_FILENAME = 'papercusp-hive-identity.json';
const GIST_DESCRIPTION =
  'Papercusp dogfood hive identity (per-owner, private) — managed by the Papercusp app; do not delete';
const GH_API = 'https://api.github.com';

/** The per-owner shared-hive identity blob persisted in the private gist. */
export interface OwnerHiveIdentity {
  version: 1;
  /** Ed25519 PRIVATE key, DER bytes, base64 — injected into the keychain so all of
   *  the owner's devices share ONE hive identity (and thus one federation topic). */
  privateKeyDer: string;
  /** Raw-32 Ed25519 PUBLIC key, base64 — convenience/verification (derivable from
   *  the private key; stored so a reader can check without re-deriving). */
  pubkeyBase64: string;
  /** Directory invite secret (hex) — the owner's devices announce/discover on the
   *  same invite topic derived from it. */
  inviteSecret: string;
}

type FetchImpl = typeof fetch;

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'papercusp-desktop',
  };
}

/** Structural guard — a gist a user hand-edited (or a future-version blob) must not
 *  crash the bootstrap; an unrecognized shape is treated as "no identity yet". */
export function isOwnerHiveIdentity(v: unknown): v is OwnerHiveIdentity {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.privateKeyDer === 'string' &&
    o.privateKeyDer.length > 0 &&
    typeof o.pubkeyBase64 === 'string' &&
    o.pubkeyBase64.length > 0 &&
    typeof o.inviteSecret === 'string' &&
    o.inviteSecret.length > 0
  );
}

/**
 * Fetch the owner's hive-identity gist (located by the well-known filename across
 * the owner's gists). Returns the parsed identity, or null when absent / on any
 * failure. The gist LIST omits file content, so the matching gist is re-fetched by
 * id to read the blob.
 */
export async function fetchOwnerHiveIdentity(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<OwnerHiveIdentity | null> {
  try {
    const listRes = await fetchImpl(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(token) });
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as Array<{ id?: string; files?: Record<string, unknown> }>;
    if (!Array.isArray(list)) return null;
    const match = list.find(
      (g) => g && g.id && g.files && Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME),
    );
    if (!match?.id) return null;

    const oneRes = await fetchImpl(`${GH_API}/gists/${match.id}`, { headers: ghHeaders(token) });
    if (!oneRes.ok) return null;
    const one = (await oneRes.json()) as { files?: Record<string, { content?: string }> };
    const content = one.files?.[GIST_FILENAME]?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as unknown;
    return isOwnerHiveIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Create the per-owner PRIVATE gist holding `identity`. Returns the new gist id, or
 * null on any failure (e.g. the gh token lacks the `gist` scope — then sharing just
 * no-ops for this device and the owner can re-auth with the scope). Best-effort.
 */
export async function publishOwnerHiveIdentity(
  token: string,
  identity: OwnerHiveIdentity,
  fetchImpl: FetchImpl = fetch,
): Promise<{ gistId: string } | null> {
  try {
    const res = await fetchImpl(`${GH_API}/gists`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILENAME]: { content: JSON.stringify(identity, null, 2) } },
      }),
    });
    if (!res.ok) return null;
    const created = (await res.json()) as { id?: string };
    return created.id ? { gistId: created.id } : null;
  } catch {
    return null;
  }
}

/** Exposed for tests + callers that need the canonical filename/description. */
export const __OWNER_GIST_FILENAME = GIST_FILENAME;
export const __OWNER_GIST_DESCRIPTION = GIST_DESCRIPTION;
