/**
 * secrets-guard.test.ts — G-10 secret-pattern guard (pure, no git/PG). Proves
 * the high-signal rules catch real credential shapes, the generic
 * secret-assignment rule is entropy-gated (placeholders pass), clean code is
 * clean, and the secret is masked in the finding.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/secrets-guard.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  scanTextForSecrets,
  scanForSecrets,
  hasSecrets,
  shannonEntropy,
  describeSecretFindings,
} from './secrets-guard';

// Assembled at runtime so this very test file does not contain a literal AKIA…
// token that the guard (or another scanner) would flag when it scans the repo.
const AKIA = 'AKIA' + 'ABCDEFGHIJ123456';
const GH = 'ghp_' + 'a'.repeat(36);

describe('secrets-guard rules', () => {
  it('flags an AWS access key id', () => {
    const f = scanTextForSecrets('config.ts', `const k = "${AKIA}";`);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('aws-access-key-id');
    expect(f[0].line).toBe(1);
    expect(f[0].excerpt).not.toContain(AKIA); // masked
  });

  it('flags a GitHub token and a PEM private-key block', () => {
    const gh = scanTextForSecrets('a.env', `GITHUB_TOKEN=${GH}`);
    expect(gh.some((x) => x.rule === 'github-token')).toBe(true);
    const pem = scanTextForSecrets('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----');
    expect(pem.some((x) => x.rule === 'private-key-pem')).toBe(true);
  });

  it('secret-assignment rule is entropy-gated: real value flagged, placeholder ignored', () => {
    const real = scanTextForSecrets('c.ts', `const client_secret = "Zx9Kq2mNp7Rw4Tv8Lb3Yh6Fd1Gs5Jc0"`);
    expect(real.some((x) => x.rule === 'secret-assignment')).toBe(true);
    // Low-entropy placeholder (repetitive / wordy) must NOT trip the build.
    const placeholder = scanTextForSecrets('c.ts', `const api_key = "your-api-key-goes-right-here"`);
    expect(placeholder.some((x) => x.rule === 'secret-assignment')).toBe(false);
  });

  it('clean source has no findings', () => {
    const clean = `export function add(a: number, b: number) { return a + b; }\nconst url = "https://example.com/api";`;
    expect(scanTextForSecrets('math.ts', clean)).toEqual([]);
    expect(hasSecrets([{ path: 'math.ts', content: clean }])).toBe(false);
  });

  it('skips absurdly long (minified) lines', () => {
    const minified = `x=${'a'.repeat(5000)}${AKIA}`;
    // The AKIA is embedded in a >4096-char line → skipped (no per-line secrets there).
    expect(scanTextForSecrets('bundle.min.js', minified)).toEqual([]);
  });

  it('scanForSecrets aggregates across files; describe masks + counts', () => {
    const findings = scanForSecrets([
      { path: 'a.ts', content: `k="${AKIA}"` },
      { path: 'b.ts', content: `t=${GH}` },
      { path: 'ok.ts', content: 'const x = 1;' },
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const msg = describeSecretFindings(findings);
    expect(msg).toContain('refusing to publish');
    expect(msg).not.toContain(AKIA);
  });

  it('shannonEntropy: random > english word', () => {
    expect(shannonEntropy('Zx9Kq2mNp7Rw4Tv8Lb3Yh6Fd1Gs5Jc0')).toBeGreaterThan(shannonEntropy('passwordpassword'));
  });
});
