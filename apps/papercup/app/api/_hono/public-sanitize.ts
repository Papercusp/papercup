// Sanitization helpers for the public Papercup API surface.
//
// Every field that comes from internal admin endpoints MUST flow through
// these helpers before being exposed via /api/public/*. The point is to make
// it mechanical: there is no "did I remember to scrub this?" — a single
// `sanitizeForPublic` pass at the end of every handler is a lint-friendly
// rule.

const HOME_RE = /\/(home\/[^/\s)]+|root|tmp|var\/run|etc)\b\/?/g;
const SECRET_RES: RegExp[] = [
  /cfut_[A-Za-z0-9_]+/g,                   // Cloudflare API tokens
  /sk-[A-Za-z0-9_-]{20,}/g,                // OpenAI/Anthropic-style keys
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
  /Bearer\s+[A-Za-z0-9_.-]+/gi,            // Bearer tokens
  /xoxb-[A-Za-z0-9-]+/g,                   // Slack bot tokens
  /xoxp-[A-Za-z0-9-]+/g,                   // Slack user tokens
  /AKIA[0-9A-Z]{16}/g,                     // AWS access key
  /ASIA[0-9A-Z]{16}/g,                     // AWS session token
  /-----BEGIN[\s\S]+?-----END[^-]+-----/g, // PEM keys
  /AIza[0-9A-Za-z\-_]{35}/g,               // Google API keys
  /ghp_[A-Za-z0-9]{36}/g,                  // GitHub personal access tokens
  /ghs_[A-Za-z0-9]{36}/g,                  // GitHub server tokens
  /gho_[A-Za-z0-9]{36}/g,                  // GitHub OAuth tokens
  /glpat-[A-Za-z0-9_-]{20,}/g,             // GitLab personal access tokens
  /v1\.[0-9a-f]{40}/g,                     // Generic v1 hex tokens (40+ chars)
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, // SendGrid
];

// PII patterns — applied via redactPii() ONLY to free-text payloads
// (logs, decisions, brainstorm content). Not applied to structured fields.
const PII_RES: RegExp[] = [
  // Emails — preserve @papercupai.com which is intentionally public
  /[a-zA-Z0-9._-]+@(?!papercupai\.com\b)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/g,
  // US/international phone numbers
  /\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // Credit card-like 16-digit numbers
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  // SSN-like patterns
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function redactPii(s: string): string {
  if (!s) return s;
  let out = s;
  for (const re of PII_RES) out = out.replace(re, '[redacted-pii]');
  return out;
}

const ENV_KEY_RE = /(API_KEY|SECRET|TOKEN|PRIVATE|PASSWORD|PASSPHRASE)[A-Z_]*/gi;

const MAX_LOG_LINE = 1000;
const MAX_LOG_LINES = 200;
const MAX_BODY_FIELD = 4000;

export function stripPaths(s: string): string {
  if (!s) return s;
  return s.replace(HOME_RE, '~/');
}

export function redactSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  for (const re of SECRET_RES) out = out.replace(re, '[redacted-secret]');
  return out;
}

export function redactEnvKeys(s: string): string {
  if (!s) return s;
  return s.replace(ENV_KEY_RE, '[ENV-REDACTED]');
}

/** Top-level scrub: paths + secrets + env-style key names. */
export function scrub(s: string | null | undefined): string {
  if (!s) return '';
  return redactEnvKeys(redactSecrets(stripPaths(String(s))));
}

/** Stronger scrub for free-text content (logs, notes, decisions, brainstorm).
 *  Adds PII redaction on top of the base scrub. */
export function scrubFreeText(s: string | null | undefined): string {
  if (!s) return '';
  return redactPii(scrub(s));
}

/** Cap a log blob: max N lines, max M chars per line. */
export function capLog(raw: string | null | undefined, opts: { maxLines?: number; maxLineChars?: number } = {}): string {
  if (!raw) return '';
  const maxLines = opts.maxLines ?? MAX_LOG_LINES;
  const maxLineChars = opts.maxLineChars ?? MAX_LOG_LINE;
  const lines = raw.split('\n');
  const start = Math.max(0, lines.length - maxLines);
  return lines
    .slice(start)
    .map((line) => (line.length > maxLineChars ? line.slice(0, maxLineChars) + '…' : line))
    .map((line) => scrub(line))
    .join('\n');
}

/** Truncate a body field with ellipsis. */
export function capBody(s: string | null | undefined, maxChars: number = MAX_BODY_FIELD): string {
  const cleaned = scrub(s ?? '');
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars) + '\n\n…[truncated]';
}

/** Drop any obviously-secret keys from an object recursively. */
export function dropSensitiveKeys<T = unknown>(obj: T, depth: number = 0): T {
  if (depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => dropSensitiveKeys(v, depth + 1)) as unknown as T;
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/api[_-]?key|secret|token|password|cookie|env\b/i.test(k)) continue;
      if (k === 'cwd' || k === 'path' || k === 'env') continue;
      out[k] = dropSensitiveKeys(v, depth + 1);
    }
    return out as T;
  }
  if (typeof obj === 'string') return scrub(obj) as unknown as T;
  return obj;
}

/** Fully sanitize a payload for public exposure. */
export function sanitizeForPublic<T = unknown>(payload: T): T {
  return dropSensitiveKeys(payload);
}
