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

async function loadMod() {
  return import('./role-codex-home');
}

/** Drop stub CC lock-hook scripts under the fake home so writeCodexLockHooks
 *  has something to point at (it no-ops when they're absent). */
async function installFakeHooks() {
  const { mkdirSync } = await import('node:fs');
  const dir = join(fakeHome, '.papercusp', 'hooks', 'cc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pretooluse-locks-acquire.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-locks-release.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-coord-inbox.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-activity-report.sh'), '#!/bin/sh\n');
  return dir;
}

describe('writeRoleCodexHome', () => {
  it('writes AGENTS.md (role prompt) + config.toml (role-scoped url) under the SHARED codex-homes root', async () => {
    const writeRoleCodexHome = await load();
    const url = 'http://127.0.0.1:3070/api/mcp?harness=h&workspace=w&role=worker&run=r&spawn=s&exp=1&sig=abc';
    const out = writeRoleCodexHome({ sessionKey: 42, mcpUrl: url, promptText: 'WORKER ROLE PROMPT BODY' });

    // unify-launch-mechanics P-004: role AND su codex homes now share ONE root
    // (`codexHomeForSessionKey` → su-codex-homes), the SAME root the wake-executor
    // resume leg reads (`codexHomeForAdvSession`). Previously the role path wrote to
    // a separate `role-codex-homes/` the resume leg never looked in, so a woken
    // codex role session resumed from nothing (a launch↔resume key drift).
    expect(out.codexHome).toBe(join(fakeHome, '.papercusp', 'su-codex-homes', 'session-42'));
    expect(out.agentsPath).toBe(join(out.codexHome, 'AGENTS.md'));
    expect(out.configPath).toBe(join(out.codexHome, 'config.toml'));

    expect(readFileSync(out.agentsPath, 'utf8')).toBe('WORKER ROLE PROMPT BODY');
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.papercusp]');
    expect(toml).toContain(`url = "${url}"`);
    // role-scoped, sig-auth — no bearer token (unlike the codex-su home).
    expect(toml).not.toContain('bearer_token_env_var');
    // psu-isolation P-004 / D-001: no cwd AGENTS.md read + native memory off.
    expect(toml).toContain('project_doc_max_bytes = 0');
    expect(toml).toContain('memory_tool = false');
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

  it('P-030/D-010: installs the SU-locks hooks.json (codex discovery file) when hooks are present', async () => {
    await installFakeHooks();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 7, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P' });
    // D-010: codex reads hooks.json (NOT settings.json, which it ignores).
    expect(existsSync(join(out.codexHome, 'settings.json'))).toBe(false);
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('apply_patch|Edit|Write');
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('pretooluse-locks-acquire.sh');
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('PAPERCUSP_WORKSPACE_ROOT=');
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain('posttooluse-locks-release.sh');
    // Role sessions get NO coord push hook — they coordinate via
    // messages:feature_*, not the SU coord bus. And with NO sid given, no
    // activity hook either (it needs an identity to report under).
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-coord-inbox.sh');
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-activity-report.sh');
  });

  it('a role session WITH a sid gets the activity-bridge hook (worker activity → fleet view), still no coord', async () => {
    await installFakeHooks();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 71, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P', sid: 'role-abc-9' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    // Two PostToolUse entries: lock-release + activity (NO coord — roles don't ride the SU bus).
    expect(hooks.hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-coord-inbox.sh');
    const activity = hooks.hooks.PostToolUse.find(
      (e: { hooks: { command: string }[] }) => e.hooks[0].command.includes('posttooluse-activity-report.sh'),
    );
    expect(activity).toBeTruthy();
    expect(activity.matcher).toBe('.*');
    // SID + agent baked (codex hands hooks a minimal env, can't env-expand).
    expect(activity.hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");
    expect(activity.hooks[0].command).toContain('PAPERCUSP_AGENT=codex');
  });

  it('writeCodexLockHooks no-ops (no hooks.json) when the hook scripts are absent', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 8, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P' });
    expect(existsSync(join(out.codexHome, 'hooks.json'))).toBe(false);
  });
});

describe('writeSuCodexHome', () => {
  it('writes the engineer playbook + a superuser MCP (baked http_headers bearer, per-session client)', async () => {
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 5,
      mcpUrl: 'http://127.0.0.1:3070/api/mcp?superuser=1&workspace=default',
      promptText: 'ENGINEER PLAYBOOK BODY',
      sid: 'su-abc-123',
      token: 'TESTBEARER123456',
    });
    expect(out.codexHome).toBe(join(fakeHome, '.papercusp', 'su-codex-homes', 'session-5'));
    expect(readFileSync(out.agentsPath, 'utf8')).toBe('ENGINEER PLAYBOOK BODY');
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.papercusp-su]');
    // D-006: bearer baked as http_headers (codex 0.135 ignores bearer_token_env_var for HTTP).
    expect(toml).toContain('http_headers = { Authorization = "Bearer TESTBEARER123456" }');
    expect(toml).not.toContain('bearer_token_env_var');
    // per-session client baked into the url (codex can't env-expand config.toml).
    expect(toml).toContain('client=su-abc-123');
    expect(toml).toContain('superuser=1');
    // psu-isolation P-004 / D-001: no cwd AGENTS.md read + native memory off.
    expect(toml).toContain('project_doc_max_bytes = 0');
    expect(toml).toContain('[features]');
    expect(toml).toContain('memory_tool = false');
  });

  it('no token → degraded config (url only, no http_headers / superuser bearer)', async () => {
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 11, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).not.toContain('http_headers');
    expect(toml).not.toContain('Authorization');
  });

  it('symlinks auth.json (shared OAuth) + rebuilds fresh', async () => {
    const realAuthDir = join(fakeHome, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(realAuthDir, { recursive: true });
    writeFileSync(join(realAuthDir, 'auth.json'), '{"token":"real"}');

    const { writeSuCodexHome } = await loadMod();
    const first = writeSuCodexHome({ sessionKey: 'k', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'OLD', sid: 's1' });
    writeFileSync(join(first.codexHome, 'STALE.txt'), 'stale');
    const second = writeSuCodexHome({ sessionKey: 'k', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'NEW', sid: 's2' });

    expect(lstatSync(join(second.codexHome, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(second.agentsPath, 'utf8')).toBe('NEW');
    expect(existsSync(join(second.codexHome, 'STALE.txt'))).toBe(false);
    expect(readFileSync(second.configPath, 'utf8')).toContain('client=s2');
  });

  it('installs the SU-locks hooks.json when hooks are present', async () => {
    await installFakeHooks();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 6, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    expect(existsSync(join(out.codexHome, 'hooks.json'))).toBe(true);
    expect(existsSync(join(out.codexHome, 'settings.json'))).toBe(false);
  });

  it('adds the coord-inbox PUSH + activity hooks (PostToolUse, matcher .*, baked PAPERCUSP_SID = the session id)', async () => {
    await installFakeHooks();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 12, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 'su-abc-123' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    // Three PostToolUse entries: lock-release + coord push + activity report.
    expect(hooks.hooks.PostToolUse).toHaveLength(3);
    const coord = hooks.hooks.PostToolUse.find(
      (e: { hooks: { command: string }[] }) => e.hooks[0].command.includes('posttooluse-coord-inbox.sh'),
    );
    expect(coord).toBeTruthy();
    expect(coord.matcher).toBe('.*');
    // SID baked (codex doesn't env-expand) so the hook's coord identity == &client=.
    expect(coord.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
    expect(coord.hooks[0].command).toContain('PAPERCUSP_WORKSPACE_ROOT=');

    // The activity-bridge hook — an SU/engineer session is a worker too.
    const activity = hooks.hooks.PostToolUse.find(
      (e: { hooks: { command: string }[] }) => e.hooks[0].command.includes('posttooluse-activity-report.sh'),
    );
    expect(activity).toBeTruthy();
    expect(activity.matcher).toBe('.*');
    expect(activity.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
    expect(activity.hooks[0].command).toContain('PAPERCUSP_AGENT=codex');
  });

  it('no coord/activity hooks when only the lock scripts are installed', async () => {
    const { mkdirSync } = await import('node:fs');
    const dir = join(fakeHome, '.papercusp', 'hooks', 'cc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pretooluse-locks-acquire.sh'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'posttooluse-locks-release.sh'), '#!/bin/sh\n');
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 13, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PostToolUse).toHaveLength(1); // lock-release only
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-coord-inbox.sh');
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-activity-report.sh');
  });
});
