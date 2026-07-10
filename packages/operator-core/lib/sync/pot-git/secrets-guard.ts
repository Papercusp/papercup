/**
 * hive-git/secrets-guard.ts — refuse to publish a commit whose changed content
 * carries a secret (Phase 7 G-10, cross-machine-coord-parity-and-trust-2026-07-01
 * / P-043; D-011). The sibling of run-git-sync.ts's oversized-blob guard: that
 * one blocks a blob GitHub would reject; this one blocks a blob no one should
 * ever replicate to peers. REQUIRED before multi-owner autocommit replication —
 * once a device's raw autocommits federate to other owners' machines, a leaked
 * key is exfiltrated hive-wide, so the leak must be caught at PUBLISH time.
 *
 * PRECISION over recall: a false positive BLOCKS a legitimate commit, so the
 * rule set is deliberately high-signal — known credential SHAPES (AWS keys, PEM
 * private-key blocks, GitHub/Slack/Stripe token prefixes) plus a generic
 * "secret-named assignment to a high-entropy value" rule. It does NOT entropy-scan
 * arbitrary strings (git shas, minified assets, lockfile hashes would all trip
 * it). The caller decides what to scan (the publish diff); this module is pure.
 */

/** One secret match in a changed file. */
export interface SecretFinding {
  path: string;
  /** 1-indexed line. */
  line: number;
  /** The rule id that matched (stable, for allowlisting / messaging). */
  rule: string;
  /** A redacted excerpt (the secret itself is masked) for the operator message. */
  excerpt: string;
}

interface Rule {
  id: string;
  re: RegExp;
}

/** High-signal credential shapes. Each `re` is applied per line (global, so a
 *  line with two keys yields two findings). */
const RULES: Rule[] = [
  // AWS access key ids (long-lived AKIA + temporary ASIA).
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (personal/oauth/server/refresh/fine-grained).
  { id: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g },
  // Slack tokens.
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live secret keys.
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  // Google API keys.
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  // Private key PEM blocks (RSA/EC/DSA/OpenSSH/PGP/plain).
  { id: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // Generic bearer/JWT-ish: a secret-named assignment to a long high-entropy value.
  {
    id: 'secret-assignment',
    re: /\b(?:secret|password|passwd|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?([A-Za-z0-9+/_\-]{20,})['"]?/gi,
  },
];

/** Shannon entropy (bits/char) of a string — used to keep the generic
 *  secret-assignment rule from firing on obvious non-secrets (e.g. a value like
 *  "changeme-in-production-please" is low entropy; a real token is high). */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Min entropy for the generic secret-assignment value to count as a secret. */
const SECRET_ASSIGNMENT_MIN_ENTROPY = 3.2;

/** Obvious placeholder values — suppress the generic rule so docs/examples don't
 *  block a commit (a real secret won't contain these markers). */
const PLACEHOLDER_RE =
  /your|here|goes|example|changeme|change-me|placeholder|dummy|sample|redacted|xxxx|<[a-z]|\btest\b|todo|fixme|none|null|undefined/i;

function mask(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/** Scan one file's text for secrets. Pure. */
export function scanTextForSecrets(path: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4096) continue; // skip minified/one-line blobs — no line-secrets there
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        // The generic assignment rule captures the value in group 1 — gate it on
        // entropy so a placeholder ("your-secret-here") doesn't trip the build.
        if (rule.id === 'secret-assignment') {
          const value = m[1] ?? '';
          if (shannonEntropy(value) < SECRET_ASSIGNMENT_MIN_ENTROPY) continue;
          if (PLACEHOLDER_RE.test(value)) continue; // an obvious example/placeholder, not a secret
          findings.push({ path, line: i + 1, rule: rule.id, excerpt: mask(value) });
        } else {
          findings.push({ path, line: i + 1, rule: rule.id, excerpt: mask(m[0]) });
        }
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width
      }
    }
  }
  return findings;
}

/** Scan a set of changed files. `path` is used only for reporting + the .env
 *  heuristic; pass the NEW content of each changed/added file. */
export function scanForSecrets(files: { path: string; content: string }[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of files) out.push(...scanTextForSecrets(f.path, f.content));
  return out;
}

/** True iff any changed file carries a secret — the publish path's fast gate. */
export function hasSecrets(files: { path: string; content: string }[]): boolean {
  return files.some((f) => scanTextForSecrets(f.path, f.content).length > 0);
}

/** A one-line operator message for a set of findings (secrets already masked). */
export function describeSecretFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return 'no secrets found';
  const head = findings
    .slice(0, 5)
    .map((f) => `${f.path}:${f.line} [${f.rule}] ${f.excerpt}`)
    .join('; ');
  const more = findings.length > 5 ? ` (+${findings.length - 5} more)` : '';
  return `refusing to publish — ${findings.length} secret(s): ${head}${more}`;
}
