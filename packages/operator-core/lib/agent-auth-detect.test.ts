/**
 * Coverage for agent-auth-detect: the Setup Wizard's file-existence probes for
 * Claude / OMP / GitHub-CLI sign-in. existsSync + homedir are mocked so the
 * tests assert the path-matching logic, not the host's real credential files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

const existsSync = vi.fn();
const spawnSync = vi.fn();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsSync(p) };
});
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: unknown[]) => spawnSync(...args) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => '/home/u' };
});

import { claudeSignedIn, codexSignedIn, ompSignedIn, githubSignedIn, anyAgentSignedIn } from './agent-auth-detect';

/** Mark exactly the given absolute paths as existing. */
function onlyExist(...present: string[]) {
  const set = new Set(present);
  existsSync.mockImplementation((p: string) => set.has(p));
}

beforeEach(() => {
  existsSync.mockReset();
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
});
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

describe('codexSignedIn', () => {
  it('true when the Codex auth file exists', () => {
    onlyExist('/home/u/.codex/auth.json');
    expect(codexSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(codexSignedIn()).toBe(false);
  });
});

describe('githubSignedIn', () => {
  it('uses the gh binary bundled next to the packaged sidecar node executable', () => {
    const bundledGh = join(dirname(process.execPath), 'gh');
    onlyExist('/home/u/.config/gh/hosts.yml', bundledGh);
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === bundledGh && args[0] === 'auth' && args[1] === 'status') {
        return { status: 1, stdout: '', stderr: 'token is invalid' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });

  it('true when gh auth is valid and setup-git wired the credential helper', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 0, stdout: 'Logged in', stderr: '' };
      }
      if (cmd === 'git' && args.includes('credential.https://github.com.helper')) {
        return { status: 0, stdout: '!/usr/local/bin/gh auth git-credential\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(true);
  });
  it('false when hosts.yml exists but gh reports an invalid token', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 1, stdout: '', stderr: 'token is invalid' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });
  it('false when gh is valid but setup-git has not wired git credentials', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 0, stdout: 'Logged in', stderr: '' };
      }
      if (cmd === 'git' && args.includes('credential.https://github.com.helper')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });
  it('false otherwise', () => {
    onlyExist();
    expect(githubSignedIn()).toBe(false);
  });
});

describe('anyAgentSignedIn', () => {
  it('true if Claude, Codex, or OMP is signed in (not gated on GitHub)', () => {
    onlyExist('/home/u/.omp/agent/auth.json');
    expect(anyAgentSignedIn()).toBe(true);
    onlyExist('/home/u/.codex/auth.json');
    expect(anyAgentSignedIn()).toBe(true);
  });
  it('false when neither agent is signed in (even if GitHub is)', () => {
    onlyExist('/home/u/.config/gh/hosts.yml');
    expect(anyAgentSignedIn()).toBe(false);
  });
});
