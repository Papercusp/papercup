/**
 * Detect whether the user has signed in to the supported coding-agent
 * providers. Used by the Setup Wizard's `logins` step status.
 *
 * Cheap file-existence probes only — we don't shell out per check
 * because the wizard polls. Paths reflect each tool's documented
 * credential locations as of 2026-05. If an upstream change moves
 * them, add the new path here; the function returns true on the first
 * match.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * GitHub CLI auth status — `gh auth login` writes ~/.config/gh/hosts.yml
 * with the active user + token. Existence of that file is the same
 * signal `gh auth status` uses internally.
 */
export function githubSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.config', 'gh', 'hosts.yml'),
    // Windows: gh stores config under %AppData%\GitHub CLI\hosts.yml.
    `${process.env.APPDATA ?? ''}/GitHub CLI/hosts.yml`,
  ]);
}

export function anyAgentSignedIn(): boolean {
  return claudeSignedIn() || ompSignedIn();
}
