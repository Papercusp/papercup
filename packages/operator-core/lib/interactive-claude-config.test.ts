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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { writeInteractiveClaudeConfig } from './interactive-claude-config';

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
  writeFileSync(join(c, 'commands', 'foo.md'), '# /foo');
  // The user's PERSONAL global memory — must NOT leak into a psu session
  // (psu-isolation P-002 / D-001). On this box CLAUDE.md = `@AGENTS.md`.
  writeFileSync(join(c, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(c, 'AGENTS.md'), '# Personal rules\nAlways edit topic files, never MEMORY.md.\n');
  // A PEER's transcript already in the shared store — must NOT appear isolated.
  writeFileSync(join(c, 'projects', 'proj-hash', 'peer-uuid.jsonl'), '{"peer":1}');
  writeFileSync(join(h, '.claude.json'), '{"mcpServers":{"papercusp-su":{}}}');
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

  it('symlinks the user config (creds / settings / plugins / commands) — NOT a creds-only dir', () => {
    seedHome(home);
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-1', home });
    for (const entry of ['.credentials.json', 'settings.json', 'plugins', 'commands']) {
      const dest = join(configDir, entry);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(home, '.claude', entry));
    }
    // The lock-hook settings + a plugin resolve THROUGH the symlink (the user's
    // file-lock hooks + skills are intact — the whole point vs. the bee path).
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toContain('PreToolUse');
    expect(readFileSync(join(configDir, 'plugins', 'config.json'), 'utf8')).toContain('verdict');
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
    // But auth + hooks + tools still link through (isolation is surgical, not a
    // creds-only strip): the personal-memory skip must not collateral-damage these.
    expect(lstatSync(join(configDir, '.credentials.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(true);
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
    // Symlinks still resolve (not duplicated / broken).
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(true);
  });

  it('degrades gracefully when the source ~/.claude does not exist (fresh box)', () => {
    // home has NO .claude / .claude.json seeded.
    const { configDir } = writeInteractiveClaudeConfig({ sid: 'su-5', home });
    expect(existsSync(configDir)).toBe(true);
    // Still gets an isolated transcript store; just no symlinks to mirror.
    expect(lstatSync(join(configDir, 'projects')).isDirectory()).toBe(true);
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
  });
});
