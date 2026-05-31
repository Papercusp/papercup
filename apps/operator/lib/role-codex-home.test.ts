/**
 * Unit tests for writeRoleCodexHome — the per-session CODEX_HOME builder
 * for interactive codex role sessions (agent-launch-unification).
 *
 * Asserts the on-disk layout codex needs: AGENTS.md = role prompt,
 * config.toml = [mcp_servers.papercusp] url = "<signed>", auth.json
 * symlinked to the real ~/.codex/auth.json (never copied).
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// os.homedir() reads the OS password DB on Linux, NOT $HOME — so we mock it
// to a throwaway dir. (A holder var, set per-test, keeps the hoisted mock in
// sync.) tmpdir stays real.
const homeHolder = { home: '' };
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, homedir: () => homeHolder.home };
});

let fakeHome = '';

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'role-codex-home-test-'));
  homeHolder.home = fakeHome;
  vi.resetModules();
});

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

async function load() {
  return (await import('./role-codex-home')).writeRoleCodexHome;
}

describe('writeRoleCodexHome', () => {
  it('writes AGENTS.md (role prompt) + config.toml (role-scoped url) under ~/.papercusp', async () => {
    const writeRoleCodexHome = await load();
    const url = 'http://127.0.0.1:3070/api/mcp?harness=h&workspace=w&role=worker&run=r&spawn=s&exp=1&sig=abc';
    const out = writeRoleCodexHome({ sessionKey: 42, mcpUrl: url, promptText: 'WORKER ROLE PROMPT BODY' });

    expect(out.codexHome).toBe(join(fakeHome, '.papercusp', 'role-codex-homes', 'session-42'));
    expect(out.agentsPath).toBe(join(out.codexHome, 'AGENTS.md'));
    expect(out.configPath).toBe(join(out.codexHome, 'config.toml'));

    expect(readFileSync(out.agentsPath, 'utf8')).toBe('WORKER ROLE PROMPT BODY');
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.papercusp]');
    expect(toml).toContain(`url = "${url}"`);
    // role-scoped, sig-auth — no bearer token (unlike the codex-su home).
    expect(toml).not.toContain('bearer_token_env_var');
  });

  it('symlinks auth.json to the real ~/.codex/auth.json (shared OAuth, not a copy)', async () => {
    const realAuthDir = join(fakeHome, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(realAuthDir, { recursive: true });
    writeFileSync(join(realAuthDir, 'auth.json'), '{"token":"real"}');

    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 'abc', mcpUrl: 'http://x/api/mcp?role=scoper&sig=z', promptText: 'P' });

    const authLink = join(out.codexHome, 'auth.json');
    expect(existsSync(authLink)).toBe(true);
    expect(lstatSync(authLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(authLink)).toBe(join(realAuthDir, 'auth.json'));
  });

  it('rebuilds fresh — a stale prompt from a prior launch does not leak', async () => {
    const writeRoleCodexHome = await load();
    const first = writeRoleCodexHome({ sessionKey: 9, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'OLD PROMPT' });
    // Drop a stray file in the home to prove the rebuild wipes it.
    writeFileSync(join(first.codexHome, 'STALE.txt'), 'stale');
    const second = writeRoleCodexHome({ sessionKey: 9, mcpUrl: 'http://x/?role=worker&sig=2', promptText: 'NEW PROMPT' });

    expect(second.codexHome).toBe(first.codexHome);
    expect(readFileSync(second.agentsPath, 'utf8')).toBe('NEW PROMPT');
    expect(existsSync(join(second.codexHome, 'STALE.txt'))).toBe(false);
    expect(readFileSync(second.configPath, 'utf8')).toContain('sig=2');
  });

  it('escapes a backslash/quote in the url so config.toml stays valid', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 1, mcpUrl: 'http://x/?a="b"\\c', promptText: 'P' });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('url = "http://x/?a=\\"b\\"\\\\c"');
  });
});
