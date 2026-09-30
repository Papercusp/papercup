/**
 * Unit tests for writeRoleCodexHome — the per-session CODEX_HOME builder
 * for interactive codex role sessions (agent-launch-unification).
 *
 * Asserts the on-disk layout codex needs: AGENTS.md = role prompt,
 * config.toml = [mcp_servers.papercusp] url = "<signed>", auth.json
 * symlinked to the real ~/.codex/auth.json (never copied).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
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
const RESOLVED_CODEX_DEFAULT = 'gpt-5.6-sol:xhigh';

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'role-codex-home-test-'));
  homeHolder.home = fakeHome;
  vi.resetModules();
});

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

function withResolvedDefault<T extends (opts: any) => any>(fn: T): T {
  return ((opts: Parameters<T>[0]) =>
    fn({ model: RESOLVED_CODEX_DEFAULT, ...opts })) as T;
}

async function load() {
  return withResolvedDefault(
    (await import('./role-codex-home')).writeRoleCodexHome,
  );
}

async function loadMod() {
  const mod = await import('./role-codex-home');
  return {
    ...mod,
    writeRoleCodexHome: withResolvedDefault(mod.writeRoleCodexHome),
    writeSuCodexHome: withResolvedDefault(mod.writeSuCodexHome),
    ensureSuCodexHomeConfig: withResolvedDefault(mod.ensureSuCodexHomeConfig),
  };
}

/** Install the exact stale cache shape that caused D-007 to rewrite the
 * documented 1M/900k opt-in as 872k/784.8k on real hosts. */
function installStaleExtendedWindowRecord(model: string) {
  const dir = join(fakeHome, '.codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: model,
          context_window: 272_000,
          max_context_window: 872_000,
          effective_context_window_percent: 95,
        },
      ],
    }),
  );
}

/** Drop stub CC lock-hook scripts under the fake home so writeCodexLockHooks
 *  has something to point at (it no-ops when they're absent). */
async function installFakeHooks() {
  const { mkdirSync } = await import('node:fs');
  const dir = join(fakeHome, '.papercusp', 'hooks', 'cc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pretooluse-locks-acquire.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-locks-release.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-activity-report.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'lifecycle-report.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'precompact-managed-carry.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'posttooluse-objective-title.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'posttooluse-write-byte-integrity-guard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'pretooluse-control-bytes-content-guard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'pretooluse-generated-file-edit-guard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'pretooluse-bash-resource-gate.sh'), '#!/bin/sh\n');
  return dir;
}

function installOwnerRuntimeProof(owner: string) {
  const dir = join(fakeHome, '.papercusp', 'locks-cache');
  const safe = owner.replace(/[^A-Za-z0-9._-]/g, '_');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `owner-${safe}-last-decision.json`),
    JSON.stringify({ ts: new Date().toISOString(), owner, decision: 'granted' }),
  );
  writeFileSync(join(dir, `owner-${safe}-last-success.json`), JSON.stringify({ ts: new Date().toISOString(), owner }));
}

describe('writeRoleCodexHome', () => {
  it('prepends the exact 1M/900k root keys for an extended-window role model', async () => {
    installStaleExtendedWindowRecord('gpt-5.6-sol');
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'context-role',
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      model: 'sol:high',
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toMatch(/^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/);
    expect(toml.indexOf('model_context_window')).toBeLessThan(toml.indexOf('[features]'));
  });

  it('keeps a sub-1M role config byte-free of context overrides', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'context-role-small',
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      model: 'gpt-5.5',
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).not.toContain('model_context_window');
    expect(toml).not.toContain('model_auto_compact_token_limit');
  });

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

    const agents = readFileSync(out.agentsPath, 'utf8');
    expect(agents).toContain('WORKER ROLE PROMPT BODY');
    expect(agents).toContain('## Codex Lock Enforcement Status');
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.papercusp]');
    expect(toml).toContain(`url = "${url}"`);
    const logDir = join(out.codexHome, 'log');
    expect(toml).toContain(`log_dir = "${logDir}"`);
    expect(toml.indexOf(`log_dir = "${logDir}"`)).toBeLessThan(toml.indexOf('[features]'));
    expect(existsSync(logDir)).toBe(true);
    // role-scoped, sig-auth — no bearer token (unlike the codex-su home).
    expect(toml).not.toContain('bearer_token_env_var');
    // psu-isolation P-004 / D-001: no cwd AGENTS.md read + native memory off.
    // codex 0.142 renamed the memory_tool flag to `memories` (legacy alias warns).
    expect(toml).toContain('project_doc_max_bytes = 0');
    expect(toml).toContain('memories = false');
    expect(toml).toContain('remote_compaction_v2 = false');
    expect(toml).not.toContain('memory_tool');
    // tui-status-parity 2026-07-05: hook owns the title (see the su-home test).
    expect(toml).toContain('[tui]\nterminal_title = []');
    expect(toml).toContain('[tui]\nterminal_title = []\nalternate_screen = "never"\n');
    // tui-status-parity D 2026-07-06: codex also gets a native bottom status pane
    // (codex-own items; canonical rust-v0.142.5 StatusLineItem IDs).
    expect(toml).toContain('status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]');
  });

  it('seeds launch-dir trust ([projects."<trustDir>"] trust_level) so a fresh role CODEX_HOME never blocks at the boot trust prompt', async () => {
    const writeRoleCodexHome = await load();
    const dir = '/home/dev/papercupai-workspace/papercusp';
    const out = writeRoleCodexHome({
      sessionKey: 'role-trust',
      mcpUrl: 'http://x/api/mcp?role=worker&sig=z',
      promptText: 'P',
      trustDir: dir,
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain(`[projects."${dir}"]`);
    expect(toml).toContain('trust_level = "trusted"');
  });

  // WI-3645: the gateway provider block comes from the SHARED builder
  // (@papercusp/orchestrator/codex-gateway-config) — the same one spawn-mcp.ts renders. These
  // three cases pin the routing contract on the INTERACTIVE path, which previously had NO
  // gateway assertions at all (which is exactly how its local copy drifted pin-required while
  // the spawned copy learned auto).
  it('codexGatewayAccountId → gateway provider block WITH the x-papercusp-account pin header', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'gw-pin',
      mcpUrl: 'http://x/api/mcp?role=worker&sig=z',
      promptText: 'P',
      sid: 'role-worker',
      codexGatewayAccountId: 'chatgpt-sub-cli',
      codexGatewayPriority: 'worker',
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).toContain('"x-papercusp-account" = "chatgpt-sub-cli"');
    expect(toml).toContain('"x-papercusp-owner" = "role-worker"');
    expect(toml).toContain('"x-papercusp-priority" = "worker"');
  });

  it('codexGatewayAuto (no pin) → the SAME provider block with the account header OMITTED — unpinned auto-routing, never an empty header', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'gw-auto',
      mcpUrl: 'http://x/api/mcp?role=worker&sig=z',
      promptText: 'P',
      sid: 'role-worker',
      codexGatewayAuto: true,
      codexGatewayPriority: 'worker',
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('model_provider = "papercusp-codex-gateway"');
    expect(toml).toContain('[model_providers.papercusp-codex-gateway]');
    expect(toml).not.toContain('x-papercusp-account');
    expect(toml).toContain('"x-papercusp-owner" = "role-worker"');
    expect(toml).toContain('"x-papercusp-priority" = "worker"');
  });

  it('neither pin nor auto → NO gateway config at all (direct egress unchanged)', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'gw-off',
      mcpUrl: 'http://x/api/mcp?role=worker&sig=z',
      promptText: 'P',
      sid: 'role-worker',
      codexGatewayPriority: 'worker',
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).not.toContain('papercusp-codex-gateway');
    expect(toml).not.toContain('x-papercusp-owner');
    expect(toml).not.toContain('x-papercusp-priority');
  });

  it('symlinks auth.json to the real ~/.codex/auth.json (shared OAuth, not a copy)', async () => {
    const realAuthDir = join(fakeHome, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(realAuthDir, { recursive: true });
    writeFileSync(join(realAuthDir, 'auth.json'), '{"token":"real"}');

    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 'abc',
      mcpUrl: 'http://x/api/mcp?role=scoper&sig=z',
      promptText: 'P',
    });

    const authLink = join(out.codexHome, 'auth.json');
    expect(existsSync(authLink)).toBe(true);
    expect(lstatSync(authLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(authLink)).toBe(join(realAuthDir, 'auth.json'));
  });

  it('rebuilds fresh — a stale prompt from a prior launch does not leak', async () => {
    const writeRoleCodexHome = await load();
    const first = writeRoleCodexHome({
      sessionKey: 9,
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'OLD PROMPT',
    });
    // Drop a stray file in the home to prove the rebuild wipes it.
    writeFileSync(join(first.codexHome, 'STALE.txt'), 'stale');
    const second = writeRoleCodexHome({
      sessionKey: 9,
      mcpUrl: 'http://x/?role=worker&sig=2',
      promptText: 'NEW PROMPT',
    });

    expect(second.codexHome).toBe(first.codexHome);
    expect(readFileSync(second.agentsPath, 'utf8')).toContain('NEW PROMPT');
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
    const controlBytes = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-control-bytes-content-guard.mjs'),
    );
    expect(controlBytes).toBeTruthy();
    expect(controlBytes.matcher).toBe(
      '^(?:apply_patch|Edit|Write|MultiEdit|mcp__.*__capability_(?:edit|write|multi_?edit))$',
    );
    const generatedFiles = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-generated-file-edit-guard.mjs'),
    );
    expect(generatedFiles).toBeTruthy();
    expect(generatedFiles.matcher).toBe(
      '^(?:apply_patch|Edit|Write|MultiEdit|mcp__.*__capability_(?:edit|write|multi_?edit))$',
    );
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain('posttooluse-locks-release.sh');
    expect(hooks.hooks.PostToolUse[0].matcher).toBe(
      '^(?:apply_patch|Edit|Write|exec|functions\\.exec|functions__exec)$',
    );
    const byteGuard = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-write-byte-integrity-guard.mjs'),
    );
    expect(byteGuard).toBeTruthy();
    expect(byteGuard.matcher).toBe('^(?:Write|mcp__.*__capability_write)$');
    // With NO sid given, no activity (+ merged coord-fold) hook — it needs an
    // identity to report/fold under.
    expect(hooks.hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-activity-report.sh');
    // No sid → no objective-title hook either (it keys the glance read off the sid).
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-objective-title.sh');
  });

  it('a role session WITH a sid gets the activity-bridge hook (worker activity → fleet view) with the coord fold OFF', async () => {
    await installFakeHooks();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 71,
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      sid: 'role-abc-9',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    // Four PostToolUse entries: lock-release + byte-integrity + activity + objective-title. No
    // separate coord entry any more (EI-11405 merged it into the activity hook).
    expect(hooks.hooks.PostToolUse).toHaveLength(4);
    const activity = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-activity-report.sh'),
    );
    expect(activity).toBeTruthy();
    expect(activity.matcher).toBe('.*');
    // SID + agent baked (codex hands hooks a minimal env, can't env-expand).
    expect(activity.hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");
    expect(activity.hooks[0].command).toContain('PAPERCUSP_AGENT=codex');
    // No coordSid ⇒ the merged hook's coord fold is explicitly OFF (roles don't
    // ride the SU coord bus; this also preserves the original zero-added-latency
    // detached report path for role sessions).
    expect(activity.hooks[0].command).toContain('PAPERCUSP_COORD_FOLD=0');
    const preLock = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-locks-acquire.sh'),
    );
    const postLock = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-locks-release.sh'),
    );
    expect(preLock.matcher).toBe('apply_patch|Edit|Write');
    expect(postLock.matcher).toBe('^(?:apply_patch|Edit|Write|exec|functions\\.exec|functions__exec)$');
    expect(preLock.hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");
    expect(preLock.hooks[0].command).toContain("PAPERCUSP_LOCK_SID='role-abc-9'");
    expect(postLock.hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");
    expect(postLock.hooks[0].command).toContain("PAPERCUSP_LOCK_SID='role-abc-9'");
    const byteGuard = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-write-byte-integrity-guard.mjs'),
    );
    expect(byteGuard).toBeTruthy();
    expect(byteGuard.matcher).toBe('^(?:Write|mcp__.*__capability_write)$');
    // Objective-title hook (session-objective-display-2026-06-22): terminal title
    // ← coord:glance self.objective, matcher .*, baked SID = the session id.
    const objective = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-objective-title.sh'),
    );
    expect(objective).toBeTruthy();
    expect(objective.matcher).toBe('.*');
    expect(objective.hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");

    // WI-41305: a Codex session end must enter the same lifecycle bridge as
    // Claude. SessionEnd is synchronous because it consumes the bridge's
    // terminal-vs-continuation verdict before reusing fleet:kill.
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionEnd).toHaveLength(1);
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain('lifecycle-report.sh');
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("PAPERCUSP_SID='role-abc-9'");
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("PAPERCUSP_ADV_SESSION_ID='71'");
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toContain('PAPERCUSP_ACTIVITY_SYNC=1');
    expect(hooks.hooks.PreCompact).toHaveLength(1);
    expect(hooks.hooks.PreCompact[0].matcher).toBe('^auto$');
    expect(hooks.hooks.PreCompact[0].hooks[0].timeout).toBe(600);
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain(
      'precompact-managed-carry.mjs',
    );
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain(
      "PAPERCUSP_SID='role-abc-9'",
    );
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain(
      "PAPERCUSP_MCP_URL='http://x/?role=worker&sig=1'",
    );
    expect(hooks.hooks.PreCompact[0].hooks[0].command).not.toContain(
      'PAPERCUSP_MCP_AUTH=superuser-token',
    );
  });

  it('writeCodexLockHooks no-ops (no hooks.json) when the hook scripts are absent', async () => {
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 8, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P' });
    expect(existsSync(join(out.codexHome, 'hooks.json'))).toBe(false);
    const diag = JSON.parse(readFileSync(join(out.codexHome, 'papercusp-diagnostics.json'), 'utf8'));
    expect(diag.lockEnforcement).toBe('hooks-missing');
    expect(diag.requiresExplicitPapercuspLocks).toBe(true);
  });

  it('a ROLE home gets the native-scheduler guard (bash gate + baked agent marker) — native-scheduler-lockout P-010', async () => {
    await installFakeHooks();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 9, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    const gate = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-bash-resource-gate.sh'),
    );
    expect(gate).toBeTruthy();
    expect(gate.matcher).toContain('exec_command');
    // Marker BAKED (codex hands hooks a minimal env): the gate's scheduler
    // deny only fires for agent sessions.
    expect(gate.hooks[0].command).toContain('PAPERCUSP_AGENT_SESSION=1');
  });
});

describe('writeSuCodexHome', () => {
  it('rejects an omitted model at fresh/repair boundaries and honors an explicitly resolved Sol xhigh default', async () => {
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'config.toml'), 'model = "gpt-5.6-luna"\n');
    installStaleExtendedWindowRecord('gpt-5.6-luna');

    const { writeSuCodexHome, ensureSuCodexHomeConfig } = await import('./role-codex-home');
    const base = {
      sessionKey: 'context-default-su',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-context-default',
    };
    expect(() => writeSuCodexHome(base)).toThrow(/Codex model is required/);
    const out = writeSuCodexHome({ ...base, model: RESOLVED_CODEX_DEFAULT });

    const config = readFileSync(out.configPath, 'utf8');
    expect(config).toContain('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n');
    expect(config).toMatch(
      /^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
    );
    writeFileSync(out.configPath, config.replace('model_reasoning_effort = "xhigh"\n', ''));
    expect(() =>
      ensureSuCodexHomeConfig({
        sessionKey: 'context-default-su',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        sid: 'su-context-default',
      }),
    ).toThrow(/Codex model is required/);
    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'context-default-su',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-context-default',
      model: RESOLVED_CODEX_DEFAULT,
    });
    expect(repaired.repaired).toBe(true);
    expect(readFileSync(repaired.configPath, 'utf8')).toContain(
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"\n',
    );
  });

  it('rejects Spark at role and SU CODEX_HOME boundaries while preserving an allowed-model control', async () => {
    const { writeRoleCodexHome, writeSuCodexHome } = await import('./role-codex-home');

    expect(() =>
      writeRoleCodexHome({
        sessionKey: 'spark-role-denied',
        mcpUrl: 'http://x/api/mcp?role=worker',
        promptText: 'P',
        model: 'openai-codex/gpt-5.3-codex-spark:high',
      }),
    ).toThrow(/denied/i);
    expect(() =>
      writeSuCodexHome({
        sessionKey: 'spark-su-denied',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'P',
        sid: 'su-spark-denied',
        model: 'gpt-5.3-codex-spark',
      }),
    ).toThrow(/denied/i);

    const role = writeRoleCodexHome({
      sessionKey: 'spark-role-control',
      mcpUrl: 'http://x/api/mcp?role=worker',
      promptText: 'P',
      model: 'gpt-5.5:high',
    });
    const su = writeSuCodexHome({
      sessionKey: 'spark-su-control',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-spark-control',
      model: 'gpt-5.5:high',
    });
    expect(readFileSync(role.configPath, 'utf8')).toContain(
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
    );
    expect(readFileSync(su.configPath, 'utf8')).toContain(
      'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
    );
  });

  it('bakes the exact context roots into fresh and repaired SU homes', async () => {
    installStaleExtendedWindowRecord('gpt-5.6-terra');
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const fresh = writeSuCodexHome({
      sessionKey: 'context-su',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-context',
      model: 'gpt-5.6-terra:xhigh',
      codexGatewayAuto: true,
      codexGatewayPriority: 'su',
    });
    expect(readFileSync(fresh.configPath, 'utf8')).toMatch(
      /^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
    );
    expect(readFileSync(fresh.configPath, 'utf8')).toContain(`log_dir = "${join(fresh.codexHome, 'log')}"`);
    expect(readFileSync(fresh.configPath, 'utf8')).toContain('"x-papercusp-owner" = "su-context"');
    expect(readFileSync(fresh.configPath, 'utf8')).toContain('"x-papercusp-priority" = "su"');

    const staleGatewayIdentity = readFileSync(fresh.configPath, 'utf8')
      .replace('"x-papercusp-owner" = "su-context"', '"x-papercusp-owner" = "su-stale"')
      .replace('"x-papercusp-priority" = "su"', '"x-papercusp-priority" = "bee"');
    writeFileSync(fresh.configPath, staleGatewayIdentity);
    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'context-su',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-context',
      model: 'gpt-5.6-terra:xhigh',
      codexGatewayAuto: true,
      codexGatewayPriority: 'su',
    });
    expect(repaired.repaired).toBe(true);
    expect(readFileSync(repaired.configPath, 'utf8')).toMatch(
      /^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
    );
    expect(readFileSync(repaired.configPath, 'utf8')).toContain(`log_dir = "${join(repaired.codexHome, 'log')}"`);
    expect(readFileSync(repaired.configPath, 'utf8')).toContain('"x-papercusp-owner" = "su-context"');
    expect(readFileSync(repaired.configPath, 'utf8')).toContain('"x-papercusp-priority" = "su"');
    expect(readFileSync(repaired.configPath, 'utf8')).not.toContain('su-stale');
  });

  it('repairs an Astra resume from the session CODEX_HOME registry, not the parent HOME cache', async () => {
    const { ensureSuCodexHomeConfig, writeRoleCodexHome, writeSuCodexHome } = await loadMod();
    const previous = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      const fresh = writeRoleCodexHome({
        sessionKey: 'astra-context-fresh',
        mcpUrl: 'http://x/api/mcp?role=worker',
        promptText: 'P',
        model: 'gpt-6-astra',
      });
      expect(readFileSync(fresh.configPath, 'utf8')).toMatch(
        /^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
      );

      const home = writeSuCodexHome({
        sessionKey: 'astra-context-home',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'P',
        sid: 'su-astra-context',
        model: 'gpt-5.5',
      });
      writeFileSync(
        join(home.codexHome, 'models_cache.json'),
        JSON.stringify({
          models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }],
        }),
      );

      const repaired = ensureSuCodexHomeConfig({
        sessionKey: 'astra-context-home',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        sid: 'su-astra-context',
        model: 'gpt-6-astra',
      });
      expect(repaired.repaired).toBe(true);
      expect(readFileSync(repaired.configPath, 'utf8')).toMatch(
        /^model_context_window = 872000\nmodel_auto_compact_token_limit = 784800\n/,
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it.each([
    ['missing context roots', ''],
    ['superseded context roots', 'model_context_window = 872000\nmodel_auto_compact_token_limit = 784800\n'],
  ])('upgrades a healthy managed SU home with %s before a model-less resume', async (_case, prefix) => {
    installStaleExtendedWindowRecord('gpt-5.6-sol');
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const sessionKey = `context-upgrade-${prefix.length}`;
    const old = writeSuCodexHome({
      sessionKey,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-context-upgrade',
      model: 'gpt-5.5',
    });
    const oldToml = readFileSync(old.configPath, 'utf8');
    writeFileSync(old.configPath, `${prefix}${oldToml}`);
    expect(readFileSync(old.configPath, 'utf8')).toContain('[mcp_servers.papercusp-su]');

    const upgraded = ensureSuCodexHomeConfig({
      sessionKey,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-context-upgrade',
      model: 'gpt-5.6-sol',
    });
    expect(upgraded.repaired).toBe(true);
    const upgradedToml = readFileSync(upgraded.configPath, 'utf8');
    expect(upgradedToml).toMatch(/^model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/);
    expect(upgradedToml).not.toContain('872000');
    expect(upgradedToml).not.toContain('784800');

    const idempotent = ensureSuCodexHomeConfig({
      sessionKey,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-context-upgrade',
      model: 'gpt-5.6-sol',
    });
    expect(idempotent.repaired).toBe(false);
    expect(readFileSync(idempotent.configPath, 'utf8')).toBe(upgradedToml);
  });

  it('repairs the terminal paste setting in an older SU home without losing its rollout', async () => {
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const opts = {
      sessionKey: 'terminal-paste-upgrade',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-terminal-paste-upgrade',
    };
    const home = writeSuCodexHome({ ...opts, promptText: 'PRESERVE', model: RESOLVED_CODEX_DEFAULT });
    const rollout = join(home.codexHome, 'sessions', 'rollout.jsonl');
    mkdirSync(join(home.codexHome, 'sessions'), { recursive: true });
    writeFileSync(rollout, '{"type":"session_meta"}\n');
    const current = readFileSync(home.configPath, 'utf8');
    writeFileSync(home.configPath, current.replace('alternate_screen = "never"\n', ''));

    const repaired = ensureSuCodexHomeConfig({ ...opts, model: RESOLVED_CODEX_DEFAULT });
    expect(repaired.repaired).toBe(true);
    expect(readFileSync(repaired.configPath, 'utf8')).toContain('alternate_screen = "never"');
    expect(readFileSync(rollout, 'utf8')).toContain('session_meta');
    expect(readFileSync(join(home.codexHome, 'AGENTS.md'), 'utf8')).toContain('PRESERVE');
    expect(ensureSuCodexHomeConfig({ ...opts, model: RESOLVED_CODEX_DEFAULT }).repaired).toBe(false);
  });

  it('repairs a reused SU home from a prior owner without deleting its rollout or prompt', async () => {
    await installFakeHooks();
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const oldOwner = 'su-old-owner';
    const newOwner = 'su-current-owner';
    const home = writeSuCodexHome({
      sessionKey: 'identity-repair',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'PRESERVE THIS PROMPT',
      sid: oldOwner,
    });
    const rollout = join(home.codexHome, 'sessions', '2026', '08', '22', 'rollout.jsonl');
    mkdirSync(join(home.codexHome, 'sessions', '2026', '08', '22'), { recursive: true });
    writeFileSync(rollout, '{"type":"session_meta"}\n');

    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'identity-repair',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: newOwner,
    });

    expect(repaired.repaired).toBe(true);
    expect(repaired.identityRepaired).toBe(true);
    expect(readFileSync(repaired.configPath, 'utf8')).toContain(`client=${newOwner}`);
    expect(readFileSync(repaired.configPath, 'utf8')).not.toContain(`client=${oldOwner}`);
    const hooks = readFileSync(join(home.codexHome, 'hooks.json'), 'utf8');
    expect(hooks).toContain(`PAPERCUSP_LOCK_SID='${newOwner}'`);
    expect(hooks).not.toContain(oldOwner);
    const diagnostics = JSON.parse(readFileSync(join(home.codexHome, 'papercusp-diagnostics.json'), 'utf8'));
    expect(diagnostics.lockOwnerSid).toBe(newOwner);
    expect(readFileSync(join(home.codexHome, '.owner-sid'), 'utf8')).toBe(newOwner);
    expect(readFileSync(join(home.codexHome, 'AGENTS.md'), 'utf8')).toContain('PRESERVE THIS PROMPT');
    expect(readFileSync(rollout, 'utf8')).toContain('session_meta');

    const idempotent = ensureSuCodexHomeConfig({
      sessionKey: 'identity-repair',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: newOwner,
    });
    expect(idempotent).toMatchObject({ repaired: false, identityRepaired: false });
  });

  it('restores canonical instructions and carry base without deleting an existing rollout', async () => {
    await installFakeHooks();
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const home = writeSuCodexHome({
      sessionKey: 'missing-agents',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'ORIGINAL SU RULES',
      sid: 'su-missing-agents',
    });
    const rollout = join(home.codexHome, 'sessions', '2026', '09', '24', 'rollout.jsonl');
    mkdirSync(join(home.codexHome, 'sessions', '2026', '09', '24'), { recursive: true });
    writeFileSync(rollout, '{"type":"session_meta"}\n');
    rmSync(home.agentsPath);
    writeFileSync(join(home.codexHome, '.papercusp-carry-base-AGENTS.md'), '');

    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'missing-agents',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-missing-agents',
      promptText: 'CURRENT CANONICAL SU RULES',
    });
    expect(repaired).toMatchObject({ repaired: true, promptRepaired: true });
    expect(readFileSync(home.agentsPath, 'utf8')).toContain('CURRENT CANONICAL SU RULES');
    expect(readFileSync(join(home.codexHome, '.papercusp-carry-base-AGENTS.md'), 'utf8'))
      .toContain('CURRENT CANONICAL SU RULES');
    expect(readFileSync(rollout, 'utf8')).toContain('session_meta');
    expect(ensureSuCodexHomeConfig({
      sessionKey: 'missing-agents',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-missing-agents',
      promptText: 'CURRENT CANONICAL SU RULES',
    }).promptRepaired).toBe(false);
  });

  it('rematerializes an entirely missing home for a fresh carry without using a destructive rebuild', async () => {
    await installFakeHooks();
    const { ensureSuCodexHomeConfig } = await loadMod();
    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'gc-removed-home',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-gc-removed-home',
      promptText: 'RESTORED CANONICAL SU RULES',
      recoverMissingHome: true,
    });
    expect(repaired).toMatchObject({ repaired: true, promptRepaired: true });
    expect(readFileSync(join(repaired.codexHome, 'AGENTS.md'), 'utf8'))
      .toContain('RESTORED CANONICAL SU RULES');
    expect(readFileSync(repaired.configPath, 'utf8')).toContain('client=su-gc-removed-home');
  });

  it('rekeys a prepared home to the durable adv-session id without rebuilding or overwriting', async () => {
    const { rekeyCodexHome, writeSuCodexHome } = await loadMod();
    const prepared = writeSuCodexHome({
      sessionKey: 'port-uuid',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'PORTED SESSION PLAYBOOK',
      sid: 'su-port',
    });
    writeFileSync(join(prepared.codexHome, 'prepared-only.txt'), 'keep me');

    const durableHome = rekeyCodexHome('port-uuid', 12596);
    expect(durableHome).toBe(join(fakeHome, '.papercusp', 'su-codex-homes', 'session-12596'));
    expect(existsSync(prepared.codexHome)).toBe(false);
    expect(readFileSync(join(durableHome, 'prepared-only.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(durableHome, 'AGENTS.md'), 'utf8')).toContain('PORTED SESSION PLAYBOOK');

    writeSuCodexHome({
      sessionKey: 12597,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'EXISTING TARGET',
      sid: 'su-existing',
    });
    expect(() => rekeyCodexHome(12596, 12597)).toThrow(/target Codex home already exists/);
    expect(readFileSync(join(durableHome, 'prepared-only.txt'), 'utf8')).toBe('keep me');
  });

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
    const agents = readFileSync(out.agentsPath, 'utf8');
    expect(agents).toContain('ENGINEER PLAYBOOK BODY');
    expect(agents).toContain('locks:acquire');
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.papercusp-su]');
    // D-006: bearer baked as http_headers (codex 0.135 ignores bearer_token_env_var for HTTP).
    expect(toml).toContain('http_headers = { Authorization = "Bearer TESTBEARER123456" }');
    expect(toml).not.toContain('bearer_token_env_var');
    // per-session client baked into the url (codex can't env-expand config.toml).
    expect(toml).toContain('client=su-abc-123');
    expect(toml).toContain('superuser=1');
    const logDir = join(out.codexHome, 'log');
    expect(toml).toContain(`log_dir = "${logDir}"`);
    expect(toml.indexOf(`log_dir = "${logDir}"`)).toBeLessThan(toml.indexOf('[features]'));
    expect(existsSync(logDir)).toBe(true);
    // psu-isolation P-004 / D-001: no cwd AGENTS.md read + native memory off.
    expect(toml).toContain('project_doc_max_bytes = 0');
    expect(toml).toContain('[features]');
    expect(toml).toContain('memories = false');
    expect(toml).toContain('remote_compaction_v2 = false');
    expect(toml).not.toContain('memory_tool');
    // tui-status-parity 2026-07-05: the objective-title hook owns the terminal
    // title — an EMPTY terminal_title item list stops codex's own OSC-0 writes
    // (default ["activity","project"]) clobbering display.title every turn.
    expect(toml).toContain('[tui]\nterminal_title = []');
    expect(toml).toContain('[tui]\nterminal_title = []\nalternate_screen = "never"\n');
    // tui-status-parity D 2026-07-06: codex gets a native bottom status pane.
    expect(toml).toContain('status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]');
  });

  it('no token → degraded config (url only, no http_headers / superuser bearer)', async () => {
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 11, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).not.toContain('http_headers');
    expect(toml).not.toContain('Authorization');
  });

  it('carries project HTTP MCP servers into fresh and repaired Codex SU homes', async () => {
    const projectDir = join(fakeHome, 'project');
    mkdirSync(projectDir);
    const claudeConfig = join(fakeHome, '.claude.json');
    const writeProjectServers = (url: string) => writeFileSync(claudeConfig, JSON.stringify({
      mcpServers: { global: { type: 'http', url: 'https://global.example/mcp' } },
      projects: { [projectDir]: { mcpServers: {
        tsenta: { type: 'http', url, headers: { 'X-Project': 'yes' } },
        local: { type: 'stdio', command: 'never-run' },
        'papercusp-su': { type: 'http', url: 'https://override.example/mcp' },
      } } },
    }));
    writeProjectServers('https://tsenta.example/mcp');
    const { writeSuCodexHome, ensureSuCodexHomeConfig } = await loadMod();
    const opts = { sessionKey: 111, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 'su-project', trustDir: projectDir };
    const home = writeSuCodexHome(opts);
    const fresh = readFileSync(home.configPath, 'utf8');
    expect(fresh).toContain('[mcp_servers."tsenta"]\nurl = "https://tsenta.example/mcp"\nhttp_headers = { "X-Project" = "yes" }');
    expect(fresh).not.toContain('global.example');
    expect(fresh).not.toContain('never-run');
    expect(fresh).not.toContain('override.example');
    const parsed = parseToml(fresh) as { mcp_servers: Record<string, { url: string; http_headers?: Record<string, string> }> };
    expect(parsed.mcp_servers.tsenta).toEqual({ url: 'https://tsenta.example/mcp', http_headers: { 'X-Project': 'yes' } });
    writeProjectServers('https://tsenta.example/updated');
    const repaired = ensureSuCodexHomeConfig({ ...opts, projectDir, trustDir: null });
    expect(repaired.repaired).toBe(true);
    expect(readFileSync(home.configPath, 'utf8')).toContain('https://tsenta.example/updated');
    expect(ensureSuCodexHomeConfig({ ...opts, projectDir, trustDir: null }).repaired).toBe(false);
  });

  it('symlinks auth.json (shared OAuth) + rebuilds fresh', async () => {
    const realAuthDir = join(fakeHome, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(realAuthDir, { recursive: true });
    writeFileSync(join(realAuthDir, 'auth.json'), '{"token":"real"}');

    const { writeSuCodexHome } = await loadMod();
    const first = writeSuCodexHome({
      sessionKey: 'k',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'OLD',
      sid: 's1',
    });
    writeFileSync(join(first.codexHome, 'STALE.txt'), 'stale');
    const second = writeSuCodexHome({
      sessionKey: 'k',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'NEW',
      sid: 's2',
    });

    expect(lstatSync(join(second.codexHome, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(second.agentsPath, 'utf8')).toContain('NEW');
    expect(existsSync(join(second.codexHome, 'STALE.txt'))).toBe(false);
    expect(readFileSync(second.configPath, 'utf8')).toContain('client=s2');
  });

  describe('EI-11366 identity-split collision guard', () => {
    it('with no isOwnerLive wired, a same-sessionKey rebuild under a different sid stays byte-identical to today (no default liveness check)', async () => {
      const { writeSuCodexHome } = await loadMod();
      writeSuCodexHome({ sessionKey: 'k2', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'OLD', sid: 's1' });
      // No isOwnerLive passed — the guard must be a complete no-op (default off).
      const second = writeSuCodexHome({
        sessionKey: 'k2',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'NEW',
        sid: 's2',
      });
      expect(readFileSync(second.agentsPath, 'utf8')).toContain('NEW');
    });

    it('REFUSES to rebuild a sessionKey whose home is still the LIVE Codex home of a different sid', async () => {
      const { writeSuCodexHome } = await loadMod();
      writeSuCodexHome({
        sessionKey: 'k3',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'FIRST',
        sid: 'su-adf046e9',
      });
      const isOwnerLive = vi.fn((sid: string) => sid === 'su-adf046e9');
      expect(() =>
        writeSuCodexHome({
          sessionKey: 'k3',
          mcpUrl: 'http://x/api/mcp?superuser=1',
          promptText: 'SECOND',
          sid: 'su-0efdd444',
          isOwnerLive,
        }),
      ).toThrow(/refusing to rebuild/);
      expect(isOwnerLive).toHaveBeenCalledWith('su-adf046e9');
      // The refusal must be a true refusal — the original home is untouched.
      const home = join(fakeHome, '.papercusp', 'su-codex-homes', 'session-k3');
      expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toContain('FIRST');
    });

    it('proceeds (rebuilds) when isOwnerLive reports the prior owner is DEAD', async () => {
      const { writeSuCodexHome } = await loadMod();
      writeSuCodexHome({ sessionKey: 'k4', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'FIRST', sid: 's1' });
      const isOwnerLive = vi.fn(() => false);
      const second = writeSuCodexHome({
        sessionKey: 'k4',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'SECOND',
        sid: 's2',
        isOwnerLive,
      });
      expect(readFileSync(second.agentsPath, 'utf8')).toContain('SECOND');
    });

    it('re-preparing the SAME sid never consults isOwnerLive (same-session rebuild is always allowed)', async () => {
      const { writeSuCodexHome } = await loadMod();
      writeSuCodexHome({ sessionKey: 'k5', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'FIRST', sid: 's1' });
      const isOwnerLive = vi.fn(() => true); // would refuse if (wrongly) consulted
      const second = writeSuCodexHome({
        sessionKey: 'k5',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'SECOND',
        sid: 's1',
        isOwnerLive,
      });
      expect(readFileSync(second.agentsPath, 'utf8')).toContain('SECOND');
      expect(isOwnerLive).not.toHaveBeenCalled();
    });

    it('stamps a .owner-sid sentinel every write, so a first-ever write at a fresh sessionKey never has a prior owner to check', async () => {
      const { writeSuCodexHome } = await loadMod();
      const isOwnerLive = vi.fn(() => true);
      const out = writeSuCodexHome({
        sessionKey: 'k6',
        mcpUrl: 'http://x/api/mcp?superuser=1',
        promptText: 'FIRST',
        sid: 's1',
        isOwnerLive,
      });
      expect(isOwnerLive).not.toHaveBeenCalled(); // nothing existed at this key yet
      expect(readFileSync(join(out.codexHome, '.owner-sid'), 'utf8')).toBe('s1');
    });
  });

  it('inherits user Codex skills/plugins/prompts and trusted workspace state into the isolated home', async () => {
    const { mkdirSync } = await import('node:fs');
    const realCodex = join(fakeHome, '.codex');
    mkdirSync(join(realCodex, 'skills'), { recursive: true });
    mkdirSync(join(realCodex, 'plugins'), { recursive: true });
    mkdirSync(join(realCodex, 'prompts'), { recursive: true });
    writeFileSync(join(realCodex, 'prompts', 'user-prompt.md'), 'USER PROMPT');
    writeFileSync(
      join(realCodex, 'config.toml'),
      [
        'model = "gpt-5"',
        '',
        '[trusted_workspaces]',
        '"/repo" = true',
        '',
        // Modern codex records directory trust here (ProjectConfig) — the shape our
        // inherit helper used to silently ignore, booting fresh homes untrusted.
        '[projects."/home/me/repo"]',
        'trust_level = "trusted"',
        '',
        '[model_providers.default]',
        'name = "Default"',
        '',
      ].join('\n'),
    );

    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 'inherit',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 's',
    });

    expect(lstatSync(join(out.codexHome, 'skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out.codexHome, 'skills'))).toBe(join(realCodex, 'skills'));
    expect(lstatSync(join(out.codexHome, 'plugins')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out.codexHome, 'plugins'))).toBe(join(realCodex, 'plugins'));

    const promptsLink = join(out.codexHome, 'prompts');
    expect(lstatSync(promptsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(promptsLink)).toBe(join(out.codexHome, 'prompts.user'));
    expect(readFileSync(join(out.codexHome, 'prompts', 'user-prompt.md'), 'utf8')).toBe('USER PROMPT');

    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[trusted_workspaces]');
    expect(toml).toContain('"/repo" = true');
    // modern [projects.*] trust tables inherit too (the previously-dropped shape).
    expect(toml).toContain('[projects."/home/me/repo"]');
    expect(toml).toContain('trust_level = "trusted"');
    expect(toml).not.toContain('[model_providers.default]');
    const diag = JSON.parse(readFileSync(join(out.codexHome, 'papercusp-diagnostics.json'), 'utf8'));
    expect(diag.inheritedPromptsCopied).toBe(true);
  });

  it('inherits [notice] + [notice.model_migrations] nudge-suppression state (EI-19988517595776254 follow-up) alongside [tui.model_availability_nux]', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        '',
        '[tui.model_availability_nux]',
        '"gpt-5.5" = 4',
        '',
        '[notice]',
        'hide_rate_limit_model_nudge = true',
        '',
        '[notice.model_migrations]',
        '"gpt-5.4" = "gpt-5.5"',
        '',
        '[model_providers.default]',
        'name = "Default"',
        '',
      ].join('\n'),
    );

    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 'inherit-notice',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 's',
    });

    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain('[tui.model_availability_nux]');
    expect(toml).toContain('"gpt-5.5" = 4');
    expect(toml).toContain('[notice]');
    expect(toml).toContain('hide_rate_limit_model_nudge = true');
    expect(toml).toContain('[notice.model_migrations]');
    expect(toml).toContain('"gpt-5.4" = "gpt-5.5"');
    // Unrelated tables must NOT leak into the generated home.
    expect(toml).not.toContain('[model_providers.default]');
  });

  it('seeds launch-dir trust ([projects."<trustDir>"] trust_level) so a fresh CODEX_HOME never blocks at the boot trust prompt', async () => {
    const { writeSuCodexHome } = await loadMod();
    const dir = '/home/dev/papercupai-workspace/papercusp';
    const out = writeSuCodexHome({
      sessionKey: 'trust',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 's',
      trustDir: dir,
    });
    const toml = readFileSync(out.configPath, 'utf8');
    expect(toml).toContain(`[projects."${dir}"]`);
    expect(toml).toContain('trust_level = "trusted"');
  });

  it('does NOT double-emit the launch-dir trust table when the same dir is already inherited', async () => {
    const { mkdirSync } = await import('node:fs');
    const realCodex = join(fakeHome, '.codex');
    mkdirSync(realCodex, { recursive: true });
    const dir = '/home/me/already-trusted';
    writeFileSync(join(realCodex, 'config.toml'), [`[projects."${dir}"]`, 'trust_level = "trusted"', ''].join('\n'));

    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 'no-dupe',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 's',
      trustDir: dir,
    });
    const toml = readFileSync(out.configPath, 'utf8');
    // exactly one table header for the dir — TOML rejects a duplicate table header.
    const occurrences = toml.split(`[projects."${dir}"]`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('installs the SU-locks hooks.json when hooks are present', async () => {
    await installFakeHooks();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 6, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    expect(existsSync(join(out.codexHome, 'hooks.json'))).toBe(true);
    expect(existsSync(join(out.codexHome, 'settings.json'))).toBe(false);
    const diag = JSON.parse(readFileSync(join(out.codexHome, 'papercusp-diagnostics.json'), 'utf8'));
    expect(diag.lockEnforcement).toBe('hooks-configured');
    expect(diag.codexPreToolUseStatus).toBe('configured-unverified');
    expect(diag.lockMode).toBe('manual');
    expect(diag.requiresExplicitPapercuspLocks).toBe(true);
    expect(diag.lockOwnerSid).toBe('s');
    expect(readFileSync(out.agentsPath, 'utf8')).toContain('papercusp-rule:file-locking=explicit-manual');
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreCompact).toHaveLength(1);
    expect(hooks.hooks.PreCompact[0].matcher).toBe('^auto$');
    expect(hooks.hooks.PreCompact[0].hooks[0].timeout).toBe(600);
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain(
      'precompact-managed-carry.mjs',
    );
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain(
      'PAPERCUSP_MCP_AUTH=superuser-token',
    );
  });

  it('writes exactly one automatic rule after an owner-scoped runtime hook proof', async () => {
    await installFakeHooks();
    installOwnerRuntimeProof('s');
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 'probed',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText:
        'P\n<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-START -->\nold static lock advice\n<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-END -->',
      sid: 's',
      instructionRuntime: {
        source: 'bootstrap-su',
        ownerId: 's',
        modes: ['auto'],
        route: { kind: 'self' },
        scope: { plan: 'plan-x' },
      },
    });
    const agents = readFileSync(out.agentsPath, 'utf8');
    const diag = JSON.parse(readFileSync(join(out.codexHome, 'papercusp-diagnostics.json'), 'utf8'));
    expect(diag).toMatchObject({ lockMode: 'automatic', hookHealth: 'verified', runtimeProbed: true });
    expect(agents).not.toContain('old static lock advice');
    expect(agents.match(/papercusp-rule:file-locking=/g)).toHaveLength(1);
    expect(agents).toContain('papercusp-rule:file-locking=automatic-hooks');
    expect(out.instructionLint.conflicts).toEqual([]);
    expect(out.instructionLint.precedenceTrace).toMatchObject({
      effectiveMission: { constraint: 'execute-bound-plan', source: 'plan:plan-x' },
      decisions: expect.arrayContaining([
        expect.objectContaining({
          key: 'execution-authorization',
          effective: expect.objectContaining({ value: 'act-with-disclosure' }),
        }),
      ]),
    });
  });

  it('reads non-secret CODEX_HOME diagnostics, including latest rollout id and resume command', async () => {
    await installFakeHooks();
    const { writeSuCodexHome, readCodexHomeDiagnostics } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 'diag',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 's',
    });
    const { mkdirSync } = await import('node:fs');
    const rolloutDir = join(out.codexHome, 'sessions', '2026', '06', '21');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(join(rolloutDir, 'rollout-2026-06-21T13-12-06-019eeb2b-0742-72a0-85a4-5dc505cfe62d.jsonl'), '{}\n');

    const diag = readCodexHomeDiagnostics('diag');
    expect(diag.exists).toBe(true);
    expect(diag.agentsExists).toBe(true);
    expect(diag.configExists).toBe(true);
    expect(diag.hooksExists).toBe(true);
    expect(diag.diagnosticsExists).toBe(true);
    expect(diag.diagnostics?.lockEnforcement).toBe('hooks-configured');
    expect(diag.diagnostics?.lockOwnerSid).toBe('s');
    expect(diag.latestRolloutId).toBe('019eeb2b-0742-72a0-85a4-5dc505cfe62d');
    expect(diag.resumeStrategy).toBe('codex-resume-last-in-code-home');
    expect(diag.resumeCommand).toContain('codex resume --last');
    expect(diag.resumeCommand).toContain(out.codexHome);
    expect(diag.configPath).toBe(out.configPath);
  });

  it('the HUMAN su home gets NO native-scheduler guard (native-scheduler-lockout D-003)', async () => {
    await installFakeHooks();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({ sessionKey: 61, mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'P', sid: 's' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(JSON.stringify(hooks)).not.toContain('pretooluse-bash-resource-gate.sh');
    expect(JSON.stringify(hooks)).not.toContain('PAPERCUSP_AGENT_SESSION');
  });

  it('adds the coord-folding activity hook (PostToolUse, matcher .*, baked PAPERCUSP_SID = the session id)', async () => {
    await installFakeHooks();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 12,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-abc-123',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    // Four PostToolUse entries: lock-release + byte-integrity + activity report (coord-folding) +
    // objective-title. No separate coord entry any more (EI-11405 merge).
    expect(hooks.hooks.PostToolUse).toHaveLength(4);
    const preLock = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-locks-acquire.sh'),
    );
    const postLock = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-locks-release.sh'),
    );
    expect(preLock.matcher).toBe('apply_patch|Edit|Write');
    expect(postLock.matcher).toBe('^(?:apply_patch|Edit|Write|exec|functions\\.exec|functions__exec)$');
    expect(preLock.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
    expect(preLock.hooks[0].command).toContain("PAPERCUSP_LOCK_SID='su-abc-123'");
    expect(postLock.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
    expect(postLock.hooks[0].command).toContain("PAPERCUSP_LOCK_SID='su-abc-123'");
    const controlBytes = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-control-bytes-content-guard.mjs'),
    );
    expect(controlBytes).toBeTruthy();
    expect(controlBytes.matcher).toContain('apply_patch');
    const generatedFiles = hooks.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('pretooluse-generated-file-edit-guard.mjs'),
    );
    expect(generatedFiles).toBeTruthy();
    expect(generatedFiles.matcher).toContain('apply_patch');
    const byteGuard = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-write-byte-integrity-guard.mjs'),
    );
    expect(byteGuard).toBeTruthy();
    expect(byteGuard.matcher).toBe('^(?:Write|mcp__.*__capability_write)$');

    // The activity-bridge hook — an SU/engineer session is a worker too — now ALSO
    // carries the coord:inbox PUSH (new messages folded into the same round trip,
    // mid-turn delivery parity with the Claude global-settings coord entry).
    const activity = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-activity-report.sh'),
    );
    expect(activity).toBeTruthy();
    expect(activity.matcher).toBe('.*');
    // SID baked (codex doesn't env-expand) so the hook's coord identity == &client=.
    expect(activity.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
    expect(activity.hooks[0].command).toContain('PAPERCUSP_AGENT=codex');
    expect(activity.hooks[0].command).toContain('PAPERCUSP_WORKSPACE_ROOT=');
    // coordSid WAS given ⇒ the fold stays ON (no PAPERCUSP_COORD_FOLD=0 override).
    expect(activity.hooks[0].command).not.toContain('PAPERCUSP_COORD_FOLD=0');

    // The objective-title hook (session-objective-display-2026-06-22): terminal
    // title ← coord:glance self.objective, matcher .*, baked SID = the session id.
    const objective = hooks.hooks.PostToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('posttooluse-objective-title.sh'),
    );
    expect(objective).toBeTruthy();
    expect(objective.matcher).toBe('.*');
    expect(objective.hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");

    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionEnd).toHaveLength(1);
    for (const event of ['SessionStart', 'SessionEnd']) {
      expect(hooks.hooks[event][0].hooks[0].command).toContain('lifecycle-report.sh');
      expect(hooks.hooks[event][0].hooks[0].command).toContain("PAPERCUSP_SID='su-abc-123'");
      expect(hooks.hooks[event][0].hooks[0].command).toContain("PAPERCUSP_ADV_SESSION_ID='12'");
    }
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toContain('PAPERCUSP_ACTIVITY_SYNC=1');
  });

  it('repairs a same-owner managed home whose hooks omit lifecycle or managed PreCompact events', async () => {
    await installFakeHooks();
    const { ensureSuCodexHomeConfig, writeSuCodexHome } = await loadMod();
    const home = writeSuCodexHome({
      sessionKey: 'lifecycle-upgrade',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'PRESERVE',
      sid: 'su-lifecycle-upgrade',
    });
    const hooksPath = join(home.codexHome, 'hooks.json');
    const oldHooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    delete oldHooks.hooks.SessionStart;
    delete oldHooks.hooks.SessionEnd;
    delete oldHooks.hooks.PreCompact;
    writeFileSync(hooksPath, JSON.stringify(oldHooks, null, 2));

    const repaired = ensureSuCodexHomeConfig({
      sessionKey: 'lifecycle-upgrade',
      mcpUrl: 'http://x/api/mcp?superuser=1',
      sid: 'su-lifecycle-upgrade',
    });

    expect(repaired).toMatchObject({ repaired: true, identityRepaired: true });
    const nextHooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(nextHooks.hooks.SessionStart).toHaveLength(1);
    expect(nextHooks.hooks.SessionEnd).toHaveLength(1);
    expect(nextHooks.hooks.PreCompact).toHaveLength(1);
    expect(nextHooks.hooks.PreCompact[0].matcher).toBe('^auto$');
    expect(readFileSync(join(home.codexHome, 'AGENTS.md'), 'utf8')).toContain('PRESERVE');
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
    expect(JSON.stringify(hooks)).not.toContain('posttooluse-activity-report.sh');
  });
});

/**
 * CONTEXT-INJECTION registration — codex-context-injection-parity-2026-08-09 P-004.
 *
 * These assert the codex leg of the shared dispatcher (D-001) is wired into the
 * per-session CODEX_HOME. The premise they rest on was MEASURED live, not assumed:
 * codex-cli 0.146.0 DOES fire a `UserPromptSubmit` MatcherGroup declared in
 * `$CODEX_HOME/hooks.json` (D-004) — the file's own prior comment claimed no such
 * event existed there, which is why this is asserted rather than trusted.
 */
describe('writeCodexLockHooks — context-injection hooks (P-004)', () => {
  /** Stub the shared dispatcher at its installed path (installInjectionHooks
   *  puts it at ~/.papercusp/hooks/inject/index.mjs, BESIDE the cc hooks). */
  function installFakeDispatcher() {
    const dir = join(fakeHome, '.papercusp', 'hooks', 'inject');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), '#!/usr/bin/env node\n');
  }

  function injectEntries(hooks: any, event: string) {
    return (hooks.hooks[event] ?? []).filter((e: { hooks: { command: string }[] }) =>
      e.hooks[0].command.includes('hooks/inject/index.mjs'),
    );
  }

  it('registers BOTH ports through the ONE shared dispatcher, with the right --client/--event', async () => {
    await installFakeHooks();
    installFakeDispatcher();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 40,
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      sid: 'role-inject-40',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));

    // turn-start ← UserPromptSubmit (the port carrying ~94% of recall volume)
    const turnStart = injectEntries(hooks, 'UserPromptSubmit');
    expect(turnStart).toHaveLength(1);
    expect(turnStart[0].hooks[0].command).toContain('--client=codex');
    expect(turnStart[0].hooks[0].command).toContain('--event=UserPromptSubmit');

    // mid-turn ← PostToolUse. PER CALL on codex (it has no batch event, D-002 §5).
    const midTurn = injectEntries(hooks, 'PostToolUse');
    expect(midTurn).toHaveLength(1);
    expect(midTurn[0].hooks[0].command).toContain('--event=PostToolUse');

    // The dispatcher is SHARED — a codex-specific transport copy would be the
    // D-001 violation this whole seam exists to prevent.
    expect(JSON.stringify(hooks)).not.toContain('adapters/codex.mjs');
  });

  it('BAKES PAPERCUSP_SID — an un-baked sid makes the hook fire and inject NOTHING', async () => {
    // This is the falsifiability control for D-001 invariant 3: codex hands hook
    // commands a minimal env, and the dispatcher treats a missing PAPERCUSP_SID as
    // "not a psu session" → exit 0, no output. That failure is INVISIBLE (a hook
    // that ran, succeeded, and injected nothing looks identical to one that never
    // fired), so the bake is asserted explicitly rather than left to review.
    await installFakeHooks();
    installFakeDispatcher();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 41,
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      sid: 'role-inject-41',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    for (const event of ['UserPromptSubmit', 'PostToolUse']) {
      const [entry] = injectEntries(hooks, event);
      expect(entry, `${event} injection hook missing`).toBeTruthy();
      expect(entry.hooks[0].command).toContain("PAPERCUSP_SID='role-inject-41'");
      expect(entry.hooks[0].command).toContain('PAPERCUSP_AGENT=codex');
    }
  });

  it('registers NOTHING when the dispatcher is not installed — never a hook pointing at a missing file', async () => {
    await installFakeHooks(); // cc hooks present, dispatcher deliberately absent
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({
      sessionKey: 42,
      mcpUrl: 'http://x/?role=worker&sig=1',
      promptText: 'P',
      sid: 'role-inject-42',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    // The key is OMITTED entirely, not present-but-empty: "is turn-start
    // registered on this home?" must be answerable by reading hooks.json.
    expect(hooks.hooks.UserPromptSubmit).toBeUndefined();
    expect(injectEntries(hooks, 'PostToolUse')).toHaveLength(0);
    // ...and the pre-existing lock/activity hooks are UNAFFECTED.
    expect(JSON.stringify(hooks)).toContain('pretooluse-locks-acquire.sh');
  });

  it('registers NOTHING when the session has no sid', async () => {
    await installFakeHooks();
    installFakeDispatcher();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 43, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.UserPromptSubmit).toBeUndefined();
    expect(injectEntries(hooks, 'PostToolUse')).toHaveLength(0);
  });

  it('SU homes get injection too (su sessions are the dominant codex surface)', async () => {
    await installFakeHooks();
    installFakeDispatcher();
    const { writeSuCodexHome } = await loadMod();
    const out = writeSuCodexHome({
      sessionKey: 44,
      mcpUrl: 'http://x/api/mcp?superuser=1',
      promptText: 'P',
      sid: 'su-inject-44',
    });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(injectEntries(hooks, 'UserPromptSubmit')).toHaveLength(1);
    expect(injectEntries(hooks, 'PostToolUse')).toHaveLength(1);
    expect(injectEntries(hooks, 'UserPromptSubmit')[0].hooks[0].command).toContain("PAPERCUSP_SID='su-inject-44'");
  });

  it('registers the three identity hook ports (P-011) through the same dispatcher, every matcher .*', async () => {
    await installFakeHooks();
    installFakeDispatcher();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 45, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P', sid: 'role-inject-45' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    for (const event of ['PreToolUse', 'Stop', 'SessionStart']) {
      const entries = injectEntries(hooks, event);
      expect(entries, `${event} identity hook`).toHaveLength(1);
      expect(entries[0].matcher).toBe('.*');
      expect(entries[0].hooks[0].command).toContain(`--client=codex --event=${event}`);
      expect(entries[0].hooks[0].command).toContain("PAPERCUSP_SID='role-inject-45'");
    }
    // The lifecycle bridge keeps its own SessionStart entry beside the identity one.
    expect(JSON.stringify(hooks.hooks.SessionStart)).toContain('lifecycle-report.sh');
  });

  it('omits the Stop key entirely, and every identity port, without the dispatcher', async () => {
    await installFakeHooks();
    const writeRoleCodexHome = await load();
    const out = writeRoleCodexHome({ sessionKey: 46, mcpUrl: 'http://x/?role=worker&sig=1', promptText: 'P', sid: 'role-inject-46' });
    const hooks = JSON.parse(readFileSync(join(out.codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.Stop).toBeUndefined();
    expect(injectEntries(hooks, 'PreToolUse')).toHaveLength(0);
    expect(injectEntries(hooks, 'SessionStart')).toHaveLength(0);
  });
});

describe('makeCodingAssistantCodexHome (pui-chat-first-ux P-016)', () => {
  async function suHome() {
    const { writeSuCodexHome } = await import('./role-codex-home');
    const project = mkdtempSync(join(fakeHome, 'project-'));
    // The SU home inherits a project's HTTP servers from ~/.claude.json.
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
      projects: { [project]: { mcpServers: { docs: { type: 'http', url: 'http://docs.example/mcp' } } } },
    }));
    const out = writeSuCodexHome({
      sessionKey: 'coding-assistant', mcpUrl: 'http://x/api/mcp?superuser=1', promptText: 'SU PLAYBOOK',
      sid: 'su-coding-assistant', model: RESOLVED_CODEX_DEFAULT, trustDir: project, token: 'secret-token',
    });
    writeFileSync(join(out.codexHome, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [] } }));
    return out;
  }

  it('strips the SU server, the AGENTS.md cap, the playbook and the hooks, and keeps the rest', async () => {
    const { makeCodingAssistantCodexHome } = await import('./role-codex-home');
    const out = await suHome();
    const before = readFileSync(out.configPath, 'utf8');
    // Control: the SU home really carries what is about to be removed.
    expect(before).toContain('[mcp_servers.papercusp-su]');
    expect(before).toMatch(/^project_doc_max_bytes = 0$/m);
    expect(before).toContain('[mcp_servers."docs"]');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'my own codex rules');

    makeCodingAssistantCodexHome(out.codexHome, fakeHome);

    const after = readFileSync(out.configPath, 'utf8');
    const parsed = parseToml(after) as Record<string, any>;
    expect(parsed.mcp_servers?.['papercusp-su']).toBeUndefined();
    expect(parsed.mcp_servers?.docs).toMatchObject({ url: 'http://docs.example/mcp' });
    expect(parsed.project_doc_max_bytes).toBeUndefined();
    expect(after).not.toContain('secret-token');
    expect(parsed.model).toBe((parseToml(before) as Record<string, any>).model);
    expect(readFileSync(out.agentsPath, 'utf8')).toBe('my own codex rules');
    expect(lstatSync(out.agentsPath).isSymbolicLink()).toBe(false);
    expect(existsSync(join(out.codexHome, 'hooks.json'))).toBe(false);

    // Idempotent, and without a personal AGENTS.md the playbook is simply gone.
    rmSync(join(fakeHome, '.codex', 'AGENTS.md'));
    makeCodingAssistantCodexHome(out.codexHome, fakeHome);
    expect(readFileSync(out.configPath, 'utf8')).toBe(after);
    expect(existsSync(out.agentsPath)).toBe(false);
  });

  it('removes quoted and nested papercusp-su tables but no other server', async () => {
    const { codingAssistantCodexConfigToml } = await import('./role-codex-home');
    const toml = [
      'model = "m"',
      '[mcp_servers."papercusp-su"]', 'url = "a"',
      '[mcp_servers.papercusp-su.env]', 'X = "1"',
      '[mcp_servers.papercusp-sub]', 'url = "keep"',
      '[mcp_servers.papercusp]', 'url = "keep-too"',
      '',
    ].join('\n');
    const out = parseToml(codingAssistantCodexConfigToml(toml)) as Record<string, any>;
    expect(Object.keys(out.mcp_servers).sort()).toEqual(['papercusp', 'papercusp-sub']);
    expect(out.model).toBe('m');
  });
});
