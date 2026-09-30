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
    expect(card.prompt.split('\n')).toEqual([
      'Allow Update(calc.js)?',
      `${CWD}/calc.js`,
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

  it('shows the whole command under a clipped shell title', () => {
    const command = `npm test -- ${'--flag '.repeat(15)}`.trim();
    const card = approvalCardText('Bash', { command, description: 'Run the tests' }, { cwd: CWD });
    const [headline, ...rest] = card.prompt.split('\n');
    expect(headline).toMatch(/^Allow Bash\(npm test -- .*…\)\?$/);
    expect(rest).toEqual(['Run the tests', command]);
    expect(approvalCardText('Bash', { command: 'npm test' }).prompt).toBe('Allow Bash(npm test)?');
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
