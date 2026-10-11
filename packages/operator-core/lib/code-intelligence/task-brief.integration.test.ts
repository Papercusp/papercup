/** P-012: actual safe packer + compiler, refreshed by the canonical resume reader. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import { buildTaskBrief } from './task-brief';
import { DEFAULT_PACKER_EFFECTS, packerFacade, resolveRepomixBin } from './packer-facade';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { readWorkItemResume } from '../agent-tools/work_items/resume';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe('native P012 current scoped brief integration', () => {
  it('packs only task files, reports the compiler consumer, and replaces stale excerpts on resume', async () => {
    expect(resolveRepomixBin(), 'the admitted safe packer must be provisioned').not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'task-brief-int-')); dirs.push(root);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "BEFORE_EDIT"; }\n');
    writeFileSync(join(root, 'consumer.ts'), 'import { target } from "./target";\nexport const result = target();\n');
    writeFileSync(join(root, 'target.test.ts'), 'import { target } from "./target";\nexport const testResult = target();\n');
    writeFileSync(join(root, 'guide.md'), 'Source-linked target.ts usage guide.\n');
    writeFileSync(join(root, 'unrelated.ts'), 'UNRELATED_SOURCE_MUST_NOT_APPEAR');
    writeFileSync(join(root, '.env'), 'TASK_PRIVATE_SECRET_MUST_NOT_APPEAR');
    const item = { id: 'WI-task-fixture', harness: 'brief-fixture', state: 'open',
      payload: { paths: ['target.ts', 'consumer.ts', 'target.test.ts', 'guide.md'] } };
    const source = async () => ({ taskBrief: await buildTaskBrief({ workspaceId: 'fixture-workspace', workItem: item }, {
      root: async (workspaceId, harness) => workspaceId === 'fixture-workspace' && harness === 'brief-fixture' ? root : null,
      effects: DEFAULT_PACKER_EFFECTS, pack: packerFacade,
      graph: (repo, name, filePath, paths, budgetMs) => firstPartyCallersOffthread({
        root: repo, name, filePath, paths, op: 'callers', limit: 8, vendorDir: LSP_VENDOR_DIR,
      }, { budgetMs }),
    }) });
    const deps = { checkpoint: async () => ({ checkpoint: null, updatedAtMs: null }),
      freshness: async () => undefined, evidence: async () => [], taskBrief: source };
    const first = await readWorkItemResume(item, deps);
    expect(first.taskBrief?.status, JSON.stringify(first.taskBrief)).toBe('current');
    expect(first.taskBrief).toHaveProperty('graph.status', 'measured');
    expect(first.taskBrief).toHaveProperty('graph.consumers', expect.arrayContaining(['consumer.ts:2']));
    expect(first.taskBrief).toHaveProperty('files', expect.arrayContaining([
      expect.objectContaining({ path: 'guide.md', kind: 'doc' }), expect.objectContaining({ path: 'target.test.ts', kind: 'test' }),
    ]));
    expect(JSON.stringify(first.taskBrief)).toContain('BEFORE_EDIT');
    expect(JSON.stringify(first)).not.toMatch(/UNRELATED_SOURCE|TASK_PRIVATE_SECRET/);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "AFTER_EDIT"; }\n');
    const resumed = await readWorkItemResume(item, deps);
    expect(resumed.taskBrief?.status, JSON.stringify(resumed.taskBrief)).toBe('current');
    expect(resumed.taskBrief).not.toHaveProperty('sourceFingerprint', (first.taskBrief as any).sourceFingerprint);
    expect(JSON.stringify(resumed.taskBrief)).toContain('AFTER_EDIT');
    expect(JSON.stringify(resumed.taskBrief)).not.toContain('BEFORE_EDIT');
  }, 60_000);
});
