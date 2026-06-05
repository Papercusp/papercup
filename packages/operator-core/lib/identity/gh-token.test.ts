import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearGhAuthTokenCache,
  parseScopesFromGhStatus,
} from './gh-token';

describe('parseScopesFromGhStatus', () => {
  it('parses a typical "Token scopes:" line', () => {
    const sample = `
github.com
  ✓ Logged in to github.com account papercupai (/path/to/hosts.yml)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo', 'workflow'
`;
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(
      new Set(['admin:public_key', 'gist', 'read:org', 'repo', 'workflow']),
    );
  });

  it('returns an empty set when no scopes line is present', () => {
    expect(parseScopesFromGhStatus('something else entirely').size).toBe(0);
  });

  it('handles the singular "Token scope:" spelling too', () => {
    const sample = "  - Token scope: 'gist'";
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(new Set(['gist']));
  });

  it('unions scopes across multiple accounts', () => {
    const sample = `
github.com
  ✓ Logged in to github.com account a
  - Token scopes: 'gist', 'read:org'
  ✓ Logged in to github.com account b
  - Token scopes: 'repo', 'workflow'
`;
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(new Set(['gist', 'read:org', 'repo', 'workflow']));
  });

  it('strips surrounding quotes of either flavor', () => {
    const sample = `  - Token scopes: "gist", 'repo'`;
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(new Set(['gist', 'repo']));
  });

  it('drops empty entries from a trailing comma', () => {
    const sample = `  - Token scopes: 'gist', ,`;
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(new Set(['gist']));
  });

  it('is case-insensitive on the "Token scopes:" prefix', () => {
    const sample = `  - TOKEN SCOPES: 'gist'`;
    const scopes = parseScopesFromGhStatus(sample);
    expect(scopes).toEqual(new Set(['gist']));
  });
});

describe('cache lifecycle', () => {
  beforeEach(() => {
    clearGhAuthTokenCache();
  });

  it('clearGhAuthTokenCache is safe to call repeatedly', () => {
    expect(() => {
      clearGhAuthTokenCache();
      clearGhAuthTokenCache();
      clearGhAuthTokenCache();
    }).not.toThrow();
  });
});

describe('getGhAuthToken — integration smoke', () => {
  // Only runs when `gh auth status` actually succeeds locally.
  // CI without auth skips; explicit, no false negatives.
  it('returns a non-empty token when gh is authenticated (skipped in CI)', async () => {
    const { execFile: execFileSync } = await import('node:child_process');
    const { promisify: pify } = await import('node:util');
    const exec = pify(execFileSync);
    try {
      await exec('gh', ['auth', 'token'], { timeout: 3_000 });
    } catch {
      // No gh / not authenticated — skip.
      return;
    }
    clearGhAuthTokenCache();
    const { getGhAuthToken } = await import('./gh-token');
    const result = await getGhAuthToken();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.token.length).toBeGreaterThan(20);
      // gh tokens start with "gho_" (OAuth user-to-server) or "ghp_"
      // (personal access tokens). Sanity-check, don't lock to one.
      expect(result.token).toMatch(/^gh[ops]_/);
    }
  }, 10_000);
});
