/**
 * clone-repo-authed.test.ts — step2_cloneRepo authenticated-clone wiring (B4).
 *
 * Verifies the join step uses a token-embedded clone URL when a token is given
 * and then resets `origin` to the token-free URL (so the secret never persists
 * in .git/config), and uses an anonymous URL with no reset when no token.
 */

import { describe, it, expect, vi } from 'vitest';
import { step2_cloneRepo } from '../join-shared-harness';

// A slug that will not collide with any real clone dir on disk, so the
// existsSync(cloneDir) idempotency short-circuit does not fire.
const UNIQUE_SLUG = 'b4-authed-clone-test-zzq-' + 'fixed';

function fakeExec() {
  return vi.fn(async (_file: string, _args: string[]) => ({ stdout: '', stderr: '' }));
}

describe('step2_cloneRepo — authenticated clone (B4)', () => {
  it('with a token: clones via token-embedded URL then de-tokenizes origin', async () => {
    const exF = fakeExec();
    await step2_cloneRepo({
      githubFullName: 'papercupai/private-repo',
      slug: UNIQUE_SLUG + '-tok',
      token: 'ghs_secret',
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    });
    const calls = exF.mock.calls.map((c) => c[1] as string[]);
    const cloneCall = calls.find((a) => a[0] === 'clone');
    const setUrlCall = calls.find((a) => a.includes('set-url'));
    expect(cloneCall?.some((a) => a === 'https://x-access-token:ghs_secret@github.com/papercupai/private-repo.git')).toBe(true);
    // origin reset to the token-free URL
    expect(setUrlCall).toBeDefined();
    expect(setUrlCall).toContain('https://github.com/papercupai/private-repo.git');
    // the token-free URL carries no secret
    expect(setUrlCall?.join(' ')).not.toContain('ghs_secret');
  });

  it('without a token: anonymous clone and no origin reset', async () => {
    const exF = fakeExec();
    await step2_cloneRepo({
      githubFullName: 'papercupai/public-repo',
      slug: UNIQUE_SLUG + '-anon',
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    });
    const calls = exF.mock.calls.map((c) => c[1] as string[]);
    const cloneCall = calls.find((a) => a[0] === 'clone');
    expect(cloneCall?.some((a) => a === 'https://github.com/papercupai/public-repo')).toBe(true);
    expect(calls.find((a) => a.includes('set-url'))).toBeUndefined();
  });
});
