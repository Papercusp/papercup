/**
 * clone-repo-authed.test.ts — step2_cloneRepo authenticated-clone wiring (B4,
 * WI-3057).
 *
 * Verifies the join step uses a token-embedded clone URL when a token is given
 * and then resets `origin` to the token-free URL (so the secret never persists
 * in .git/config), uses an anonymous URL with no reset when no token, AND
 * (WI-3057 follow-up) that the "adopt an existing clone" idempotency path
 * cannot silently perpetuate a token that leaked into `.git/config` on some
 * EARLIER clone — it must detect + repair a tokenized origin (or fail loudly
 * and force a re-clone) even though the current call may not pass a token.
 *
 * The fake `exF` below models real git remote state (a `currentOrigin`
 * closure var updated by `clone`/`set-url`, read by `get-url`) rather than
 * always returning empty stdout — `ensureDetokenizedOrigin` decides whether to
 * act based on what `get-url` reports, so a stateless mock would hide bugs in
 * either direction (false trigger, or false "already clean").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { step2_cloneRepo } from '../join-shared-harness';
import { workspacesRoot } from '../../workspace-registry';

// A slug that will not collide with any real clone dir on disk, so the
// existsSync(cloneDir) idempotency short-circuit does not fire.
const UNIQUE_SLUG = 'b4-authed-clone-test-zzq-' + 'fixed';

// The stateful mock's `clone` branch mkdir's the REAL clone dir on disk, and the
// authenticated-clone describe below has no per-test cleanup of its own. Because
// the slug is FIXED and workspacesRoot() is a shared, global path, a prior run —
// or one killed mid-suite (e.g. an interrupted green-checkpoint) — leaves
// `clones/<UNIQUE_SLUG>-tok` behind. On the next run existsSync(cloneDir) is then
// true, so step2_cloneRepo takes the adopt-existing branch instead of cloning →
// no `clone` call is recorded → the "clones via token-embedded URL" assertion
// fails. This was the root cause of the 2026-07-05 gate red (a fleet-wide stuck
// gate). Purge THIS test's clone dirs before AND after every test so a leaked
// dir can never poison a run again.
const TEST_CLONES_BASE = resolve(workspacesRoot(), 'clones');
function purgeTestCloneDirs(): void {
  if (!existsSync(TEST_CLONES_BASE)) return;
  for (const name of readdirSync(TEST_CLONES_BASE)) {
    if (name.startsWith(UNIQUE_SLUG)) {
      rmSync(join(TEST_CLONES_BASE, name), { recursive: true, force: true });
    }
  }
}
beforeEach(purgeTestCloneDirs);
afterEach(purgeTestCloneDirs);

function fakeExec() {
  return vi.fn(async (_file: string, _args: string[]) => ({ stdout: '', stderr: '' }));
}

/** A stateful fake modeling git's real remote-url behavior for one clone dir. */
function statefulExec(opts: { initialOrigin?: string; setUrlFails?: boolean } = {}) {
  let origin = opts.initialOrigin ?? '';
  let cloneDir = '';
  const exF = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'clone') {
      cloneDir = args[args.length - 1];
      origin = args[args.length - 2]; // the URL passed to `git clone <url> <dir>`
      await mkdir(cloneDir, { recursive: true });
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '-C' && args.includes('rev-parse')) {
      return { stdout: '', stderr: '' }; // valid repo
    }
    if (args.includes('get-url')) {
      return { stdout: origin + '\n', stderr: '' };
    }
    if (args.includes('set-url')) {
      if (opts.setUrlFails) {
        throw new Error(`failed for ${origin}`);
      }
      origin = args[args.length - 1];
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  return { exF, getCloneDir: () => cloneDir, getOrigin: () => origin };
}

describe('step2_cloneRepo — authenticated clone (B4)', () => {
  it('with a token: clones via token-embedded URL then de-tokenizes origin', async () => {
    const { exF } = statefulExec();
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

  it('with a token: fails and removes the clone when origin de-tokenization fails', async () => {
    const { exF, getCloneDir } = statefulExec({ setUrlFails: true });

    const err = await step2_cloneRepo({
      githubFullName: 'papercupai/private-repo',
      slug: UNIQUE_SLUG + '-tok-reset-fail',
      token: 'ghs_secret',
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    }).catch((e) => e);

    expect(err).toMatchObject({
      stepId: 'clone_repo',
      code: 'origin_detokenize_failed',
    });

    const cloneDir = getCloneDir();
    expect(cloneDir).toContain(UNIQUE_SLUG + '-tok-reset-fail');
    expect(existsSync(cloneDir)).toBe(false);
    expect(String(err.message)).not.toContain('ghs_secret');
    expect(String(err.message)).toContain('x-access-token:***@');
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

describe('step2_cloneRepo — adopt-existing-clone path never perpetuates a leaked token (WI-3057)', () => {
  const clonesBase = resolve(workspacesRoot(), 'clones');
  const realDirs: string[] = [];

  afterEach(() => {
    for (const d of realDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function makeRealCloneDir(slug: string): string {
    const dir = join(clonesBase, slug);
    mkdirSync(dir, { recursive: true });
    realDirs.push(dir);
    return dir;
  }

  it('adopting a valid clone whose origin is ALREADY clean: no set-url call, no re-clone', async () => {
    const slug = UNIQUE_SLUG + '-adopt-clean';
    makeRealCloneDir(slug);
    const { exF } = statefulExec({ initialOrigin: 'https://github.com/papercupai/private-repo.git' });

    const result = await step2_cloneRepo({
      githubFullName: 'papercupai/private-repo',
      slug,
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    });

    expect(result.cloneDir).toContain(slug);
    const calls = exF.mock.calls.map((c) => c[1] as string[]);
    expect(calls.find((a) => a[0] === 'clone')).toBeUndefined(); // no re-clone
    expect(calls.find((a) => a.includes('set-url'))).toBeUndefined(); // nothing to repair
  });

  it('adopting a valid clone whose origin is STALE-TOKENIZED (leaked by an earlier, pre-fix clone): repairs it in place — no re-clone needed', async () => {
    const slug = UNIQUE_SLUG + '-adopt-stale-token';
    makeRealCloneDir(slug);
    const { exF, getOrigin } = statefulExec({
      initialOrigin: 'https://x-access-token:stale_leaked_token@github.com/papercupai/private-repo.git',
    });

    const result = await step2_cloneRepo({
      // Note: THIS call passes no token — the repair must still fire, because
      // the danger is the pre-existing plaintext token on disk, not the
      // current call's credentials.
      githubFullName: 'papercupai/private-repo',
      slug,
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    });

    expect(result.cloneDir).toContain(slug);
    const calls = exF.mock.calls.map((c) => c[1] as string[]);
    expect(calls.find((a) => a[0] === 'clone')).toBeUndefined(); // repaired in place, no re-clone
    const setUrlCall = calls.find((a) => a.includes('set-url'));
    expect(setUrlCall).toBeDefined();
    expect(setUrlCall?.join(' ')).not.toContain('stale_leaked_token');
    expect(getOrigin()).toBe('https://github.com/papercupai/private-repo.git');
  });

  it('adopting a clone with a stale-tokenized origin that FAILS to repair: removes the dir and falls through to a fresh, correctly-detokenized clone', async () => {
    const slug = UNIQUE_SLUG + '-adopt-repair-fail';
    const dir = makeRealCloneDir(slug);
    let setUrlAttempts = 0;
    // Stateful origin: starts stale-tokenized (simulating the pre-existing,
    // leaked-token dir being adopted); the FIRST set-url attempt (the adopt
    // repair) fails and leaves origin unchanged; a LATER attempt (the
    // fresh-clone's own de-tokenize, after the adopt branch gives up and
    // re-clones) succeeds and actually updates origin.
    let origin = 'https://x-access-token:stale_leaked_token@github.com/papercupai/private-repo.git';
    const exF = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'clone') {
        origin = args[args.length - 2]; // git clone <url> <dir> sets origin to <url>
        await mkdir(args[args.length - 1], { recursive: true });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === '-C' && args.includes('rev-parse')) {
        return { stdout: '', stderr: '' };
      }
      if (args.includes('get-url')) {
        return { stdout: origin + '\n', stderr: '' };
      }
      if (args.includes('set-url')) {
        setUrlAttempts += 1;
        if (setUrlAttempts === 1) {
          throw new Error('repair attempt during adopt fails'); // origin left unchanged
        }
        origin = args[args.length - 1]; // the fresh-clone's own de-tokenize succeeds
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const result = await step2_cloneRepo({
      githubFullName: 'papercupai/private-repo',
      slug,
      token: 'fresh_token', // this call DOES have a token, so the fresh re-clone can succeed
      execFileFn: exF,
      mkdirFn: vi.fn(async () => undefined),
    });

    expect(result.cloneDir).toBe(dir);
    const calls = exF.mock.calls.map((c) => c[1] as string[]);
    expect(calls.find((a) => a[0] === 'clone')).toBeDefined(); // fell through to a fresh clone
    expect(setUrlAttempts).toBe(2); // one failed repair attempt on adopt, one successful on the fresh clone
  });
});
