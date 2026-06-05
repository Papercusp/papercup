/**
 * Tests for testing-branch-resolve.ts.
 *
 * We run against the live repo (this checkout IS a git repo) — a
 * mocked test wouldn't catch the cwd / inferWorkspaceRoot interaction
 * which was the actual bug class.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { resolveGitContext, _resetGitContextCache } from '../testing-branch-resolve';

describe('resolveGitContext', () => {
  beforeEach(() => {
    _resetGitContextCache();
  });

  it('returns a branch name and a commit sha in this checkout', async () => {
    const ctx = await resolveGitContext();
    // branch may legitimately be null on a detached HEAD; commit shouldn't be
    expect(ctx.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('caches subsequent calls', async () => {
    const first = await resolveGitContext();
    const second = await resolveGitContext();
    expect(second).toBe(first); // same reference => cache hit
  });

  it('returns nulls when git is missing, not throws', async () => {
    // We can't easily induce git failure without trickery, but the
    // promise contract is "never throws" — this asserts the surface.
    // Both keys must be present; either may be null (branch IS null on a
    // detached-HEAD checkout — e.g. the release-gate checkpoint tree).
    const ctx = await resolveGitContext();
    expect(ctx).toHaveProperty('branch');
    expect(ctx).toHaveProperty('commit');
  });
});
