import { describe, expect, it } from 'vitest';
import { approvalCardText, humanToolName, toolTitle } from './su-session-approval-display';

const CWD = '/tmp/proj';

describe('readable tool-approval cards (pui-chat-first-ux P-008)', () => {
  it('names MCP tools by server and verb words, never by wire id', () => {
    expect(humanToolName('mcp__papercusp-su__work_items_claimable')).toBe('papercusp-su · work items claimable (MCP)');
    expect(humanToolName('mcp__papercusp-su__coord_declare-intent')).toBe('papercusp-su · coord declare intent (MCP)');
    expect(humanToolName('plans:get')).toBe('plans get');
    expect(humanToolName('Read')).toBe('Read');
    // A wrapped tools:invoke is labelled as the tool it dispatches.
    expect(toolTitle('mcp__papercusp-su__tools_invoke', { name: 'plans:get', args: { slug: 'x' } }).title).toBe('plans get');
  });

  it('asks about an edit by file and shows the diff, with the raw object only in the details', () => {
    const input = { file_path: `${CWD}/calc.js`, old_string: 'function add(a, b) {\n  return a - b;\n}',
      new_string: 'function add(a, b) {\n  return a + b;\n}', replace_all: false };
    const card = approvalCardText('Edit', input, { cwd: CWD });
    // The title already names calc.js relative to the chat: no second path line
    // (P-020).
    expect(card.prompt.split('\n')).toEqual([
      'Allow Update(calc.js)?',
      'Add 1 line, remove 1 line',
      '-   return a - b;',
      '+   return a + b;',
    ]);
    expect(card.prompt).not.toContain('old_string');
    expect(card.prompt).not.toContain('{');
    expect(card.details.split('\n')[0]).toBe('Raw arguments (Edit):');
    expect(card.details).toContain('"old_string"');
  });

  it('keeps a path outside the launch directory absolute and does not repeat it', () => {
    const card = approvalCardText('Read', { file_path: '/etc/hosts' }, { cwd: CWD });
    expect(card.prompt).toBe('Allow Read(/etc/hosts)?');
  });

  it('shows a clipped title\'s full path once, relative to the chat, never absolute (P-020)', () => {
    const rel = `src/components/${'deeply-nested-folder/'.repeat(4)}Widget.tsx`;
    const card = approvalCardText('Edit', { file_path: `${CWD}/${rel}`, old_string: 'a', new_string: 'b' }, { cwd: CWD });
    const [headline, ...rest] = card.prompt.split('\n');
    expect(headline).toMatch(/^Allow Update\(src\/components\/.*…\)\?$/);
    expect(rest[0]).toBe(rel);
    expect(card.prompt).not.toContain(CWD);
    expect(card.prompt.split('\n').filter((line) => line.includes('Widget.tsx'))).toHaveLength(1);
  });

  it('adds a path under a Claude title only when that title does not name the file (P-020)', () => {
    const input = { file_path: `${CWD}/calc.js`, old_string: 'a', new_string: 'b' };
    expect(approvalCardText('Edit', input, { cwd: CWD, title: 'Claude wants to edit calc.js' }).prompt.split('\n')[1])
      .toBe('Add 1 line, remove 1 line');
    expect(approvalCardText('Edit', input, { cwd: CWD, title: `Claude wants to edit ${CWD}/calc.js` }).prompt.split('\n')[1])
      .toBe('Add 1 line, remove 1 line');
    expect(approvalCardText('Edit', input, { cwd: CWD, title: 'Claude wants to make an edit' }).prompt.split('\n')[1])
      .toBe('calc.js');
    // A file whose name ends another name in the title is not "named" by it.
    const data = { file_path: `${CWD}/a.js`, old_string: 'a', new_string: 'b' };
    expect(approvalCardText('Edit', data, { cwd: CWD, title: 'Claude wants to edit data.js' }).prompt.split('\n')[1])
      .toBe('a.js');
  });

  it('shows the whole command under a clipped shell title', () => {
    const command = `npm test -- ${'--flag '.repeat(15)}`.trim();
    const card = approvalCardText('Bash', { command, description: 'Run the tests' }, { cwd: CWD });
    const [headline, ...rest] = card.prompt.split('\n');
    expect(headline).toMatch(/^Allow Bash\(npm test -- .*…\)\?$/);
    expect(rest).toEqual(['Run the tests', command]);
    expect(approvalCardText('Bash', { command: 'npm test' }).prompt).toBe('Allow Bash(npm test)?');
  });

  it('says a command description once when Claude repeats it as the request description (WI-10004215)', () => {
    const description = 'Run the test suite with npm test';
    const card = approvalCardText('Bash', { command: 'npm test 2>&1', description },
      { cwd: CWD, description, decisionReason: 'This command requires approval' });
    expect(card.prompt.split('\n')).toEqual([
      'Allow Bash(npm test 2>&1)?', description, 'This command requires approval',
    ]);
  });

  it('summarises MCP arguments on one line with containers as sizes', () => {
    const card = approvalCardText('mcp__papercusp-su__work_items_claimable',
      { harness: 'papercusp', limit: 5, kind: ['bug', 'task'], filter: { a: 1 } });
    expect(card.prompt).toBe('Allow papercusp-su · work items claimable (MCP)?\nharness: papercusp · limit: 5 · kind: 2 items · filter: 1 field');
    expect(card.prompt).not.toContain('mcp__');
  });

  it('bounds a large diff and keeps Claude supplied text', () => {
    const newText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const card = approvalCardText('Write', { file_path: `${CWD}/big.txt`, content: `${newText}\n` },
      { cwd: CWD, decisionReason: 'Writes outside the allowed rules' });
    const lines = card.prompt.split('\n');
    expect(lines[0]).toBe('Allow Write(big.txt)?');
    expect(lines).toContain('Write 30 lines');
    expect(lines).toContain('… 18 more lines');
    expect(lines.at(-1)).toBe('Writes outside the allowed rules');
    expect(approvalCardText('Edit', {}, { title: 'Claude wants to edit calc.js' }).prompt.split('\n')[0])
      .toBe('Claude wants to edit calc.js');
  });
});
