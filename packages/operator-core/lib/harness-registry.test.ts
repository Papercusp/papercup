import { describe, it, expect } from 'vitest';
import { hiveMemberHarnessScopes, resolveHarnessContentPath } from './harness-registry';

/**
 * hiveMemberHarnessScopes (per-hive-learning-loops-2026-06-14 P-040, D-008 — the
 * Hive is the tenancy unit). Pure mapping over the registry projects: a Hive's
 * member-harness improvement/work scopes = the home harness + every project whose
 * `hive_slug` points at it, each as a `harness:<slug>` scope. Pinned without PG.
 */
describe('hiveMemberHarnessScopes', () => {
  it('includes the home + every hive_slug member, prefixed harness:', () => {
    const projects = [
      { slug: 'my-hive', hive_slug: undefined },
      { slug: 'member-a', hive_slug: 'my-hive' },
      { slug: 'member-b', hive_slug: 'my-hive' },
      { slug: 'other-hive', hive_slug: undefined },
      { slug: 'other-member', hive_slug: 'other-hive' },
    ];
    const scopes = hiveMemberHarnessScopes(projects, 'my-hive');
    expect(scopes.sort()).toEqual(['harness:member-a', 'harness:member-b', 'harness:my-hive']);
  });

  it('returns just the home scope for a Hive with no joined members', () => {
    const scopes = hiveMemberHarnessScopes([{ slug: 'lonely-hive' }], 'lonely-hive');
    expect(scopes).toEqual(['harness:lonely-hive']);
  });

  it('includes the home scope even when the home is absent from the registry (defensive)', () => {
    // The home should always be a member of its own Hive even if its registry
    // row is missing — the feed must never silently exclude the home harness.
    const scopes = hiveMemberHarnessScopes([{ slug: 'member-a', hive_slug: 'my-hive' }], 'my-hive');
    expect(scopes.sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('de-duplicates (a project listed once, the home counted once)', () => {
    const scopes = hiveMemberHarnessScopes(
      [{ slug: 'my-hive' }, { slug: 'my-hive', hive_slug: 'my-hive' }],
      'my-hive',
    );
    expect(scopes).toEqual(['harness:my-hive']);
  });
});

/**
 * resolveHarnessContentPath — a `harness_kind:'hive'` home normally borrows its
 * MEMBER repo's checkout, EXCEPT a `self_repo` hive (papercusp) which IS its own
 * checkout and must use its own path. Regression: a stray member (hive-canary,
 * hive_slug='papercusp') was hijacking papercusp's docs/tests reads, emptying the
 * Tests tab and nulling every doc body. Pure over the registry projects.
 */
describe('resolveHarnessContentPath', () => {
  it('a self_repo hive uses its OWN path, never a stray member (papercusp/hive-canary regression)', () => {
    const reg = {
      projects: [
        { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
        // a stray project that set hive_slug to the self_repo hive must NOT hijack it
        { slug: 'hive-canary', path: '/repos/hive-canary', hive_slug: 'papercusp' },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'papercusp')).toBe('/repos/papercusp');
  });

  it('a repo-less hive home borrows its member checkout', () => {
    const reg = {
      projects: [
        { slug: 'coding-hive', path: '/state/coding-hive', harness_kind: 'hive' },
        { slug: 'member', path: '/repos/member', hive_slug: 'coding-hive' },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'coding-hive')).toBe('/repos/member');
  });

  it('a self_repo hive with no member still uses its own path', () => {
    const reg = {
      projects: [
        { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'papercusp')).toBe('/repos/papercusp');
  });

  it('a plain (non-hive) harness uses its own path', () => {
    const reg = { projects: [{ slug: 'oddsmith', path: '/repos/oddsmith' }] };
    expect(resolveHarnessContentPath(reg, 'oddsmith')).toBe('/repos/oddsmith');
  });

  it('returns undefined for an unregistered slug', () => {
    expect(resolveHarnessContentPath({ projects: [] }, 'nope')).toBeUndefined();
  });
});
