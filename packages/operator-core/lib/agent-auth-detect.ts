/**
 * Detect whether the user has signed in to the supported coding-agent
 * providers. Used by the Setup Wizard's `logins` step status.
 *
 * Cheap file-existence probes for agent CLIs. GitHub is stricter: the dogfood
 * hive clone depends on a valid `gh` token AND `gh auth setup-git`, so a stale
 * hosts.yml must not count as signed in.
 */
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * OMP (pi) auth DETAIL — beyond mere file existence. A present `auth.json` with
 * an EXPIRED OAuth access token reads as "signed in" to `ompSignedIn()` but pi
 * may fail real Anthropic calls with "No API key found" (observed: a stale token
 * silently degrades an interactive psu→omp session to local ollama). So a
 * diagnostics surface needs the expiry, not just presence, to prompt a re-login.
 *
 * `accessExpired` is a HINT, not a hard "signed out": pi MAY refresh an expired
 * access token from `token.refresh`. Surface it as "re-login if Anthropic calls
 * fail", and keep `ompSignedIn()` a cheap presence probe (unchanged semantics).
 */
export interface OmpAuthStatus {
  /** `auth.json` exists. */
  present: boolean;
  /** First configured provider key (e.g. `anthropic`), or null. */
  provider: string | null;
  /** The provider's auth type (e.g. `oauth`), or null. */
  authType: string | null;
  /** OAuth access-token expiry (epoch ms), or null when not an expiring token. */
  expiresAt: number | null;
  /** `expiresAt` is in the past — pi may still refresh from `hasRefresh`. */
  accessExpired: boolean;
  /** A refresh token is present (pi can attempt a silent refresh). */
  hasRefresh: boolean;
}

export function ompAuthStatus(home: string = homedir(), now: number = Date.now()): OmpAuthStatus {
  const empty: OmpAuthStatus = {
    present: false, provider: null, authType: null, expiresAt: null, accessExpired: false, hasRefresh: false,
  };
  const path = [
    join(home, '.omp', 'agent', 'auth.json'),
    join(home, '.pi_back', 'agent', 'auth.json'),
  ].find((p) => existsSync(p));
  if (!path) return empty;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const provider = Object.keys(data)[0] ?? null;
    const entry = (provider ? data[provider] : null) as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return { ...empty, present: true };
    const authType = typeof entry.type === 'string' ? entry.type : null;
    const tok = (entry.token && typeof entry.token === 'object' ? entry.token : null) as Record<string, unknown> | null;
    const expiresAt = tok && typeof tok.expires === 'number' ? tok.expires : null;
    const hasRefresh = Boolean(tok && typeof tok.refresh === 'string' && tok.refresh);
    return {
      present: true,
      provider,
      authType,
      expiresAt,
      accessExpired: expiresAt != null && expiresAt < now,
      hasRefresh,
    };
  } catch {
    return { ...empty, present: true };
  }
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
    process.argv[1] ? join(dirname(process.argv[1]), 'bin', 'gh') : '',
    join(dirname(process.execPath), 'gh'),
    join(process.cwd(), 'bin', 'gh'),
    join(process.cwd(), '..', 'bin', 'gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ];
  for (const p of candidates) if (p && existsSync(p)) return p;
  const which = spawnSync('which', ['gh'], { encoding: 'utf8', timeout: 3000 });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}
