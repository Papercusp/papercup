import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lspDaemonCostKey } from './lsp-daemon-cost-key.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('daemon cost observation identity', () => {
  it('distinguishes cursor, operation and actual document contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-cost-key-'));
    roots.push(root);
    const file = join(root, 'example.ts');
    writeFileSync(file, 'const name = 1;\n');
    const args = { file, rootPath: root, line1: 1, character: 6 };
    const first = await lspDaemonCostKey('references', args);
    expect(first).toBeTruthy();
    expect(await lspDaemonCostKey('references', args)).toBe(first);
    expect(await lspDaemonCostKey('references', { ...args, character: 7 })).not.toBe(first);
    expect(await lspDaemonCostKey('symbol', args)).not.toBe(first);
    writeFileSync(file, 'const name = 2;\n');
    expect(await lspDaemonCostKey('references', args)).not.toBe(first);
  });

  it('does not reuse a cost without a readable document revision', async () => {
    expect(await lspDaemonCostKey('workspace_symbols', { name: 'Symbol' })).toBeUndefined();
    expect(await lspDaemonCostKey('references', { file: '/missing/lsp-cost-key.ts' })).toBeUndefined();
  });
});
