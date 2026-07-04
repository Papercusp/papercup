/**
 * Codex slash-tool prompt emitter (slash-exposure-tool-catalog-2026-06-12
 * P-009): per-tool prompt files in $CODEX_HOME/prompts, marker-independent
 * from the saved-prompts emitter sharing the same flat dir, flag-gated,
 * and measured (the P-009 materialization-time check runs over the REAL
 * registered catalog).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { listMcpProjections, registerProjectedTool } from '@papercusp/agent-mcp';
import {
  SLASH_TOOL_MARKER,
  codexSlashFileBase,
  emitCodexSlashToolPrompts,
} from './slash-tool-prompts-codex';
import { MANAGED_MARKER, pruneManagedCommands } from './saved-prompts-projection';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-slash-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  setFlagOverridesForTest(null);
});

describe('marker independence (order-independent shared dir)', () => {
  it('the two managed markers do not contain each other', () => {
    expect(SLASH_TOOL_MARKER.includes(MANAGED_MARKER)).toBe(false);
    expect(MANAGED_MARKER.includes(SLASH_TOOL_MARKER)).toBe(false);
  });

  it("saved-prompts' prune leaves slash-tool files alone", async () => {
    await emitCodexSlashToolPrompts(home);
    const dir = join(home, 'prompts');
    const before = readdirSync(dir).length;
    expect(before).toBeGreaterThan(0);
    // The saved-prompts prune with an empty keep-set would delete every
    // file IT owns — ours must all survive.
    pruneManagedCommands(dir, new Set());
    expect(readdirSync(dir).length).toBe(before);
  });
});

describe('codexSlashFileBase', () => {
  it('collapses colons and dots to dashes', () => {
    expect(codexSlashFileBase('tool:plans:list')).toBe('tool-plans-list');
    expect(codexSlashFileBase('tool:repomix.pack')).toBe('tool-repomix-pack');
  });
});

describe('emitCodexSlashToolPrompts', () => {
  it('emits the full visible catalog within budget (P-009 measurement)', async () => {
    const result = await emitCodexSlashToolPrompts(home);
    const catalogSize = listMcpProjections().length;
    expect(result.written).toBeGreaterThan(0);
    expect(result.written).toBeLessThanOrEqual(catalogSize);
    // Measurement assertion: emitting the real catalog must stay well under
    // a launch-noticeable budget. (Observed ~tens of ms for a full set;
    // 5s is the give-up line — if this trips, the P-009 volume concern is
    // real and goes back to the owner per the plan.)
    expect(result.ms).toBeLessThan(5_000);
    // eslint-disable-next-line no-console
    process.stderr.write(
      `[measure] codex slash emit: ${result.written} files in ${Math.round(result.ms)}ms\n`,
    );
  });

  it('writes the instruction body with $ARGUMENTS and the managed marker', async () => {
    registerProjectedTool({
      pluginName: 'agent-mcp',
      description: 'Demo tool.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      capabilities: ['demo:read' as never],
      expose: { mcp: { name: 'demoslash:codex' }, http: { path: '/api/agent-tools/demoslash/codex' } },
      fn: async () => ({ content: [] }),
    });
    await emitCodexSlashToolPrompts(home);
    const text = readFileSync(join(home, 'prompts', 'tool-demoslash-codex.md'), 'utf8');
    expect(text.startsWith(SLASH_TOOL_MARKER)).toBe(true);
    expect(text).toContain('`demoslash:codex`');
    expect(text).toContain('$ARGUMENTS');
    expect(text).toMatch(/ask the user/);
  });

  it('role-filters the emitted set like tools/list', async () => {
    registerProjectedTool({
      pluginName: 'agent-mcp',
      description: 'Operator-only tool.',
      inputSchema: { type: 'object', properties: {} },
      capabilities: ['ops:write' as never],
      agentRoles: ['operator'] as never,
      expose: { mcp: { name: 'opsslash:only' }, http: { path: '/api/agent-tools/opsslash/only' } },
      fn: async () => ({ content: [] }),
    });
    await emitCodexSlashToolPrompts(home, 'worker' as never);
    const files = readdirSync(join(home, 'prompts'));
    expect(files).not.toContain('tool-opsslash-only.md');

    await emitCodexSlashToolPrompts(home, 'operator' as never);
    expect(readdirSync(join(home, 'prompts'))).toContain('tool-opsslash-only.md');
  });

  it('prunes stale tool files when the visible set shrinks (role change)', async () => {
    registerProjectedTool({
      pluginName: 'agent-mcp',
      description: 'Operator-only tool.',
      inputSchema: { type: 'object', properties: {} },
      capabilities: ['ops:write' as never],
      agentRoles: ['operator'] as never,
      expose: { mcp: { name: 'opsslash:prune' }, http: { path: '/api/agent-tools/opsslash/prune' } },
      fn: async () => ({ content: [] }),
    });
    await emitCodexSlashToolPrompts(home, 'operator' as never);
    expect(readdirSync(join(home, 'prompts'))).toContain('tool-opsslash-prune.md');
    const r = await emitCodexSlashToolPrompts(home, 'worker' as never);
    expect(r.pruned).toBeGreaterThan(0);
    expect(readdirSync(join(home, 'prompts'))).not.toContain('tool-opsslash-prune.md');
  });

  it('never clobbers a hand-authored file with the same name', async () => {
    registerProjectedTool({
      pluginName: 'agent-mcp',
      description: 'Clobber test.',
      inputSchema: { type: 'object', properties: {} },
      capabilities: ['demo:read' as never],
      expose: { mcp: { name: 'demoslash:clobber' }, http: { path: '/api/agent-tools/demoslash/clobber' } },
      fn: async () => ({ content: [] }),
    });
    const dir = join(home, 'prompts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tool-demoslash-clobber.md'), 'my hand-written prompt\n');
    const r = await emitCodexSlashToolPrompts(home);
    expect(r.skipped).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'tool-demoslash-clobber.md'), 'utf8')).toBe(
      'my hand-written prompt\n',
    );
  });

  it('flag off: writes nothing and prunes previously-emitted files', async () => {
    await emitCodexSlashToolPrompts(home);
    expect(readdirSync(join(home, 'prompts')).length).toBeGreaterThan(0);
    setFlagOverridesForTest({ [FLAGS.SLASH_EXPOSURE]: false });
    const r = await emitCodexSlashToolPrompts(home);
    expect(r.written).toBe(0);
    expect(r.pruned).toBeGreaterThan(0);
    expect(readdirSync(join(home, 'prompts')).filter((f) => f.endsWith('.md')).length).toBe(0);
  });
});
