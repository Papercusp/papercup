/**
 * hive-invite-link — format + parse `papercusp://hive?...` invite links
 * (hive-from-repo-hardening-2026-06-11 P-006, design D-006).
 *
 * One shareable invite ARTIFACT instead of a bare secret:
 *   papercusp://hive?pubkey=<base64-32B>&secret=<hex>&title=<urlencoded>
 *
 * Strict rules (patterned on `url-scheme.ts`):
 *   - Protocol must be `papercusp:`; host must be `hive`.
 *   - Param allowlist: `pubkey`, `secret`, `title`. Extra params rejected;
 *     duplicated params rejected.
 *   - `secret`: REQUIRED — the invite-topic secret, 16–128 hex chars
 *     (case-insensitive; preserved verbatim — the invite topic is derived
 *     from the exact string the owner minted).
 *   - `pubkey`: OPTIONAL — the hive's Ed25519 identity pubkey, canonical
 *     padded standard base64 decoding to exactly 32 bytes.
 *   - `title`: OPTIONAL — human label, 1–200 chars.
 *
 * Returns `null` on any malformed input — never throws. PURE and
 * SPA-bundle-safe (no node:crypto/Buffer — same rule as harness-link-types).
 */

/** Parsed representation of a `papercusp://hive?...` invite link. */
export interface HiveInviteLink {
  /** The invite-topic secret, verbatim as shared (16–128 hex chars). */
  secret: string;
  /** The hive's Ed25519 identity pubkey (canonical base64, 32 bytes), when shared. */
  pubkeyBase64?: string;
  /** Human-readable hive title (≤200 chars), when shared. */
  title?: string;
}

export const HIVE_INVITE_LINK_PREFIX = 'papercusp://hive';

/** Exact set of accepted query-param keys. Any extra key → null. */
const ALLOWED_PARAMS = ['pubkey', 'secret', 'title'] as const;

/** The invite secret: 16–128 hex chars, either case. */
const SECRET_RE = /^[0-9a-f]{16,128}$/i;

/**
 * Canonical padded standard base64 for exactly 32 bytes: 43 payload chars +
 * one `=` pad. (32 bytes → ceil(32/3)*4 = 44 chars.)
 */
const PUBKEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

export const HIVE_INVITE_TITLE_MAX = 200;

/** True iff `s` is canonical standard base64 decoding to exactly 32 bytes. */
export function isValidHivePubkeyBase64(s: string): boolean {
  if (typeof s !== 'string' || !PUBKEY_B64_RE.test(s)) return false;
  try {
    // atob is global in browsers and Node ≥16 — keeps this module Buffer-free.
    return atob(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * Build a `papercusp://hive?...` invite link. `secret` is required; `pubkey`
 * and `title` are emitted only when provided. Title is clamped to
 * HIVE_INVITE_TITLE_MAX so the artifact always round-trips through
 * `parseHiveInviteLink`. Caller is responsible for a valid secret/pubkey
 * (mirrors url-scheme.ts formatHarnessLink).
 */
export function formatHiveInviteLink(input: {
  pubkeyBase64?: string;
  secret: string;
  title?: string;
}): string {
  const p = new URLSearchParams();
  if (input.pubkeyBase64) p.set('pubkey', input.pubkeyBase64);
  p.set('secret', input.secret);
  if (input.title) p.set('title', input.title.slice(0, HIVE_INVITE_TITLE_MAX));
  return HIVE_INVITE_LINK_PREFIX + '?' + p.toString();
}

/**
 * Parse a `papercusp://hive?...` invite link. Returns `HiveInviteLink` on
 * success, `null` on any malformed input. Never throws.
 */
export function parseHiveInviteLink(url: string): HiveInviteLink | null {
  if (typeof url !== 'string') return null;

  // Fast prefix check before constructing a URL object.
  if (!url.startsWith('papercusp://')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'papercusp:') return null;
  if (parsed.host !== 'hive') return null;

  // Reject extra params; reject duplicated allowlisted params.
  for (const key of parsed.searchParams.keys()) {
    if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) return null;
  }
  for (const key of ALLOWED_PARAMS) {
    if (parsed.searchParams.getAll(key).length > 1) return null;
  }

  const secret = parsed.searchParams.get('secret');
  if (!secret || !SECRET_RE.test(secret)) return null;

  const pubkey = parsed.searchParams.get('pubkey');
  if (pubkey !== null && !isValidHivePubkeyBase64(pubkey)) return null;

  const title = parsed.searchParams.get('title');
  if (title !== null && (title.length === 0 || title.length > HIVE_INVITE_TITLE_MAX)) return null;

  return {
    secret,
    ...(pubkey !== null ? { pubkeyBase64: pubkey } : {}),
    ...(title !== null ? { title } : {}),
  };
}
