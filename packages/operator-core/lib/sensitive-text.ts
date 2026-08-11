/**
 * Pure, dependency-free redaction for diagnostic text that can cross a UI,
 * log, or persistence boundary.
 *
 * This is intentionally shared. Session-part ingest already needed both
 * self-identifying token shapes and key-directed values; the task manager now
 * applies the same rules before exposing `/proc` cmdlines and upstream errors.
 */

const SELF_IDENTIFYING_SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

const KEY_DIRECTED_SECRET_RE = new RegExp(
  [
    String.raw`((?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential)s?["'\s]*[:=]\s*["']?)([^\s"',;&)}\]]{8,})`,
    String.raw`((?:authorization|proxy-authorization)["'\s]*[:=]\s*["']?(?:bearer|basic|token)\s+)([^\s"',;&)}\]]{8,})`,
    String.raw`(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(?=-----END)`,
  ].join('|'),
  'gi',
);

/** Scrub token shapes that identify themselves without any surrounding key. */
export function redactSelfIdentifyingSecrets(text: string): string {
  return text.replace(SELF_IDENTIFYING_SECRET_RE, '[redacted]');
}

/** Scrub opaque values identified by a credential key/header next to them. */
export function redactKeyDirectedSecrets(text: string): string {
  return text.replace(KEY_DIRECTED_SECRET_RE, (_match, ...groups: unknown[]) => {
    // Groups are [key1, value1, key2, value2, key3, value3, offset, input].
    for (let i = 0; i < 6; i += 2) {
      if (typeof groups[i] === 'string') return `${groups[i]}[redacted]`;
    }
    return '[redacted]';
  });
}

/** Defense-in-depth composition for arbitrary diagnostic text. */
export function redactSensitiveText(text: string): string {
  return redactKeyDirectedSecrets(redactSelfIdentifyingSecrets(text));
}
