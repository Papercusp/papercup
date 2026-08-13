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
  checkSessionConfigIntegrityForClient,
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
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'posttooluse-activity-report.sh' }] }],
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
  // WI-38349: the documents above were read from an OBSERVED dir. A state whose
  // configDir is null means "we never found the session's dir" and is a different
  // claim entirely — see the UNKNOWN describe block below.
  configDir: '/observed/session-claude/su-x',
  configDirSource: 'live-process',
  configDirUnresolvedReason: null,
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
      state({
        settings: HEALTHY_SETTINGS,
        globalSettings: { theme: 'dark' },
        claudeJson: { mcpServers: { [PSU_MCP_SERVER]: {} } },
      }),
    );
    expect(v.missingHookEvents).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('still diagnoses a genuinely clobbered Claude session when both documents are gone', () => {
    const v = checkSessionConfigIntegrity(state({ settings: null, claudeJson: null }));
    expect(v.ok).toBe(false);
    expect(v.missingHookEvents.length).toBeGreaterThan(0);
    expect(v.mcpServerMissing).toBe(true);
  });
});

describe('checkSessionConfigIntegrityForClient', () => {
  it.each(['codex', 'omp'])('skips the Claude-shaped check for recorded %s sessions', (client) => {
    expect(checkSessionConfigIntegrityForClient(state(), client)).toBeNull();
  });

  it('does not let a stale Claude config directory override a recorded Codex identity', () => {
    expect(checkSessionConfigIntegrityForClient(state(), 'codex')).toBeNull();
  });

  it('checks a recorded Claude session even when both session documents are missing', () => {
    const v = checkSessionConfigIntegrityForClient(state({ settings: null, claudeJson: null }), 'claude');
    expect(v).toMatchObject({ ok: false, mcpServerMissing: true });
  });

  it('checks legacy sessions only when Claude-shaped documents provide positive evidence', () => {
    expect(checkSessionConfigIntegrityForClient(state(), null)?.ok).toBe(false);
    expect(checkSessionConfigIntegrityForClient(state({ settings: null, claudeJson: null }), null)).toBeNull();
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
    const second = computeSessionConfigRepair(state({ settings: first.settings, claudeJson: first.claudeJson }));
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

    expect(res).toEqual({
      repaired: false,
      fixed: [],
      wrote: [],
      stillBroken: [],
      residualCaveats: [],
      skipped: 'nothing broken',
    });
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

  it('loads null session documents when the Claude directory is absent', () => {
    layGlobals();
    const s = loadSessionConfigState(SID, home);
    expect(s.settings).toBeNull();
    expect(s.claudeJson).toBeNull();
    expect(s.globalSettings).not.toBeNull();
    expect(s.globalClaudeJson).not.toBeNull();
    // WI-38349: and it says WHY they are null — no dir was observed, so the nulls are
    // about our lookup, not about the session.
    expect(s.configDir).toBeNull();
    expect(s.configDirUnresolvedReason).toMatch(/WI-38349/);
  });

  it('repair is a no-op for an explicitly recorded Codex session', () => {
    layGlobals();
    laySession(CLOBBERED_SETTINGS, { mcpServers: {} }); // stale unrelated Claude docs
    const res = repairSessionConfigOnDisk(SID, home, 'codex');
    expect(res).toMatchObject({ repaired: false, fixed: [], wrote: [], stillBroken: [] });
    expect(res.skipped).toMatch(/non-Claude/);
  });
});

/**
 * WI-38349 — the detector used to resolve a session's config dir by FORMULA
 * (`session-claude/<coordOwnerId>`), read two nulls out of a directory that never
 * existed on the dominant launch path, and report a healthy session as
 * "RUNNING DE-ENROLLED … treat every edit as unprotected". 78 of 98 owner ids
 * active in a 6h window matched that shape.
 *
 * The guard is: an UNOBSERVED dir is UNKNOWN, never damage — and a repair may not
 * write into a directory it never found.
 */
describe('WI-38349 — an unresolvable config dir is UNKNOWN, not de-enrollment', () => {
  const unresolved = (over: Partial<SessionConfigState> = {}): SessionConfigState =>
    state({
      settings: null,
      claudeJson: null,
      configDir: null,
      configDirSource: null,
      configDirUnresolvedReason: 'no observable config dir for su-x (WI-38349)',
      ...over,
    });

  it('reports unknown — and emits NO consequences, so nothing can render it as an alarm', () => {
    const v = checkSessionConfigIntegrity(unresolved());
    expect(v.unknown).toBe(true);
    expect(v.unknownReason).toMatch(/WI-38349/);
    expect(v.consequences).toEqual([]);
    expect(v.missingHookEvents).toEqual([]);
    expect(v.mcpServerMissing).toBe(false);
  });

  it('CONTROL: the same two null documents from an OBSERVED dir are still real damage', () => {
    // The calibration case — without it, the guard above would also "pass" if the
    // checker had simply stopped detecting anything (WI-4617's deliberate case:
    // a recorded Claude session whose whole directory really was deleted).
    const v = checkSessionConfigIntegrity(state({ settings: null, claudeJson: null }));
    expect(v.unknown).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.mcpServerMissing).toBe(true);
    expect(v.consequences.length).toBeGreaterThan(0);
  });

  it('the client-aware entry point propagates unknown for a recorded claude session', () => {
    const v = checkSessionConfigIntegrityForClient(unresolved(), 'claude');
    expect(v).toMatchObject({ unknown: true, consequences: [] });
  });

  it('a repair REFUSES an unobserved dir rather than materializing a phantom one', () => {
    const home = mkdtempSync(join(tmpdir(), 'wi38349-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(GLOBAL_SETTINGS, null, 2));
      writeFileSync(join(home, '.claude.json'), JSON.stringify(GLOBAL_CLAUDE_JSON, null, 2));

      const SID = 'su-never-materialized-0000';
      const res = repairSessionConfigOnDisk(SID, home, 'claude');

      expect(res.repaired).toBe(false);
      expect(res.skipped).toMatch(/config dir not observable/);
      // The phantom path is the whole point: a "repair" must not create it.
      expect(existsSync(join(home, '.papercusp', 'session-claude', SID))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never reports repaired:false with an EMPTY stillBroken and no reason — the contradiction orient rendered', () => {
    const home = mkdtempSync(join(tmpdir(), 'wi38349-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(GLOBAL_SETTINGS, null, 2));
      writeFileSync(join(home, '.claude.json'), JSON.stringify(GLOBAL_CLAUDE_JSON, null, 2));

      const res = repairSessionConfigOnDisk('su-never-materialized-0001', home, 'claude');

      // orient selected "auto-repair did NOT fully succeed — see stillBroken" from
      // exactly this shape, pointing the reader at an empty list.
      expect(res.stillBroken).toEqual([]);
      expect(res.skipped).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
