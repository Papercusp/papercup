/**
 * Unit tests for the saved-prompts projector — the pure PG-row → on-disk
 * command-file layer. No PG, no Docker: render + filesystem behavior only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePromptName,
  renderClaudeCommand,
  renderCodexPrompt,
  writeManagedCommandFile,
  removeManagedCommandFile,
  pruneManagedCommands,
  writeClaudeCommands,
  writeCodexPrompts,
  MANAGED_MARKER,
  type ProjectablePrompt,
} from './saved-prompts-projection';

const full: ProjectablePrompt = {
  name: 'ship-it',
  body: 'Review the diff for $ARGUMENTS and ship if green.',
  description: 'Review + ship a change',
  argHint: '<area>',
};
const bare: ProjectablePrompt = { name: 'note', body: 'Jot a note.' };

describe('validatePromptName', () => {
  it('accepts lowercase kebab/alnum names', () => {
    expect(validatePromptName('ship-it')).toBe(true);
    expect(validatePromptName('a')).toBe(true);
    expect(validatePromptName('plan9')).toBe(true);
  });
  it('rejects empty, uppercase, leading dash, spaces, and path separators', () => {
    expect(validatePromptName('')).toBe(false);
    expect(validatePromptName('Ship')).toBe(false);
    expect(validatePromptName('-x')).toBe(false);
    expect(validatePromptName('a b')).toBe(false);
    expect(validatePromptName('a/b')).toBe(false);
    expect(validatePromptName('a.md')).toBe(false);
  });
});

describe('renderClaudeCommand', () => {
  it('emits YAML frontmatter (description + argument-hint), the managed marker, then the body', () => {
    const out = renderClaudeCommand(full);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('description: Review + ship a change');
    expect(out).toContain('argument-hint: <area>');
    expect(out).toContain(MANAGED_MARKER);
    expect(out).toContain('Review the diff for $ARGUMENTS and ship if green.');
    // marker sits after the closing frontmatter fence, before the body
    expect(out.indexOf(MANAGED_MARKER)).toBeGreaterThan(out.lastIndexOf('---'));
    expect(out.indexOf(MANAGED_MARKER)).toBeLessThan(out.indexOf('Review the diff'));
    expect(out.endsWith('\n')).toBe(true);
  });
  it('omits the frontmatter block when there is no description or arg hint, but still marks the file', () => {
    const out = renderClaudeCommand(bare);
    expect(out.startsWith('---')).toBe(false);
    expect(out).toContain(MANAGED_MARKER);
    expect(out).toContain('Jot a note.');
  });
});

describe('renderCodexPrompt', () => {
  it('emits a marked plain-markdown body with no YAML frontmatter (Codex takes the filename as the command)', () => {
    const out = renderCodexPrompt(full);
    expect(out.startsWith('---')).toBe(false);
    expect(out).not.toContain('argument-hint:');
    expect(out).toContain(MANAGED_MARKER);
    expect(out).toContain('Review the diff for $ARGUMENTS and ship if green.');
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('writeManagedCommandFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-proj-'));
  });

  it('creates a new file and reports it written', () => {
    const res = writeManagedCommandFile(dir, 'ship-it.md', renderClaudeCommand(full));
    expect(res.written).toBe(true);
    expect(readFileSync(join(dir, 'ship-it.md'), 'utf8')).toContain(MANAGED_MARKER);
  });

  it('creates missing parent directories', () => {
    const nested = join(dir, '.claude', 'commands');
    const res = writeManagedCommandFile(nested, 'note.md', renderClaudeCommand(bare));
    expect(res.written).toBe(true);
    expect(existsSync(join(nested, 'note.md'))).toBe(true);
  });

  it('refuses to overwrite an existing file that lacks the managed marker', () => {
    writeFileSync(join(dir, 'ship-it.md'), '# hand-authored, do not touch\n');
    const res = writeManagedCommandFile(dir, 'ship-it.md', renderClaudeCommand(full));
    expect(res.written).toBe(false);
    expect(res.reason).toBe('unmanaged_exists');
    expect(readFileSync(join(dir, 'ship-it.md'), 'utf8')).toBe('# hand-authored, do not touch\n');
  });

  it('overwrites an existing file that carries the managed marker', () => {
    writeManagedCommandFile(dir, 'ship-it.md', renderClaudeCommand(full));
    const next = renderClaudeCommand({ ...full, body: 'updated body' });
    const res = writeManagedCommandFile(dir, 'ship-it.md', next);
    expect(res.written).toBe(true);
    expect(readFileSync(join(dir, 'ship-it.md'), 'utf8')).toContain('updated body');
  });
});

describe('removeManagedCommandFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-proj-'));
  });

  it('removes a managed file', () => {
    writeManagedCommandFile(dir, 'ship-it.md', renderClaudeCommand(full));
    const res = removeManagedCommandFile(dir, 'ship-it.md');
    expect(res.removed).toBe(true);
    expect(existsSync(join(dir, 'ship-it.md'))).toBe(false);
  });

  it('leaves an unmanaged file untouched', () => {
    writeFileSync(join(dir, 'ship-it.md'), '# hand-authored\n');
    const res = removeManagedCommandFile(dir, 'ship-it.md');
    expect(res.removed).toBe(false);
    expect(existsSync(join(dir, 'ship-it.md'))).toBe(true);
  });

  it('is a no-op (not an error) when the file is absent', () => {
    const res = removeManagedCommandFile(dir, 'ghost.md');
    expect(res.removed).toBe(false);
  });
});

describe('pruneManagedCommands', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-proj-'));
    mkdirSync(dir, { recursive: true });
  });

  it('removes managed files whose basename is not in the keep-set, but keeps kept-managed and all unmanaged files', () => {
    writeManagedCommandFile(dir, 'keep.md', renderClaudeCommand({ ...full, name: 'keep' }));
    writeManagedCommandFile(dir, 'stale.md', renderClaudeCommand({ ...full, name: 'stale' }));
    writeFileSync(join(dir, 'human.md'), '# hand-authored\n');

    const res = pruneManagedCommands(dir, new Set(['keep']));

    expect(res.removed.sort()).toEqual(['stale']);
    expect(existsSync(join(dir, 'keep.md'))).toBe(true);
    expect(existsSync(join(dir, 'stale.md'))).toBe(false);
    expect(existsSync(join(dir, 'human.md'))).toBe(true);
  });

  it('is a no-op when the directory does not exist', () => {
    const res = pruneManagedCommands(join(dir, 'nope'), new Set(['x']));
    expect(res.removed).toEqual([]);
  });
});

describe('writeClaudeCommands', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-proj-'));
  });

  it('writes one Claude command file per valid row and reports the count', () => {
    const res = writeClaudeCommands(dir, [full, bare]);
    expect(res.written).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['note.md', 'ship-it.md']);
    expect(readFileSync(join(dir, 'ship-it.md'), 'utf8')).toContain('argument-hint: <area>');
  });

  it('skips rows with an invalid name without writing them', () => {
    const res = writeClaudeCommands(dir, [{ name: 'Bad Name', body: 'x' }, bare]);
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
    expect(readdirSync(dir)).toEqual(['note.md']);
  });

  it('prunes a previously-managed file whose row is no longer present', () => {
    writeClaudeCommands(dir, [full, bare]);
    const res = writeClaudeCommands(dir, [bare]);
    expect(existsSync(join(dir, 'ship-it.md'))).toBe(false);
    expect(existsSync(join(dir, 'note.md'))).toBe(true);
    expect(res.written).toBe(1);
  });
});

describe('writeCodexPrompts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sp-proj-'));
  });

  it('writes marked plain-markdown prompt files with no frontmatter', () => {
    const res = writeCodexPrompts(dir, [full]);
    expect(res.written).toBe(1);
    const out = readFileSync(join(dir, 'ship-it.md'), 'utf8');
    expect(out.startsWith('---')).toBe(false);
    expect(out).toContain(MANAGED_MARKER);
    expect(out).not.toContain('argument-hint:');
  });
});
