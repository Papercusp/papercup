/**
 * Coverage for agent-auth-detect: the Setup Wizard's file-existence probes for
 * Claude / OMP / GitHub-CLI sign-in. existsSync + homedir are mocked so the
 * tests assert the path-matching logic, not the host's real credential files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSync = vi.fn();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsSync(p) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => '/home/u' };
});

import { claudeSignedIn, ompSignedIn, githubSignedIn, anyAgentSignedIn } from './agent-auth-detect';

/** Mark exactly the given absolute paths as existing. */
function onlyExist(...present: string[]) {
  const set = new Set(present);
  existsSync.mockImplementation((p: string) => set.has(p));
}

beforeEach(() => existsSync.mockReset());
afterEach(() => vi.clearAllMocks());

describe('claudeSignedIn', () => {
  it('true when any documented Claude credential path exists', () => {
    onlyExist('/home/u/.claude/.credentials.json');
    expect(claudeSignedIn()).toBe(true);
    onlyExist('/home/u/.config/claude/credentials.json');
    expect(claudeSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(claudeSignedIn()).toBe(false);
  });
});

describe('ompSignedIn', () => {
  it('true for either the .omp or legacy .pi_back auth path', () => {
    onlyExist('/home/u/.omp/agent/auth.json');
    expect(ompSignedIn()).toBe(true);
    onlyExist('/home/u/.pi_back/agent/auth.json');
    expect(ompSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(ompSignedIn()).toBe(false);
  });
});

describe('githubSignedIn', () => {
  it('true when the gh hosts.yml exists', () => {
    onlyExist('/home/u/.config/gh/hosts.yml');
    expect(githubSignedIn()).toBe(true);
  });
  it('false otherwise', () => {
    onlyExist();
    expect(githubSignedIn()).toBe(false);
  });
});

describe('anyAgentSignedIn', () => {
  it('true if Claude OR OMP is signed in (not gated on GitHub)', () => {
    onlyExist('/home/u/.omp/agent/auth.json');
    expect(anyAgentSignedIn()).toBe(true);
  });
  it('false when neither agent is signed in (even if GitHub is)', () => {
    onlyExist('/home/u/.config/gh/hosts.yml');
    expect(anyAgentSignedIn()).toBe(false);
  });
});
