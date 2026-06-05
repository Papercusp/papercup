/**
 * Content addressing — the integrity + dedupe + auth-lite primitive under a
 * distributable artifact store. An artifact's storage key IS its content hash,
 * so:
 *   - the same bytes always map to the same key (free dedupe);
 *   - a tampered blob can't masquerade under a key it doesn't hash to (the
 *     writer re-verifies on PUT, the reader on GET);
 *   - keys are stable across machines (cross-machine fork just needs the hash).
 *
 * PURE + transport-free + backend-free. Web-Crypto (`crypto.subtle`) only — runs
 * in Node 18+, Cloudflare Workers, Deno, and browsers identically.
 */

/** Lowercase-hex SHA-256: 64 hex chars. */
export const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

/** Type-guard: a well-formed lowercase-hex SHA-256 string. */
export function isHexSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256_RE.test(value);
}

/** SHA-256 of `buf`, lowercase hex. Accepts an ArrayBuffer or a typed-array view. */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  // Normalise to a plain ArrayBuffer for Web-Crypto. The hot path (a host PUT
  // handing in `request.arrayBuffer()`) passes straight through with no copy; a
  // Uint8Array view is sliced to exactly its bytes. The `as ArrayBuffer` bridges
  // the TS 5.7+ ArrayBufferLike↔ArrayBuffer typed-array variance. Bare `crypto`
  // is the ambient Web-Crypto global across Node 18+, Workers, Deno, browsers.
  const data: ArrayBuffer =
    buf instanceof Uint8Array
      ? (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      : buf;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * A content-addressing scheme: a `<prefix>/<hash><ext>` key layout. Lets a host
 * pick its own namespace + extension (`snapshots/<sha>.tar.gz`,
 * `blobs/<sha>.bin`, …) while the registry logic stays scheme-agnostic.
 */
export interface ContentAddressing {
  readonly prefix: string;
  readonly ext: string;
  /** The storage key for `hash` under this scheme. */
  key(hash: string): string;
  /** Does `key` equal this scheme's key for `hash`? (content-addressed guard) */
  matches(key: string, hash: string): boolean;
  /** Extract the hash from a key, or null if it doesn't fit this scheme. */
  parse(key: string): string | null;
}

/** Build a `<prefix>/<hash><ext>` content-addressing scheme. */
export function contentAddressing(opts: { prefix: string; ext?: string }): ContentAddressing {
  const prefix = opts.prefix.replace(/\/+$/, '');
  const ext = opts.ext ?? '';
  return {
    prefix,
    ext,
    key: (hash) => `${prefix}/${hash}${ext}`,
    matches: (key, hash) => key === `${prefix}/${hash}${ext}`,
    parse: (key) => {
      const head = `${prefix}/`;
      if (!key.startsWith(head) || !key.endsWith(ext)) return null;
      const mid = key.slice(head.length, ext.length ? key.length - ext.length : key.length);
      return HEX_SHA256_RE.test(mid) ? mid : null;
    },
  };
}
