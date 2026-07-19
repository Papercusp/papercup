/**
 * secrets-guard.test.ts — G-10 secret-pattern guard (pure, no git/PG). Proves
 * the high-signal rules catch real credential shapes, the generic
 * secret-assignment rule is entropy-gated (placeholders pass), clean code is
 * clean, and the secret is masked in the finding.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/secrets-guard.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanTextForSecrets,
  scanForSecrets,
  hasSecrets,
  isFixtureFile,
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

  it('does NOT flag AWS documented EXAMPLE keys (shape-rule example exemption)', () => {
    // AWS reserves the literal EXAMPLE suffix for its non-functional docs keys.
    // A runbook that merely CITES AKIAIOSFODNN7EXAMPLE must not wedge the publish
    // plane — this false positive was the P-402 canonical-stall root cause.
    const example = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'; // = AKIAIOSFODNN7EXAMPLE
    const doc = scanTextForSecrets(
      'agent-insights/desktop-release-upload-runbook.mdx',
      `Real example: \`${example}\` is AWS's own non-functional example key.`,
    );
    expect(doc).toEqual([]);
    // But a genuinely-shaped key that does NOT end in EXAMPLE still flags.
    expect(scanTextForSecrets('c.ts', `k="${AKIA}"`).some((x) => x.rule === 'aws-access-key-id')).toBe(true);
  });

  it('flags a GitHub token and a PEM private-key block', () => {
    const gh = scanTextForSecrets('a.env', `GITHUB_TOKEN=${GH}`);
    expect(gh.some((x) => x.rule === 'github-token')).toBe(true);
    // Header assembled at runtime so THIS test file's bytes never contain a
    // PEM-shaped block — the guard scans the publish range, us included.
    const pemHeader = ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join('');
    const pem = scanTextForSecrets('id_rsa', `${pemHeader}\nabc\n-----END-----`);
    expect(pem.some((x) => x.rule === 'private-key-pem')).toBe(true);
  });

  it('secret-assignment rule is entropy-gated: real value flagged, placeholder ignored', () => {
    // Value assembled from <20-char fragments so this file's bytes can't match
    // the {20,} capture — the runtime string is still a realistic secret.
    const value = ['Zx9Kq2mNp7Rw4T', 'v8Lb3Yh6Fd1Gs5Jc0'].join('');
    const real = scanTextForSecrets('c.ts', `const client_secret = "${value}"`);
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

  it('exempts this fixture file by path (scanner must not scan its own fixtures)', () => {
    // This file's historical blobs carry literal credential shapes; without a
    // path exemption, editing it wedges the whole publish plane forever (the
    // literal blob can never leave the publish range). scanForSecrets/hasSecrets
    // therefore skip the designated fixture path — but the pure per-line
    // scanTextForSecrets stays path-agnostic so the rule tests above still fire.
    const fixturePath = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';
    expect(isFixtureFile(fixturePath)).toBe(true);
    expect(isFixtureFile('packages/operator-core/lib/sync/pot-git/own-head-publish.ts')).toBe(false);
    const loaded = `k="${AKIA}"\n${GH}`; // real shapes that WOULD flag anywhere else
    expect(scanForSecrets([{ path: fixturePath, content: loaded }])).toEqual([]);
    expect(hasSecrets([{ path: fixturePath, content: loaded }])).toBe(false);
    // Same content at a non-fixture path still flags — the exemption is path-scoped.
    expect(scanForSecrets([{ path: 'src/config.ts', content: loaded }]).length).toBeGreaterThanOrEqual(2);
  });

  it('BLOCKING publish paths use the exemption-aware entrypoint, never the raw primitive', () => {
    // The trap this guards (P-402 / EI-13924, 2026-07-19): github-egress called
    // the per-line `scanTextForSecrets` directly, so it never applied
    // isFixtureFile. The scanner's own fixture blobs flagged, egress refused
    // every tick, and origin/staging froze for hours — unrecoverable by any
    // re-commit, because the offending blob is permanently inside the pushed
    // range. Only a scanner-code change can clear it, so the fix must be
    // structural: a path that BLOCKS a publish must scan via `scanForSecrets`.
    // (content-op-egress-guard is deliberately excluded — it REDACTS lines
    // rather than blocking, so it cannot deadlock a publish plane.)
    const blockingPublishPaths = ['github-egress.ts', 'publish-guard.ts', 'foreign-mirror-quarantine.ts'];
    for (const file of blockingPublishPaths) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      const calls = src.match(/\bscanTextForSecrets\s*\(/g) ?? [];
      expect(calls, `${file} must not call scanTextForSecrets directly — use scanForSecrets`).toEqual([]);
      expect(src, `${file} must scan via scanForSecrets`).toMatch(/\bscanForSecrets\s*\(/);
    }
  });
});
