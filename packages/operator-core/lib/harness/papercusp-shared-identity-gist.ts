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

/** A gist list entry (the list API omits file content; `created_at` is used to pick
 *  the canonical duplicate deterministically). */
interface GistListEntry {
  id?: string;
  created_at?: string;
  files?: Record<string, unknown>;
}

/**
 * Find the owner's CANONICAL hive-identity gist id. Among every gist whose files
 * include the well-known filename, the OLDEST by `created_at` wins — a deterministic
 * choice every one of the owner's devices converges on, and the dedup key when
 * divergent duplicate gists exist (WI-867: 3+ `papercusp-hive-identity.json` gists
 * with *different* invite secrets, created by the old unconditional-POST publish on
 * "first device" races). Returns null when none match / on any failure.
 */
async function findCanonicalGistId(token: string, fetchImpl: FetchImpl): Promise<string | null> {
  const listRes = await fetchImpl(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(token) });
  if (!listRes.ok) return null;
  const list = (await listRes.json()) as GistListEntry[];
  if (!Array.isArray(list)) return null;
  const matches = list.filter(
    (g) => g && g.id && g.files && Object.prototype.hasOwnProperty.call(g.files, GIST_FILENAME),
  );
  if (matches.length === 0) return null;
  // Oldest-first: `created_at` is ISO-8601 (lexicographic == chronological); tiebreak
  // on id so the ordering is total + stable even if `created_at` is ever missing.
  matches.sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
  });
  return matches[0]?.id ?? null;
}

/**
 * Fetch the owner's hive-identity from the CANONICAL gist (the oldest one holding the
 * well-known filename — so divergent duplicates resolve to ONE identity). Returns the
 * parsed identity, or null when absent / on any failure. The gist LIST omits file
 * content, so the canonical gist is re-fetched by id to read the blob.
 */
export async function fetchOwnerHiveIdentity(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<OwnerHiveIdentity | null> {
  try {
    const gistId = await findCanonicalGistId(token, fetchImpl);
    if (!gistId) return null;

    const oneRes = await fetchImpl(`${GH_API}/gists/${gistId}`, { headers: ghHeaders(token) });
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
 * UPSERT the owner's PRIVATE hive-identity gist: PATCH the canonical gist in place
 * when one already exists (so the owner's devices converge on ONE blob and a transient
 * "first device" race can't fork a NEW divergent gist — the WI-867 root cause), else
 * POST a fresh private gist. Returns the gist id, or null on any failure (e.g. the gh
 * token lacks the `gist` scope — then sharing just no-ops for this device and the
 * owner can re-auth with the scope). Best-effort; never throws.
 */
export async function publishOwnerHiveIdentity(
  token: string,
  identity: OwnerHiveIdentity,
  fetchImpl: FetchImpl = fetch,
): Promise<{ gistId: string } | null> {
  try {
    const existingId = await findCanonicalGistId(token, fetchImpl);
    const res = await fetchImpl(existingId ? `${GH_API}/gists/${existingId}` : `${GH_API}/gists`, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // `public` is honored only on create; PATCH can't change visibility — the
        // canonical gist was already created private, so it stays private.
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILENAME]: { content: JSON.stringify(identity, null, 2) } },
      }),
    });
    if (!res.ok) return null;
    const saved = (await res.json()) as { id?: string };
    const gistId = saved.id ?? existingId;
    return gistId ? { gistId } : null;
  } catch {
    return null;
  }
}

/** Exposed for tests + callers that need the canonical filename/description. */
export const __OWNER_GIST_FILENAME = GIST_FILENAME;
export const __OWNER_GIST_DESCRIPTION = GIST_DESCRIPTION;
