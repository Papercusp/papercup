import { describe, expect, it } from 'vitest';
import { buildDigest } from '../core.mjs';
import { extractRecallSignals, readRecallSignals, combineRecallSignals } from '../recall-query.mjs';

describe('grounded pre-clamp recall signals', () => {
  it.each([
    ['Bash', { command: 'pwd && git status' }],
    ['exec_command', { cmd: 'node -e "const x = JSON.parse(process.argv[1]); console.log(x)"' }],
    ['exec_command', { cmd: "python3 - <<'PY'\nprint('WI-123')\nPY" }],
    ['exec', 'const x = await tools.exec_command({cmd: "echo raw"}); text(x)'],
    ['Grep', '{"pattern":"WI-123"'],
    ['Grep', { pattern: '{"query":"WI-123"}' }],
  ])('abstains on transport-only %s input', (tool, input) => {
    const signal = extractRecallSignals(tool, input);
    expect(signal.semantic).toBe('');
    expect(signal.lexical).toBe('');
  });

  it('extracts grounded task, symbol, path, search, error and exact ID fields', () => {
    const signal = combineRecallSignals([
      extractRecallSignals('Bash', { command: 'rg buildMemoryContextBlock packages/operator-core/lib/memory/injection.ts', description: 'repair WI-6512 memory delivery' }, 'TypeError: unavailable'),
      extractRecallSignals('Grep', { pattern: 'lost response' }),
    ]);
    expect(signal.task).toEqual(['repair memory delivery']);
    expect(signal.symbols).toEqual(['buildMemoryContextBlock']);
    expect(signal.paths).toEqual(['packages/operator-core/lib/memory/injection.ts']);
    expect(signal.search).toEqual(['lost response']);
    expect(signal.errors).toEqual(['TypeError']);
    expect(signal.ids).toEqual(['WI-6512']);
    expect(signal.semantic).not.toMatch(/\brg\b|WI-6512|injection\.ts/);
    expect(signal.lexical).toContain('WI-6512');
    expect(readRecallSignals(signal)).toEqual(signal);
  });

  it('preserves late grounded fields before serialized arguments are clipped', () => {
    const [call] = buildDigest([{ tool: 'exec_command', toolInput: {
      cmd: 'node -e "' + 'x'.repeat(2000) + '"',
      justification: 'investigate WI-6512 delivery', workdir: 'packages/operator-core',
    } }]);
    expect(call.toolInput).toHaveLength(400);
    expect(() => JSON.parse(call.toolInput)).toThrow();
    expect(call.querySignals.ids).toEqual(['WI-6512']);
    expect(call.querySignals.paths).toEqual(['packages/operator-core']);
    expect(call.querySignals.task).toEqual(['investigate delivery']);
    expect(call.querySignals.lexical).not.toContain('node');
  });

  it('gives equivalent native and MCP/XD spellings the same fingerprint', () => {
    const direct = extractRecallSignals('capability:read', { file_path: 'src/memory.ts' });
    const nested = extractRecallSignals('tools:invoke', { name: 'capability:read', args: { file_path: 'src/memory.ts' } });
    const xd = extractRecallSignals('write', { path: 'xd://mcp__papercusp_su_tools_invoke', content: JSON.stringify({ name: 'capability:read', args: { file_path: 'src/memory.ts' } }) });
    expect(nested).toEqual(direct);
    expect(xd).toEqual(direct);
    expect(extractRecallSignals('Read', { file_path: 'src/other.ts' }).fingerprint).not.toBe(direct.fingerprint);
  });

  it('keeps exact identifiers lexical-only and rejects altered manifests', () => {
    const signal = extractRecallSignals('Grep', { pattern: 'WI-6512' });
    expect(signal.semantic).toBe('');
    expect(signal.lexical).toBe('WI-6512');
    expect(readRecallSignals({ ...signal, lexical: 'unrelated transport' })).toBeNull();
    expect(readRecallSignals({ ...signal, ids: ['WI-999'] })).toBeNull();
    expect(readRecallSignals({ ...signal, ids: null })).toBeNull();
  });

  it('keeps patch bodies out while extracting complete file headers', () => {
    const signal = extractRecallSignals('apply_patch', '*** Begin Patch\n*** Update File: src/memory.ts\n@@\n+const SECRET = "body";\n*** End Patch');
    expect(signal.lexical).toBe('src/memory.ts');
    expect(signal.semantic).toBe('');
  });
});
