/**
 * github-ingress.test.ts — unit tests for the PURE synthetic-device derivation
 * (github-bridge-hive-egress-2026-07-02 P-002, S-3). The git-touching ingress
 * flow is covered by github-ingress.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { deviceNamespaceKey } from './storage';
import {
  githubOriginDevicePubkey,
  githubOriginNamespaceKey,
  normalizeGithubRemote,
} from './github-ingress';

describe('normalizeGithubRemote (one identity across URL forms)', () => {
  it('canonicalizes https / ssh / scp-style / .git / trailing-slash forms to one identity', () => {
    const forms = [
      'https://github.com/Acme/Widgets',
      'https://github.com/acme/widgets.git',
      'http://github.com/ACME/WIDGETS/',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets',
      'github.com/acme/widgets',
    ];
    for (const f of forms) {
      expect(normalizeGithubRemote(f), f).toBe('github.com/acme/widgets');
    }
  });

  it('distinct repos stay distinct', () => {
    expect(normalizeGithubRemote('https://github.com/acme/widgets')).not.toBe(
      normalizeGithubRemote('https://github.com/acme/gadgets'),
    );
  });

  it('a non-GitHub remote falls back to the trimmed URL (still deterministic)', () => {
    expect(normalizeGithubRemote('  /tmp/some/origin.git ')).toBe('/tmp/some/origin.git');
    expect(normalizeGithubRemote('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b');
  });
});

describe('githubOriginDevicePubkey / githubOriginNamespaceKey', () => {
  it('is a valid raw-32 pubkey shape every storage helper accepts', () => {
    const pk = githubOriginDevicePubkey('https://github.com/acme/widgets');
    expect(Buffer.from(pk, 'base64').length).toBe(32);
    // deviceNamespaceKey (the ONE canonical mapping) accepts it → 64-hex.
    expect(deviceNamespaceKey(pk)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same repo through different URL forms → the SAME namespace (peers converge)', () => {
    expect(githubOriginNamespaceKey('git@github.com:acme/widgets.git')).toBe(
      githubOriginNamespaceKey('https://github.com/Acme/Widgets'),
    );
  });

  it('different repos → different namespaces', () => {
    expect(githubOriginNamespaceKey('https://github.com/acme/widgets')).not.toBe(
      githubOriginNamespaceKey('https://github.com/acme/gadgets'),
    );
  });

  it('namespaceKey matches what ingress reports', () => {
    const url = 'https://github.com/acme/widgets';
    expect(githubOriginNamespaceKey(url)).toBe(deviceNamespaceKey(githubOriginDevicePubkey(url)));
  });
});
