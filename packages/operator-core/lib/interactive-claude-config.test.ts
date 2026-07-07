/**
 * interactive-claude-config.test.ts — the EI-155 interactive-claude
 * CLAUDE_CONFIG_DIR materializer (unify-launch-mechanics D-002, the C1/C5
 * cross-agent isolation class).
 *
 * The contract under test: an interactive claude session gets a per-session
 * config dir that is a SYMLINK MIRROR of the user's ~/.claude with exactly one
 * thing isolated — the `projects/` transcript store — plus the sibling
 * ~/.claude.json symlinked in. That is what keeps the user-level MCP / lock
 * hooks / plugins / onboarding-trust while giving the session its OWN transcript
 * store (so `/resume` + wake-by-uuid never reach a peer's conversation, the
 * EI-153 root). A creds-only dir (the headless bee path) would strip all of the
 * above for a human session — these tests pin that it does NOT.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import {
  RECOVER_HOOK,
  RECOVER_INTENT,
  RECOVER_PLAYBOOK,
  writeInteractiveClaudeConfig,
} from './interactive-claude-config';

const savedRoot = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
let root: string; // the per-session CLAUDE_CONFIG_DIR root (override)
let home: string; // a fake source HOME with a populated ~/.claude

/** Build a realistic fake source HOME: ~/.claude/{.credentials.json, settings.json,
 *  plugins/, commands/, projects/<hash>/<uuid>.jsonl} + ~/.claude.json. */
function seedHome(h: string) {
  const c = join(h, '.claude');
  mkdirSync(join(c, 'plugins'), { recursive: true });
  mkdirSync(join(c, 'commands'), { recursive: true });
  mkdirSync(join(c, 'projects', 'proj-hash'), { recursive: true });
  writeFileSync(join(c, '.credentials.json'), '{"token":"REAL"}');
  writeFileSync(join(c, 'settings.json'), '{"hooks":{"PreToolUse":[]}}');
  writeFileSync(join(c, 'plugins', 'config.json'), '{"verdict":true}');
  // P-020 prune fixtures: a realistic installed_plugins registry + a heavy mcpServer.
  writeFileSync(
    join(c, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'github@claude-plugins-official': [{ scope: 'user' }],
        'cloudflare@claude-plugins-official': [{ scope: 'user' }],
        'firecrawl@claude-plugins-official': [{ scope: 'user' }],
        'context7@claude-plugins-official': [{ scope: 'user' }],
      },
    }),
  );
  writeFileSync(join(c, 'commands', 'foo.md'), '# /foo');
  // The user's PERSONAL global memory — must NOT leak into a psu session
  // (psu-isolation P-002 / D-001). On this box CLAUDE.md = `@AGENTS.md`.
  writeFileSync(join(c, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(c, 'AGENTS.md'), '# Personal rules\nAlways edit topic files, never MEMORY.md.\n');
  // A PEER's transcript already in the shared store — must NOT appear isolated.
  writeFileSync(join(c, 'projects', 'proj-hash', 'peer-uuid.jsonl'), '{"peer":1}');
  writeFileSync(join(h, '.claude.json'), '{"mcpServers":{"papercusp-su":{},"playwright":{}}}');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icc-root-'));
  home = mkdtempSync(join(tmpdir(), 'icc-home-'));
  process.env.PAPERCUSP_SESSION_CLAUDE_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
  else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = savedRoot;
});

describe('writeInteractiveClaudeConfig', () => {
  it('keys the dir by sid via the shared helper (launch ↔ resume agree)', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-abc', home });
    // The same path the wake-executor resume leg computes from coord_owner_id.
    expect(configDir).toBe(sessionClaudeConfigDir('su-abc'));
    expect(configDir).toBe(join(root, 'su-abc'));
  });

  it('symlinks the user config (creds / plugins / commands) — NOT a creds-only dir', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-1', home });
    for (const entry of ['.credentials.json', 'plugins', 'commands']) {
      const dest = join(configDir, entry);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(home, '.claude', entry));
    }
    // WI-3278: settings.json is a REAL MERGED file (not a symlink) — the user's
    // lock hooks carry over AND the bypassPermissions grant is baked in, so a
    // claude self-re-exec that drops the argv flags still boots in bypass mode.
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(false);
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual([]);
    // WI-3280: the argv-drop recovery hook rides SessionStart in the same file.
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('session-recover-hook.mjs');
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(readFileSync(join(configDir, 'plugins', 'config.json'), 'utf8')).toContain('verdict');
  });

  it('WI-3278: the settings merge never writes THROUGH a pre-fix symlink into the global file', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-relink', home });
    // Simulate a pre-fix session dir: settings.json as a symlink to the global.
    rmSync(join(configDir, 'settings.json'));
    symlinkSync(join(home, '.claude', 'settings.json'), join(configDir, 'settings.json'));
    writeInteractiveClaudeConfig({ sid: 'su-relink', home });
    // Session file is now real and carries the grant…
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('bypassPermissions');
    // …and the USER'S global settings.json was not mutated.
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).not.toContain('bypassPermissions');
  });

  it('does NOT mirror the personal global memory (CLAUDE.md / AGENTS.md) — the P-002 / D-001 leak fix', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-iso', home });
    // The psu session must load NO personal memory: neither the CLAUDE.md
    // global-memory entrypoint nor its `@AGENTS.md` include target is present in
    // the config dir, so claude has no `$CLAUDE_CONFIG_DIR/CLAUDE.md` to auto-load.
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(configDir, 'AGENTS.md'))).toBe(false);
    // present() guards against a dangling symlink too — assert it's truly absent.
    expect(() => lstatSync(join(configDir, 'CLAUDE.md'))).toThrow();
    // But auth + hooks + tools still carry through (isolation is surgical, not a
    // creds-only strip): the personal-memory skip must not collateral-damage these.
    expect(lstatSync(join(configDir, '.credentials.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('PreToolUse');
  });

  it('symlinks the sibling ~/.claude.json (user-level MCP + onboarding/trust carry through)', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-2', home });
    const dest = join(configDir, '.claude.json');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(home, '.claude.json'));
    expect(readFileSync(dest, 'utf8')).toContain('papercusp-su');
  });

  it('isolates projects/: a REAL dir, and the shared store’s transcript is NOT visible', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-3', home });
    const projects = join(configDir, 'projects');
    // A real directory, never a symlink to the shared store.
    expect(lstatSync(projects).isSymbolicLink()).toBe(false);
    expect(lstatSync(projects).isDirectory()).toBe(true);
    // The peer's transcript that exists in the shared ~/.claude/projects is NOT
    // reachable here — this session writes its own transcripts in isolation.
    expect(existsSync(join(projects, 'proj-hash', 'peer-uuid.jsonl'))).toBe(false);
  });

  it('cross-agent isolation: two sids get distinct dirs with independent transcript stores', () => {
    seedHome(home);
    const a = writeInteractiveClaudeConfig({ sid: 'su-A', home }).configDir;
    const b = writeInteractiveClaudeConfig({ sid: 'su-B', home }).configDir;
    expect(a).not.toBe(b);
    // A writes a transcript; B must never see it (no cross-session bleed).
    writeFileSync(join(a, 'projects', 'a-session.jsonl'), '{"a":1}');
    expect(existsSync(join(b, 'projects', 'a-session.jsonl'))).toBe(false);
  });

  it('is idempotent — a re-materialize (the resume leg) never clobbers an existing transcript', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-4', home });
    // The session wrote a transcript after launch.
    writeFileSync(join(configDir, 'projects', 'live.jsonl'), '{"turn":1}');
    // Resume re-materializes the SAME dir — must be a no-op for projects/.
    const again = writeInteractiveClaudeConfig({ sid: 'su-4', home });
    expect(again.configDir).toBe(configDir);
    expect(readFileSync(join(configDir, 'projects', 'live.jsonl'), 'utf8')).toBe('{"turn":1}');
    // The merged settings file still resolves with the grant (WI-3278 rewrites
    // it each materialize — never through a symlink, never broken).
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('bypassPermissions');
  });

  it('degrades gracefully when the source ~/.claude does not exist (fresh box)', () => {
    // home has NO .claude / .claude.json seeded.
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-5', home });
    expect(existsSync(configDir)).toBe(true);
    // Still gets an isolated transcript store; just no symlinks to mirror.
    expect(lstatSync(join(configDir, 'projects')).isDirectory()).toBe(true);
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
    // WI-3278: the fresh Windows VM had no global settings.json — the session
    // must STILL get the bypassPermissions grant.
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('prunePlugins (context-trimming-tiers P-020): fleet members lose github/cloudflare/firecrawl + playwright, keep context7 + papercusp-su', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-prune', home, prunePlugins: true });
    // plugins/ is a REAL dir: children link through, the registry is filtered.
    const reg = JSON.parse(
      readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(reg.plugins)).toEqual(['context7@claude-plugins-official']);
    expect(readFileSync(join(configDir, 'plugins', 'config.json'), 'utf8')).toContain('verdict');
    // .claude.json is a filtered REAL copy: playwright gone, papercusp-su kept.
    const cj = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cj.mcpServers)).toEqual(['papercusp-su']);
    // Default (no prune) stays a symlink mirror with the full registry.
    const { configDir: fullDir } = writeInteractiveClaudeConfig({ sid: 'su-full', home });
    const fullReg = JSON.parse(
      readFileSync(join(fullDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(fullReg.plugins)).toHaveLength(4);
  });
});

/**
 * WI-3280 — argv-proof playbook delivery. claude 2.1.x's self-re-exec
 * (relaunchInto → vge) rebuilds argv WITHOUT the original launch flags, so the
 * `--system-prompt-file` playbook is lost. The config dir parks a playbook
 * copy + a SessionStart hook that re-injects it when the live claude process's
 * argv no longer carries a *-system-prompt-file flag.
 */
describe('WI-3280: SessionStart playbook recovery', () => {
  /** The exact chain shapes seen live: hook ← sh ← claude ← psu.mjs. */
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--dangerously-skip-permissions',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
      '--exclude-dynamic-system-prompt-sections',
      '--session-id',
      '22fa0398-0e51-48b1-93cb-e7c8426064d1',
      '--permission-mode',
      'bypassPermissions',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DROPPED_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude'], // the re-exec'd bare argv, verbatim from /proc
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const RESUME_RELAUNCH_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude', '--resume', '22fa0398-0e51-48b1-93cb-e7c8426064d1'],
    ['node', '/mnt/c/x/psu.mjs'],
  ];

  function runHook(configDir: string, chain: string[][]): string {
    return execFileSync(process.execPath, [join(configDir, RECOVER_HOOK)], {
      encoding: 'utf8',
      input: '{"session_id":"random-new-id","source":"startup"}',
      env: { ...process.env, PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain) },
    });
  }

  function seedWithPlaybook(sid: string): string {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    }).configDir;
  }

  it('parks the playbook copy + intent and writes the hook script', () => {
    const configDir = seedWithPlaybook('su-rec1');
    expect(readFileSync(join(configDir, RECOVER_PLAYBOOK), 'utf8')).toContain('A pot is');
    const intent = JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8'));
    expect(intent.sid).toBe('su-rec1');
    expect(intent.nativeSessionId).toBe('22fa0398-0e51-48b1-93cb-e7c8426064d1');
    expect(readFileSync(join(configDir, RECOVER_HOOK), 'utf8')).toContain('argvIntact');
    // The settings hook command points node at THIS session's hook script.
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    const cmd = JSON.stringify(settings.hooks.SessionStart);
    expect(cmd).toContain(join(configDir, RECOVER_HOOK));
    expect(cmd).toContain(JSON.stringify(process.execPath).slice(1, -1));
  });

  it('appends to (never replaces) existing global SessionStart hook groups', () => {
    seedHome(home);
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
      }),
    );
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-rec2', home });
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(JSON.stringify(settings.hooks.SessionStart[0])).toContain('user-hook');
    expect(JSON.stringify(settings.hooks.SessionStart[1])).toContain(RECOVER_HOOK);
  });

  it('a resume-path re-materialize WITHOUT recovery keeps the original parked playbook', () => {
    const configDir = seedWithPlaybook('su-rec3');
    writeInteractiveClaudeConfig({ sid: 'su-rec3', home }); // wake-executor leg: no recovery opt
    expect(readFileSync(join(configDir, RECOVER_PLAYBOOK), 'utf8')).toContain('A pot is');
    expect(existsSync(join(configDir, RECOVER_INTENT))).toBe(true);
  });

  it('hook is SILENT when the claude ancestor still carries --system-prompt-file', () => {
    const configDir = seedWithPlaybook('su-rec4');
    expect(runHook(configDir, INTACT_CHAIN)).toBe('');
  });

  it('hook injects the playbook when the claude ancestor lost its argv (the VM shape)', () => {
    const configDir = seedWithPlaybook('su-rec5');
    const out = JSON.parse(runHook(configDir, DROPPED_CHAIN));
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(ctx).toContain('SESSION RECOVERED');
    expect(ctx).toContain('su-rec5'); // identity from the intent file
    expect(ctx).toContain('22fa0398-0e51-48b1-93cb-e7c8426064d1'); // recorded native id
    expect(ctx).toContain('A pot is the offline-first data substrate'); // the playbook itself
  });

  it('hook injects on the --resume relaunch branch too (argv rebuilt without the prompt flag)', () => {
    const configDir = seedWithPlaybook('su-rec6');
    const out = JSON.parse(runHook(configDir, RESUME_RELAUNCH_CHAIN));
    expect(out.hookSpecificOutput.additionalContext).toContain('A pot is');
  });

  it('hook is SILENT when no playbook was parked (role/raw dirs stay inert)', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-rec7', home });
    expect(existsSync(join(configDir, RECOVER_PLAYBOOK))).toBe(false);
    expect(runHook(configDir, DROPPED_CHAIN)).toBe('');
  });
});

/**
 * compaction-continuity-hardening-2026-07-07 P-004 (implements WI-2537) — the
 * post-compaction continuity anchor. On SessionStart[source=compact] the SAME
 * generated hook injects the orient-afterCompaction mandate + the
 * volatile-claims checklist (static, operator-down-proof) and appends the carry
 * brief fetched live from /api/agent-mcp/session-recovery-brief (fail-soft).
 */
describe('P-004: SessionStart[source=compact] continuity anchor', () => {
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DROPPED_CHAIN = [
    ['sh', '-c', 'node hook'],
    ['/home/papercup/.local/bin/claude'],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  /** A refused-connection operator URL — port 1 is never listening. */
  const DEAD_OPERATOR = 'http://127.0.0.1:1';

  function seedWithPlaybook(sid: string): string {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    }).configDir;
  }

  /** Async runner — the stub-server test must keep the parent event loop free
   *  (execFileSync would block it and deadlock the child's fetch). Overrides
   *  PAPERCUSP_SID to '' so the hook resolves the owner from the parked intent
   *  file, not this test process's own psu identity. */
  function runHookAsync(
    configDir: string,
    chain: string[][],
    input: string,
    env: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(configDir, RECOVER_HOOK)],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain),
            PAPERCUSP_SID: '',
            ...env,
          },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin!.end(input);
    });
  }

  it('compact source: injects the static anchor + the fetched carry brief (owner from intent)', async () => {
    const configDir = seedWithPlaybook('su-cmp1');
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          text: 'Armed loop @papercusp (active, every 120s). Its carry-note (written 5m ago):\n## Next action\nship P-004',
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = JSON.parse(
        await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"compact"}', {
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        }),
      );
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
      expect(ctx).toContain('coord:orient { afterCompaction: true }');
      expect(ctx).toContain('HYPOTHESES to re-verify');
      expect(ctx).toContain('Armed loop @papercusp (active, every 120s)');
      expect(ctx).toContain('ship P-004');
      // argv intact ⇒ NO playbook-recovery part alongside the anchor.
      expect(ctx).not.toContain('SESSION RECOVERED');
      // The fetch carried the intent-file owner.
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('/api/agent-mcp/session-recovery-brief?owner=su-cmp1');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('compact source with the operator DOWN: static anchor alone, exit 0 (fail-soft)', async () => {
    const configDir = seedWithPlaybook('su-cmp2');
    const out = JSON.parse(
      await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx).toContain('coord:orient { afterCompaction: true }');
    expect(ctx).not.toContain('carry brief (read live');
  });

  it('compact source + dropped argv: BOTH the playbook recovery and the anchor land, in that order', async () => {
    const configDir = seedWithPlaybook('su-cmp3');
    const out = JSON.parse(
      await runHookAsync(configDir, DROPPED_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('SESSION RECOVERED');
    expect(ctx).toContain('A pot is the offline-first data substrate');
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx.indexOf('SESSION RECOVERED')).toBeLessThan(ctx.indexOf('POST-COMPACTION CONTINUITY ANCHOR'));
  });

  it('compact source with NO parked playbook (raw dir): the anchor still lands', async () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-cmp4', home });
    const out = JSON.parse(
      await runHookAsync(configDir, DROPPED_CHAIN, '{"session_id":"x","source":"compact"}', {
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
        PAPERCUSP_SID: 'su-cmp4',
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('POST-COMPACTION CONTINUITY ANCHOR');
    expect(ctx).not.toContain('SESSION RECOVERED');
  });

  it('startup source stays SILENT on the compact path (anchor is compact-gated)', async () => {
    const configDir = seedWithPlaybook('su-cmp5');
    const out = await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
      PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
    });
    expect(out).toBe('');
  });
});

/**
 * compaction-continuity-hardening-2026-07-07 P-007 — identity durability across
 * relaunch. On EVERY SessionStart the generated hook compares the live
 * PAPERCUSP_SID against the sid recorded in the parked intent file; a mismatch
 * means every ownerId-keyed surface (armed loop, carry-note, claims, awaits,
 * fleet, held items) is stranded under a dead predecessor id. The hook
 * auto-rebinds via POST /api/agent-mcp/rebind-identity (then retires the old
 * sid in the intent file so later starts stay silent) and falls back to the
 * one-call coord:rebind-identity instruction when the operator refuses or is
 * unreachable. All fail-soft — a session start is never blocked.
 */
describe('P-007: SessionStart identity rebind (recorded sid ≠ live PAPERCUSP_SID)', () => {
  const INTACT_CHAIN = [
    ['sh', '-c', 'node hook'],
    [
      '/home/papercup/.local/bin/claude',
      '--system-prompt-file',
      '/home/papercup/.papercusp/launch-context/session-2.md',
    ],
    ['node', '/mnt/c/x/psu.mjs'],
  ];
  const DEAD_OPERATOR = 'http://127.0.0.1:1';

  function seedWithPlaybook(sid: string): string {
    seedHome(home);
    const playbookSrc = join(home, 'playbook.md');
    writeFileSync(playbookSrc, '# SU engineer playbook\nA pot is the offline-first data substrate.\n');
    return writeInteractiveClaudeConfig({
      sid,
      home,
      recovery: { playbookPath: playbookSrc, nativeSessionId: '22fa0398-0e51-48b1-93cb-e7c8426064d1' },
    }).configDir;
  }

  function runHookAsync(
    configDir: string,
    chain: string[][],
    input: string,
    env: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(configDir, RECOVER_HOOK)],
        {
          encoding: 'utf8',
          env: { ...process.env, PSU_RECOVER_TEST_CHAIN: JSON.stringify(chain), PAPERCUSP_SID: '', ...env },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin!.end(input);
    });
  }

  /** Stub operator that records rebind POSTs and answers with `response`. */
  function rebindServer(response: unknown) {
    const posts: Array<{ url: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        posts.push({ url: req.url ?? '', body: data });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
    });
    return { posts, server };
  }

  it('auto-rebinds on mismatch, reports per-surface counts, and retires the old sid in the intent file', async () => {
    const configDir = seedWithPlaybook('su-old-p7a');
    const { posts, server } = rebindServer({
      ok: true,
      from: 'su-old-p7a',
      to: 'su-new-p7a',
      surfaces: [
        { surface: 'loop-routine', moved: 1 },
        { surface: 'carry-note', moved: 2 },
        { surface: 'presence', moved: 0, dropped: 1 },
        { surface: 'awaits', moved: 0 },
      ],
      totalMoved: 4,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const env = { PAPERCUSP_SID: 'su-new-p7a', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}` };
      const out = JSON.parse(await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', env));
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('IDENTITY CHANGED ACROSS RELAUNCH');
      expect(ctx).toContain('su-old-p7a → live su-new-p7a');
      expect(ctx).toContain('AUTO-REBOUND');
      expect(ctx).toContain('loop-routine:1');
      expect(ctx).toContain('carry-note:2');
      expect(ctx).toContain('presence:1'); // dropped counts as handled
      expect(ctx).not.toContain('awaits:'); // zero-count surfaces stay out of the banner
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe('/api/agent-mcp/rebind-identity');
      expect(JSON.parse(posts[0].body)).toEqual({ from: 'su-old-p7a', to: 'su-new-p7a' });
      // The old sid is retired: the intent file now records the live id …
      const intent = JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8'));
      expect(intent.sid).toBe('su-new-p7a');
      expect(intent.nativeSessionId).toBe('22fa0398-0e51-48b1-93cb-e7c8426064d1');
      // … so the NEXT start is silent (no re-fire, no second POST).
      expect(await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', env)).toBe('');
      expect(posts).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a REFUSED rebind (from appears live) surfaces the manual instruction and keeps the recorded sid', async () => {
    const configDir = seedWithPlaybook('su-old-p7b');
    const { server } = rebindServer({ ok: false, refused: 'from_appears_live', surfaces: [], totalMoved: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = JSON.parse(
        await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
          PAPERCUSP_SID: 'su-new-p7b',
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        }),
      );
      const ctx = out.hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain('AUTO-REBIND REFUSED');
      expect(ctx).toContain("coord:rebind-identity { from: 'su-old-p7b', to: 'su-new-p7b' }");
      expect(ctx).toContain('force:true');
      expect(JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8')).sid).toBe('su-old-p7b');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('operator DOWN: the one-call instruction still lands (fail-soft, exit 0), sid stays recorded', async () => {
    const configDir = seedWithPlaybook('su-old-p7c');
    const out = JSON.parse(
      await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
        PAPERCUSP_SID: 'su-new-p7c',
        PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
      }),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('unreachable for auto-rebind');
    expect(ctx).toContain("coord:rebind-identity { from: 'su-old-p7c', to: 'su-new-p7c' }");
    expect(JSON.parse(readFileSync(join(configDir, RECOVER_INTENT), 'utf8')).sid).toBe('su-old-p7c');
  });

  it('matching live + recorded sid stays SILENT (the common start)', async () => {
    const configDir = seedWithPlaybook('su-same-p7d');
    const out = await runHookAsync(configDir, INTACT_CHAIN, '{"session_id":"x","source":"startup"}', {
      PAPERCUSP_SID: 'su-same-p7d',
      PAPERCUSP_OPERATOR_URL: DEAD_OPERATOR,
    });
    expect(out).toBe('');
  });
});
