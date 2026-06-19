/**
 * Coverage for console-launcher.shellSafeId — the allowlist guard for session
 * ids embedded in a shell greeting. Accepts only the randomUUID alphabet
 * [0-9a-f-]; throws (rather than escaping) on anything else.
 */
import { describe, expect, it } from 'vitest';
import { shellSafeId, buildSuperuserMcpUrl } from './console-launcher';

describe('shellSafeId', () => {
  it('accepts a UUID-shaped id', () => {
    const id = '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8';
    expect(shellSafeId(id)).toBe(id);
  });

  it('accepts the hex+dash alphabet case-insensitively', () => {
    expect(shellSafeId('ABCDEF-012345')).toBe('ABCDEF-012345');
  });

  it.each([
    ['has a space', 'abc def'],
    ['shell metachars', 'abc; rm -rf /'],
    ['command substitution', '$(whoami)'],
    ['out-of-alphabet letter', 'deadbeefz'],
    ['empty', ''],
  ])('throws on %s', (_label, bad) => {
    expect(() => shellSafeId(bad)).toThrow(/unsafe session id/);
  });
});

describe('buildSuperuserMcpUrl (scoped-superuser-workspace-clamp D-004)', () => {
  it('scoped-by-default: bakes the concrete workspace so the dispatch clamp confines the session', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test'));
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('workspace')).toBe('generic-test');
  });

  it('allWorkspaces: bakes the UNSCOPED wildcard (the only door past the clamp)', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test', true));
    expect(url.searchParams.get('workspace')).toBe('*');
  });
});
