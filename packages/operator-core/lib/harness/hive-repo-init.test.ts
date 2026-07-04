/**
 * hive-repo-init — unit tests for the fresh-coding-hive repo finalize
 * (per-hive-git-and-release-gate-2026-06-29 P-003/P-004).
 *
 * Real git in a throwaway dir (the init-local-dir.test.ts pattern), NO network and NO
 * `gh repo create` — the only publish path exercised here is the safe `remote_already_set`
 * short-circuit (it never touches gh). The actual remote-creation path is integration-only
 * (it would create a real GitHub repo), so it is deliberately not unit-tested.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitInitialHiveRepo, publishHiveRepo, DEFAULT_INTEGRATION_BRANCH } from './hive-repo-init';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-repo-init-test-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('commitInitialHiveRepo', () => {
  it('commits the scaffold and puts a fresh repo on the staging branch', async () => {
    git(dir, 'init', '--quiet');
    mkdirSync(join(dir, '.papercusp'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), 'id: x\n', 'utf8');

    const res = await commitInitialHiveRepo({ path: dir, slug: 'x-hive' });
    expect(res.committed).toBe(true);
    expect(res.branch).toBe('staging');
    expect(res.branch).toBe(DEFAULT_INTEGRATION_BRANCH);
    // HEAD now resolves (a real commit exists) and the branch is `staging`.
    expect(git(dir, 'rev-parse', '--verify', 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('staging');
    // The scaffold is in the commit.
    expect(git(dir, 'ls-files')).toContain('.papercusp/blueprint.yaml');
  });

  it('honors a custom integration branch', async () => {
    git(dir, 'init', '--quiet');
    writeFileSync(join(dir, 'README'), 'hi\n', 'utf8');
    const res = await commitInitialHiveRepo({ path: dir, slug: 'x-hive', branch: 'integration' });
    expect(res.committed).toBe(true);
    expect(res.branch).toBe('integration');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('integration');
  });

  it('is a no-op on a repo that already has history (does not touch the branch)', async () => {
    git(dir, 'init', '--quiet');
    git(dir, 'checkout', '-b', 'main');
    writeFileSync(join(dir, 'f'), '1\n', 'utf8');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first', '--quiet');
    const before = git(dir, 'rev-parse', 'HEAD');

    const res = await commitInitialHiveRepo({ path: dir, slug: 'x-hive' });
    expect(res.committed).toBe(false);
    // History + branch untouched (no rename to staging, no new commit).
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('is a no-op on a dir with no .git', async () => {
    const res = await commitInitialHiveRepo({ path: dir, slug: 'x-hive' });
    expect(res.committed).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

describe('publishHiveRepo', () => {
  it('returns the existing remote without creating anything when origin is already set', async () => {
    git(dir, 'init', '--quiet');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/owner/repo.git');
    // NOTE: this path NEVER calls `gh` — it short-circuits on the existing remote, so it is
    // safe + deterministic (no network, no repo creation).
    const res = await publishHiveRepo({ path: dir, slug: 'whatever' });
    expect(res.mode).toBe('remote');
    expect(res.remote).toBe('https://example.com/owner/repo.git');
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe('remote_already_set');
  });

  // EI-7163: `gh repo create --push` creates the remote repo THEN pushes in one command —
  // when only the push leg fails (the reported git_protocol=ssh vs box ssh-identity
  // mismatch), `gh` still exits non-zero but has already added a local `origin` pointing
  // at a REAL, now-existing GitHub repo. The old code collapsed this into a generic
  // `gh_repo_create_failed` local-only result, indistinguishable from "nothing happened" —
  // the silent degradation this EI reports. These tests exercise the fix via the injected
  // `exec` DI seam (no real `gh`/network — same discipline as the rest of this file).
  describe('recovers from a partial gh repo create --push failure (EI-7163)', () => {
    function fakeExec(handlers: Record<string, (args: string[]) => { stdout: string } | never>) {
      return async (cmd: string, args: string[]) => {
        // `git` calls are always `git -C <path> <subcommand> …` — key on the subcommand
        // (args[2]), not args[0] (which is always the literal `-C`). `gh` calls have the
        // subcommand as args[0] directly.
        const key = cmd === 'git' ? `git ${args[2]}` : `${cmd} ${args[0]}`;
        const h = handlers[key];
        if (!h) throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
        return h(args) as { stdout: string; stderr: string };
      };
    }

    it('retries the push once and succeeds — reports mode:remote, recoveredFromPushFailure:true', async () => {
      let remoteAdded = false;
      let pushed = false;
      const exec = fakeExec({
        'git remote': (args) => {
          if (args[3] === 'get-url') {
            if (!remoteAdded) throw new Error('no such remote');
            return { stdout: 'https://github.com/acme/x-hive.git\n' };
          }
          throw new Error('unexpected git remote subcommand');
        },
        'gh auth': () => ({ stdout: '' }),
        'gh api': (args) => (args[1] === 'user' ? { stdout: 'acme\n' } : { stdout: '42\n' }),
        'gh repo': () => {
          // Simulates gh's real behavior: it adds the remote before attempting the push,
          // then the push leg itself fails.
          remoteAdded = true;
          throw new Error('failed to push some refs (ssh identity mismatch)');
        },
        'git push': () => {
          pushed = true;
          return { stdout: '' };
        },
      });

      const res = await publishHiveRepo({ path: dir, slug: 'x-hive' }, exec as never);
      expect(pushed).toBe(true);
      expect(res.mode).toBe('remote');
      expect(res.pushed).toBe(true);
      expect(res.recoveredFromPushFailure).toBe(true);
      expect(res.remote).toBe('https://github.com/acme/x-hive.git');
    });

    it('both push attempts fail — reports mode:local-only with the orphaned remote surfaced, never silently swallowed', async () => {
      let remoteAdded = false;
      const exec = fakeExec({
        'git remote': (args) => {
          if (args[3] === 'get-url') {
            if (!remoteAdded) throw new Error('no such remote');
            return { stdout: 'https://github.com/acme/x-hive.git\n' };
          }
          throw new Error('unexpected git remote subcommand');
        },
        'gh auth': () => ({ stdout: '' }),
        'gh api': (args) => (args[1] === 'user' ? { stdout: 'acme\n' } : { stdout: '42\n' }),
        'gh repo': () => {
          remoteAdded = true;
          throw new Error('failed to push some refs (ssh identity mismatch)');
        },
        'git push': () => {
          throw new Error('permission denied (publickey)');
        },
      });

      const res = await publishHiveRepo({ path: dir, slug: 'x-hive' }, exec as never);
      expect(res.mode).toBe('local-only');
      expect(res.pushed).toBe(false);
      // The orphaned remote must be surfaced, not dropped — this is the "silent
      // degradation" the EI reports: a real remote repo now exists and MUST be visible.
      expect(res.remote).toBe('https://github.com/acme/x-hive.git');
      expect(res.reason).toMatch(/^push_failed_after_remote_create:/);
    });

    it('gh repo create fails before any remote is added — the ordinary (non-orphaning) failure path, unchanged', async () => {
      const exec = fakeExec({
        'git remote': () => {
          throw new Error('no such remote');
        },
        'gh auth': () => ({ stdout: '' }),
        'gh api': (args) => (args[1] === 'user' ? { stdout: 'acme\n' } : { stdout: '42\n' }),
        'gh repo': () => {
          throw new Error('name already exists on this account');
        },
      });

      const res = await publishHiveRepo({ path: dir, slug: 'x-hive' }, exec as never);
      expect(res.mode).toBe('local-only');
      expect(res.remote).toBeUndefined();
      expect(res.reason).toMatch(/^gh_repo_create_failed:/);
    });
  });
});
