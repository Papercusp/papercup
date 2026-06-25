/**
 * Detect whether the user has signed in to the supported coding-agent
 * providers. Used by the Setup Wizard's `logins` step status.
 *
 * Cheap file-existence probes for agent CLIs. GitHub is stricter: the dogfood
 * hive clone depends on a valid `gh` token AND `gh auth setup-git`, so a stale
 * hosts.yml must not count as signed in.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function anyExists(paths: readonly string[]): boolean {
  return paths.some((p) => existsSync(p));
}

export function claudeSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude', 'credentials.json'),
    join(home, '.config', 'claude', 'credentials.json'),
  ]);
}

export function ompSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.omp', 'agent', 'auth.json'),
    join(home, '.pi_back', 'agent', 'auth.json'),
  ]);
}

export function codexSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.codex', 'auth.json'),
  ]);
}

/**
 * GitHub CLI auth status for the dogfood clone path. A hosts.yml alone is not
 * enough: revoked tokens remain on disk, and without `gh auth setup-git` git
 * cannot authenticate private HTTPS submodules with GIT_TERMINAL_PROMPT=0.
 */
export function githubSignedIn(): boolean {
  const home = homedir();
  if (!anyExists([
    join(home, '.config', 'gh', 'hosts.yml'),
    // Windows: gh stores config under %AppData%\GitHub CLI\hosts.yml.
    `${process.env.APPDATA ?? ''}/GitHub CLI/hosts.yml`,
  ])) return false;

  const gh = resolveGhBinary();
  if (!gh) return true; // legacy fallback for hosts where gh is not probeable.
  const auth = spawnSync(gh, ['auth', 'status', '--hostname', 'github.com'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (auth.status !== 0) return false;

  const helper = spawnSync('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return helper.status === 0 && /gh\s+auth\s+git-credential/.test(helper.stdout);
}

export function anyAgentSignedIn(): boolean {
  return claudeSignedIn() || codexSignedIn() || ompSignedIn();
}

function resolveGhBinary(): string | null {
  const candidates = [
    join(dirname(process.execPath), 'gh'),
    join(process.cwd(), 'bin', 'gh'),
    join(process.cwd(), '..', 'bin', 'gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  const which = spawnSync('which', ['gh'], { encoding: 'utf8', timeout: 3000 });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}
