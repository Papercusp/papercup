/**
 * Tests for testing-branch-resolve.ts.
 *
 * We run against the live repo (this checkout IS a git repo) — a
 * mocked test wouldn't catch the cwd / inferWorkspaceRoot interaction
 * which was the actual bug class.
 *
 * WI-3831: a release SOURCE BUNDLE intentionally ships without `.git`
 * (papercusp-desktop/bin/stage-source-tree.sh excludes it), so on a packaged
 * install `inferWorkspaceRoot()` points at a real directory that just isn't a
 * git repo — this integration-style check has no repo to run against there.
 * Self-skip on that precondition (same pattern as tsx-runtime-imports.test.ts)
 * rather than red-noising every packaged-install run; the hermetic sibling
 * `../testing-branch-resolve.test.ts` (mocked exec) still covers the resolver's
 * logic unconditionally.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { inferWorkspaceRoot } from '@papercusp/testing-shell/glob';
import { resolveGitContext, _resetGitContextCache } from '../testing-branch-resolve';

const IS_GIT_REPO = existsSync(join(inferWorkspaceRoot(), '.git'));

describe.skipIf(!IS_GIT_REPO)('resolveGitContext', () => {
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
