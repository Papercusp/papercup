/**
 * WI-4562 — a Claude Code config rewrite silently de-enrolls every psu hook and drops
 * the coordination MCP server from a session's config.
 *
 * The CLOBBERED fixture below is not invented: it is the literal on-disk content of a
 * live interactive session (su-5d6764f9) after Claude Code persisted a /model change —
 * only CC-owned keys survived. 97/99 psu sessions were correctly enrolled; the 2 that
 * were not were BOTH the interactive owner-present sessions, because only an interactive
 * session triggers a CC settings-save. This bug targets the owner's own sessions.
 *
 * Run: cd packages/operator-core && npx vitest run lib/session-config-integrity.test.ts
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSessionConfigIntegrity,
  computeSessionConfigRepair,
  loadSessionConfigState,
  repairSessionConfigOnDisk,
  PSU_MCP_SERVER,
  type SessionConfigState,
} from './session-config-integrity';

/** The canonical psu hook block, as it lives in the global ~/.claude/settings.json. */
const GLOBAL_SETTINGS = {
  enableAllProjectMcpServers: true,
  statusLine: { command: '/home/u/.papercusp/hooks/statusline-fleet.sh' },
  theme: 'dark',
  hooks: {
    PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pretooluse-locks-acquire.sh' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'posttooluse-coord-inbox.sh' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'userpromptsubmit-memory.sh' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'lifecycle-report.sh' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'lifecycle-report.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'workitem-verify-nudge.sh' }] }],
  },
};

const GLOBAL_CLAUDE_JSON = {
  mcpServers: {
    playwright: { command: 'npx' },
    [PSU_MCP_SERVER]: { type: 'http', url: 'http://127.0.0.1:3070/api/mcp' },
  },
};

/** VERBATIM the clobbered settings.json found on disk — every psu key gone. */
const CLOBBERED_SETTINGS = {
  model: 'opus[1m]',
  effortLevel: 'xhigh',
  skipDangerousModePermissionPrompt: true,
  theme: 'dark',
};

const HEALTHY_SETTINGS = {
  model: 'opus[1m]',
  permissions: { defaultMode: 'bypassPermissions' },
  enableAllProjectMcpServers: true,
  statusLine: GLOBAL_SETTINGS.statusLine,
  hooks: GLOBAL_SETTINGS.hooks,
};

const state = (over: Partial<SessionConfigState> = {}): SessionConfigState => ({
  settings: CLOBBERED_SETTINGS,
  claudeJson: { mcpServers: {} },
  globalSettings: GLOBAL_SETTINGS,
  globalClaudeJson: GLOBAL_CLAUDE_JSON,
  // The baseline fixture models a Claude session; the WI-4617 short-circuit tests
  // override this to 'unknown' to exercise the non-Claude path.
  clientKind: 'claude',
  ...over,
});

describe('checkSessionConfigIntegrity', () => {
  it('detects a fully-clobbered session and names EVERY missing hook event', () => {
    const v = checkSessionConfigIntegrity(state());
    expect(v.ok).toBe(false);
    expect(v.missingHookEvents).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(v.mcpServerMissing).toBe(true);
    expect(v.permissionsDowngraded).toBe(true);
  });

  it('leads with the DATA-LOSS consequence — unlocked edits on a fleet-shared tree', () => {
    const v = checkSessionConfigIntegrity(state());
    expect(v.consequences[0]).toMatch(/NO EDIT LOCKS/);
  });

  it('spells out that dedup re-prime is dead across compactions (the silent one)', () => {
    const v = checkSessionConfigIntegrity(state());
    expect(v.consequences.join(' ')).toMatch(/NO POST-COMPACTION RE-PRIME/);
  });

  it('passes a healthy session', () => {
    const v = checkSessionConfigIntegrity(
      state({ settings: HEALTHY_SETTINGS, claudeJson: { mcpServers: { [PSU_MCP_SERVER]: {} } } }),
    );
    expect(v).toMatchObject({ ok: true, missingHookEvents: [], mcpServerMissing: false });
  });

  it('treats an EMPTY hook-event array as a wipe, not as presence', () => {
    const v = checkSessionConfigIntegrity(
      state({ settings: { ...HEALTHY_SETTINGS, hooks: { ...GLOBAL_SETTINGS.hooks, PreToolUse: [] } } }),
    );
    expect(v.missingHookEvents).toContain('PreToolUse');
  });

  it('never invents a hook block when the GLOBAL settings carry none', () => {
    const v = checkSessionConfigIntegrity(
      state({ settings: HEALTHY_SETTINGS, globalSettings: { theme: 'dark' }, claudeJson: { mcpServers: { [PSU_MCP_SERVER]: {} } } }),
    );
    expect(v.missingHookEvents).toEqual([]);
    expect(v.ok).toBe(true);
  });

  // ── WI-4617 client-awareness. A Codex session has NO Claude-shaped per-session
  //    config dir (its config lives in `$CODEX_HOME/config.toml` + `hooks.json`,
  //    a different root entirely), so both `settings` and `claudeJson` read as
  //    null. Pre-fix, that reported EVERY globally-defined hook missing plus the
  //    coordination MCP absent — a WI-4562 false positive against a healthy
  //    session that cannot be affected by the Claude-only failure mode. The
  //    check now short-circuits on `clientKind !== 'claude'`.

  it('WI-4617: short-circuits ok:true for a non-Claude client (Codex), even with null docs', () => {
    const v = checkSessionConfigIntegrity(
      state({ settings: null, claudeJson: null, clientKind: 'unknown' }),
    );
    expect(v).toEqual({
      ok: true,
      missingHookEvents: [],
      mcpServerMissing: false,
      permissionsDowngraded: false,
      consequences: [],
    });
  });

  it('WI-4617: still diagnoses a genuinely clobbered CLAUDE session even when null-empty', () => {
    // A clobbered session where the settings and claudeJson files were WIPED —
    // clientKind: 'claude' means the per-session Claude dir is still present, so
    // the check must NOT short-circuit; the WI-4562 diagnosis stands.
    const v = checkSessionConfigIntegrity(
      state({ settings: null, claudeJson: null, clientKind: 'claude' }),
    );
    expect(v.ok).toBe(false);
    expect(v.missingHookEvents.length).toBeGreaterThan(0);
    expect(v.mcpServerMissing).toBe(true);
  });
});

describe('computeSessionConfigRepair', () => {
  it('restores the FULL hook block — not just SessionStart, which the old in-hook self-heal did', () => {
    const r = computeSessionConfigRepair(state());
    const hooks = (r.settings as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    // The locks + memory hooks are the whole point; a SessionStart-only repair leaves them dead.
    expect(JSON.stringify(hooks)).toMatch(/pretooluse-locks-acquire/);
    expect(JSON.stringify(hooks)).toMatch(/userpromptsubmit-memory/);
  });

  it('PRESERVES the Claude-Code-owned keys it found (never a counter-clobber)', () => {
    const r = computeSessionConfigRepair(state());
    expect(r.settings).toMatchObject({
      model: 'opus[1m]',
      effortLevel: 'xhigh',
      skipDangerousModePermissionPrompt: true,
      theme: 'dark',
    });
  });

  it('restores the papercusp-su MCP server but NOT playwright (P-020 prunes it deliberately)', () => {
    const r = computeSessionConfigRepair(state());
    const servers = (r.claudeJson as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(servers[PSU_MCP_SERVER]).toEqual(GLOBAL_CLAUDE_JSON.mcpServers[PSU_MCP_SERVER]);
    expect(servers.playwright).toBeUndefined();
  });

  it('re-asserts the bypassPermissions grant', () => {
    const r = computeSessionConfigRepair(state());
    expect(r.settings).toMatchObject({ permissions: { defaultMode: 'bypassPermissions' } });
  });

  it('reports exactly what it fixed', () => {
    const r = computeSessionConfigRepair(state());
    expect(r.fixed).toContain('hooks.PreToolUse');
    expect(r.fixed).toContain('permissions.defaultMode');
    expect(r.fixed).toContain(`mcpServers.${PSU_MCP_SERVER}`);
  });

  it('is a no-op on a healthy session (never rewrites a file that does not need it)', () => {
    const r = computeSessionConfigRepair(
      state({ settings: HEALTHY_SETTINGS, claudeJson: { mcpServers: { [PSU_MCP_SERVER]: {} } } }),
    );
    expect(r).toEqual({ settings: null, claudeJson: null, fixed: [] });
  });

  it('is idempotent — repairing a repaired config changes nothing further', () => {
    const first = computeSessionConfigRepair(state());
    const second = computeSessionConfigRepair(
      state({ settings: first.settings, claudeJson: first.claudeJson }),
    );
    expect(second.fixed).toEqual([]);
  });
});

/**
 * The fs-write half — repairSessionConfigOnDisk — is what makes coord:orient auto-repair
 * rather than only warn. These tests lay a clobbered session down in a temp HOME, run the
 * real disk repair, and assert on disk truth (re-read), not intent.
 */
describe('repairSessionConfigOnDisk', () => {
  const SID = 'su-test-de1a1104-0000-0000-0000-000000000000';
  let home: string;

  const layGlobals = () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(GLOBAL_SETTINGS, null, 2));
    writeFileSync(join(home, '.claude.json'), JSON.stringify(GLOBAL_CLAUDE_JSON, null, 2));
  };
  const laySession = (settings: unknown, claudeJson: unknown) => {
    const dir = join(home, '.papercusp', 'session-claude', SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(claudeJson, null, 2));
    return dir;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wi4562-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('repairs a clobbered session on disk so a RE-READ passes integrity', () => {
    layGlobals();
    const dir = laySession(CLOBBERED_SETTINGS, { mcpServers: {} });

    const res = repairSessionConfigOnDisk(SID, home);

    expect(res.repaired).toBe(true);
    expect(res.wrote.sort()).toEqual(['.claude.json', 'settings.json']);
    expect(res.stillBroken).toEqual([]);
    // Disk truth: reloading the just-written files must satisfy the checker.
    expect(checkSessionConfigIntegrity(loadSessionConfigState(SID, home)).ok).toBe(true);
    // And CC-owned keys survived the rewrite.
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(written).toMatchObject({ model: 'opus[1m]', effortLevel: 'xhigh', theme: 'dark' });
  });

  it('keeps the clobbered original as a *.pre-wi4562.bak (never silently overwrites)', () => {
    layGlobals();
    const dir = laySession(CLOBBERED_SETTINGS, { mcpServers: {} });

    repairSessionConfigOnDisk(SID, home);

    expect(existsSync(join(dir, 'settings.json.pre-wi4562.bak'))).toBe(true);
    const bak = JSON.parse(readFileSync(join(dir, 'settings.json.pre-wi4562.bak'), 'utf8'));
    expect(bak).toEqual(CLOBBERED_SETTINGS); // the backup is the pre-repair content, verbatim
  });

  it('surfaces the two residual caveats a disk write cannot undo (SessionStart re-fire + MCP reconnect)', () => {
    layGlobals();
    laySession(CLOBBERED_SETTINGS, { mcpServers: {} });

    const res = repairSessionConfigOnDisk(SID, home);

    expect(res.residualCaveats.join(' ')).toMatch(/epoch bump/);
    expect(res.residualCaveats.join(' ')).toMatch(/reconnect/);
  });

  it('is a no-op on a healthy session — writes nothing, makes no backup', () => {
    layGlobals();
    const dir = laySession(HEALTHY_SETTINGS, { mcpServers: { [PSU_MCP_SERVER]: {} } });

    const res = repairSessionConfigOnDisk(SID, home);

    expect(res).toEqual({ repaired: false, fixed: [], wrote: [], stillBroken: [], residualCaveats: [] });
    expect(existsSync(join(dir, 'settings.json.pre-wi4562.bak'))).toBe(false);
  });

  it('is idempotent on disk — a second repair finds nothing to do', () => {
    layGlobals();
    laySession(CLOBBERED_SETTINGS, { mcpServers: {} });

    repairSessionConfigOnDisk(SID, home);
    const second = repairSessionConfigOnDisk(SID, home);

    expect(second.repaired).toBe(false);
    expect(second.wrote).toEqual([]);
  });

  // ── WI-4617 client-awareness on disk. A Codex session has no
  //    `~/.papercusp/session-claude/<ownerId>/` directory at all. Pre-fix, orient
  //    still ran the Claude-shaped check on Codex ownerIds and got a red block —
  //    it now sees clientKind:'unknown' and does nothing.

  it('WI-4617: loadSessionConfigState infers clientKind:unknown when the Claude dir is absent', () => {
    layGlobals();
    // Intentionally lay NO session-claude/<SID>/ directory.
    const s = loadSessionConfigState(SID, home);
    expect(s.clientKind).toBe('unknown');
    expect(s.settings).toBeNull();
    expect(s.claudeJson).toBeNull();
    // The globals are still readable — the check that would run against a
    // Claude session is still SOURCED, just gated off by clientKind.
    expect(s.globalSettings).not.toBeNull();
    expect(s.globalClaudeJson).not.toBeNull();
  });

  it('WI-4617: loadSessionConfigState infers clientKind:claude when the Claude dir exists', () => {
    layGlobals();
    laySession(HEALTHY_SETTINGS, { mcpServers: { [PSU_MCP_SERVER]: {} } });
    const s = loadSessionConfigState(SID, home);
    expect(s.clientKind).toBe('claude');
  });

  it('WI-4617: repairSessionConfigOnDisk is a NO-OP for a Codex-shaped session (no Claude dir)', () => {
    layGlobals();
    // No session-claude/<SID>/ dir laid down — this is what a Codex session looks
    // like from this checker's perspective.
    const res = repairSessionConfigOnDisk(SID, home);
    expect(res).toEqual({ repaired: false, fixed: [], wrote: [], stillBroken: [], residualCaveats: [] });
    // And crucially, checking the loaded state passes ok:true — the orient
    // handler's `if (!verdict.ok)` gate therefore never surfaces a spurious
    // configIntegrity block against a Codex session.
    expect(checkSessionConfigIntegrity(loadSessionConfigState(SID, home)).ok).toBe(true);
  });
});
