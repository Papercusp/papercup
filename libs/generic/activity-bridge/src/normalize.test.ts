/**
 * normalize.test.ts — the cross-CLI agent-activity normalizer (the single
 * summary impl every CLI's hook shares). Pure, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  summariseActivity,
  summariseTodos,
  clip,
  basename,
  firstPath,
  commandText,
  capDetail,
} from './normalize';

describe('normalize helpers', () => {
  it('clip collapses whitespace + truncates with ellipsis', () => {
    expect(clip('  a   b\nc ', 99)).toBe('a b c');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip(null, 4)).toBe('');
  });

  // Gap-15 (off-by-one in an exported primitive): a naive `slice(0, n - 1)`
  // uses a NEGATIVE end index at n <= 0, dropping the LAST char and yielding a
  // result LONGER than the cap. The clip result must never exceed `n`.
  it('clip never exceeds the cap at the n=0/n=1 boundary', () => {
    expect(clip('hello', 1)).toBe('…'); // room for the ellipsis only
    expect(clip('hello', 0)).toBe(''); // no room → empty (was a garbled 'hell…')
    expect(clip('hello', 2)).toBe('h…');
    // negative caps degrade to empty, not to a sliced-from-the-end string.
    expect(clip('hello', -1)).toBe('');
    expect(clip('hello', -10)).toBe('');
    // a string already within the cap is returned verbatim regardless of n size.
    expect(clip('', 0)).toBe('');
    expect(clip('x', 1)).toBe('x');
    // the result length is bounded by n for every cap from 0..len.
    for (let n = 0; n <= 6; n++) {
      expect([...clip('hello', n)].length).toBeLessThanOrEqual(Math.max(n, 0));
    }
  });

  // Confirm the INTERNAL large-n callers (SUMMARY_CLIP=72 / STR_CAP=500) are
  // unaffected by the n<=0/n===1 guard — they take the unchanged slice path.
  it('clip is unchanged for the large internal caps (72 / 500)', () => {
    const big = 'a'.repeat(200);
    expect(clip(big, 72)).toBe('a'.repeat(71) + '…');
    expect([...clip(big, 72)].length).toBe(72);
    const huge = 'b'.repeat(900);
    expect(clip(huge, 500)).toBe('b'.repeat(499) + '…');
    expect([...clip(huge, 500)].length).toBe(500);
    // a string shorter than the cap is returned verbatim.
    expect(clip('short', 72)).toBe('short');
  });

  it('basename tolerates separators + trailing slashes', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts');
    expect(basename('a\\b\\c.ts')).toBe('c.ts');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('plain')).toBe('plain');
  });

  it('firstPath finds a path across the CLIs differing shapes', () => {
    expect(firstPath({ file_path: '/x/y.ts' })).toBe('/x/y.ts');
    expect(firstPath({ path: 'a.ts' })).toBe('a.ts');
    expect(firstPath({ filePath: 'b.ts' })).toBe('b.ts');
    expect(firstPath({ files: ['first.ts', 'second.ts'] })).toBe('first.ts');
    expect(firstPath({ edits: [{ file_path: 'e.ts' }] })).toBe('e.ts');
    expect(firstPath({ command: 'ls' })).toBeNull();
    expect(firstPath(null)).toBeNull();
  });

  it('commandText handles string + argv-array shells', () => {
    expect(commandText({ command: 'npm test' })).toBe('npm test');
    expect(commandText({ command: ['bash', '-c', 'ls'] })).toBe('bash -c ls');
    expect(commandText({ cmd: 'echo hi' })).toBe('echo hi');
    expect(commandText({ file_path: 'x' })).toBeNull();
  });

  it('capDetail caps strings + collapses arrays/objects', () => {
    const big = 'x'.repeat(900);
    const d = capDetail({ s: big, arr: [1, 2, 3], obj: { a: 1 }, n: 5 })!;
    expect((d.s as string).length).toBe(501); // 500 + ellipsis
    expect(d.arr).toBe('[3 items]');
    expect(d.obj).toBe('[object]');
    expect(d.n).toBe(5);
  });
});

describe('summariseActivity — tool kinds', () => {
  it('edit tools → ✎ basename + {file}', () => {
    const r = summariseActivity({ toolName: 'Edit', toolInput: { file_path: '/repo/src/gen.ts' } });
    expect(r.kind).toBe('tool');
    expect(r.summary).toBe('✎ gen.ts');
    expect(r.detail).toEqual({ file: '/repo/src/gen.ts' });
  });

  it('codex apply_patch counts as an edit', () => {
    const r = summariseActivity({ toolName: 'apply_patch', toolInput: { files: ['/repo/a.ts'] } });
    expect(r.summary).toBe('✎ a.ts');
  });

  it('write_file (codex) + str_replace are edits', () => {
    expect(summariseActivity({ toolName: 'write_file', toolInput: { path: 'b.ts' } }).summary).toBe('✎ b.ts');
    expect(summariseActivity({ toolName: 'str_replace', toolInput: { file_path: 'c.ts' } }).summary).toBe('✎ c.ts');
  });

  it('read tools → 👁 basename', () => {
    expect(summariseActivity({ toolName: 'Read', toolInput: { file_path: '/x/README.md' } }).summary).toBe('👁 README.md');
  });

  it('shell tools → ▶ clipped command + {command}', () => {
    const r = summariseActivity({ toolName: 'Bash', toolInput: { command: 'npm run test:affected' } });
    expect(r.summary).toBe('▶ npm run test:affected');
    expect(r.detail).toEqual({ command: 'npm run test:affected' });
    // codex shell with argv array
    expect(summariseActivity({ toolName: 'shell', toolInput: { command: ['bash', '-lc', 'ls'] } }).summary).toBe('▶ bash -lc ls');
  });

  it('search tools → 🔎 pattern', () => {
    expect(summariseActivity({ toolName: 'Grep', toolInput: { pattern: 'TODO' } }).summary).toBe('🔎 TODO');
    expect(summariseActivity({ toolName: 'Glob', toolInput: { pattern: '**/*.ts' } }).summary).toBe('🔎 **/*.ts');
  });

  it('spawn/task tools → ⊕ subagent/description', () => {
    expect(summariseActivity({ toolName: 'Task', toolInput: { subagent_type: 'Explore' } }).summary).toBe('⊕ Explore');
  });

  it('unknown / MCP tool → · name', () => {
    expect(summariseActivity({ toolName: 'coord:send', toolInput: {} }).summary).toBe('· coord:send');
  });

  it('no tool name + no todos → lifecycle', () => {
    const r = summariseActivity({});
    expect(r.kind).toBe('lifecycle');
    expect(r.summary).toBe('· activity');
  });

  it('clips long shell commands into the summary', () => {
    const long = 'echo ' + 'a'.repeat(200);
    const r = summariseActivity({ toolName: 'Bash', toolInput: { command: long } });
    expect(r.summary.length).toBeLessThanOrEqual(74); // '▶ ' + 72-clip
    expect(r.summary.endsWith('…')).toBe(true);
    // detail keeps a longer (500-capped) command
    expect((r.detail!.command as string).length).toBeGreaterThan(72);
  });
});

describe('summariseActivity — todos', () => {
  it('summarises a todo snapshot via the todos arg', () => {
    const r = summariseActivity({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'do the thing', status: 'in_progress', activeForm: 'Doing the thing' },
        { content: 'c', status: 'pending' },
      ],
    });
    expect(r.kind).toBe('todos');
    expect(r.summary).toBe('⇄ Doing the thing (1/3)');
    expect((r.detail!.todos as unknown[])).toHaveLength(3);
    expect(r.detail!.done).toBe(1);
    expect(r.detail!.count).toBe(3);
  });

  it('falls back to count when nothing is in-progress', () => {
    const r = summariseTodos([{ content: 'x', status: 'pending' }, { content: 'y', status: 'completed' }]);
    expect(r.summary).toBe('⇄ 2 todos (1 done)');
  });

  it('detects a TodoWrite whose list rode in tool_input', () => {
    const r = summariseActivity({ toolName: 'TodoWrite', toolInput: { todos: [{ content: 'z', status: 'pending' }] } });
    expect(r.kind).toBe('todos');
    expect(r.summary).toBe('⇄ 1 todo (0 done)');
  });

  it('caps a huge todo list to 20 stored items', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ content: `t${i}`, status: 'pending' }));
    const r = summariseTodos(many);
    expect((r.detail!.todos as unknown[])).toHaveLength(20);
    expect(r.detail!.count).toBe(50);
  });

  // Gap-16: status matching is case-INSENSITIVE ('COMPLETED' / 'In_Progress'),
  // `done` counts completed|done, `active` = the first in_progress item's
  // content (no activeForm here), and the count is `(done/total)`.
  it('matches status casing case-insensitively and formats (done/total)', () => {
    const r = summariseTodos([
      { status: 'COMPLETED' },
      { status: 'In_Progress', content: 'X' },
      { status: 'pending' },
    ]);
    expect(r.summary).toBe('⇄ X (1/3)');
    expect(r.detail!.done).toBe(1);
    expect(r.detail!.count).toBe(3);
  });

  // Singular 'todo' when total === 1 and nothing is in-progress.
  it('uses the singular noun for a single todo', () => {
    expect(summariseTodos([{ status: 'completed' }]).summary).toBe('⇄ 1 todo (1 done)');
  });

  // Empty list: plural noun, zero counts — no in-progress branch.
  it('summarises an empty todo list', () => {
    const r = summariseTodos([]);
    expect(r.summary).toBe('⇄ 0 todos (0 done)');
    expect(r.detail).toEqual({ count: 0, done: 0, todos: [] });
  });
});
