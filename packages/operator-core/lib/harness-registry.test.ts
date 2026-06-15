import { describe, it, expect } from 'vitest';
import { hiveMemberHarnessScopes } from './harness-registry';

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
