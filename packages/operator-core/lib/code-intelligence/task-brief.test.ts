import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskBrief, TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import { unmeasuredSourceEvidence, type CodeIntelAnswer } from './contracts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'task-brief-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const answer = (paths: string[]): CodeIntelAnswer => ({ backend: 'repomix', intent: 'pack', query: 'fixture',
  sites: paths.map(path => ({ path, line1: null, kind: 'file', detail: null })),
  truncation: { truncated: false, totalAvailable: null, continuation: null },
  freshness: { health: 'healthy', indexedAt: null, staleVsHead: null }, cost: { wallMs: 0, execution: 'ran' }, error: null,
  evidence: unmeasuredSourceEvidence({ paths }) });
function depsFor(root: string): TaskBriefDeps {
  return { root: vi.fn(async () => root), effects: { exec: vi.fn(async () => ({ stdout: '' })),
    now: () => new Date(), writeArtifact: vi.fn(async () => '') },
    graph: vi.fn(async () => ({ ...answer([]), error: 'not configured' })),
    pack: vi.fn(async (_op, args) => {
      const { readFileSync } = await import('node:fs');
      const path = join(root, 'pack.xml');
      writeFileSync(path, args.include.map(p => `<file path="${p}">${readFileSync(join(root, p), 'utf8')}</file>`).join('\n'));
      return { answer: answer([...args.include]), artifact: { path, preview: '', provenance: { commit: 'fixture-pin' } as never } };
    }),
  };
}
describe('P012 bounded scoped task briefs', () => {
  it('does not infer a root or search when stored task scope is missing', async () => {
    const deps = depsFor(fixture());
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h' }, workspaceId: 'w' }, deps);
    expect(brief.status).toBe('unknown'); expect(deps.root).not.toHaveBeenCalled(); expect(deps.pack).not.toHaveBeenCalled();
  });
  it('rejects traversal, whole-repository globs, hidden paths and escaping symlinks before packing', async () => {
    const root = fixture(), outside = fixture(); writeFileSync(join(outside, 'private.ts'), 'PRIVATE');
    symlinkSync(join(outside, 'private.ts'), join(root, 'escaped.ts'));
    const deps = depsFor(root);
    const brief = await buildTaskBrief({ workspaceId: 'allowed', workItem: { id: 'WI-task', harness: 'h',
      payload: { rootPath: outside, paths: ['../private.ts', '.', '**/*', '.env', 'escaped.ts'] } } }, deps);
    expect(deps.root).toHaveBeenCalledWith('allowed', 'h'); expect(deps.pack).not.toHaveBeenCalled();
    expect(JSON.stringify(brief)).not.toContain('PRIVATE'); expect(brief.status).toBe('unknown');
  });
  it('remeasures the same scoped source after an edit and does not retain the old excerpt', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "old"; }');
    writeFileSync(join(root, 'unrelated.ts'), 'UNRELATED_PRIVATE');
    const ref = { workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } };
    const deps = depsFor(root), first = await buildTaskBrief(ref, deps);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "new"; }');
    const next = await buildTaskBrief(ref, deps);
    expect(first.status).toBe('current'); expect(next.status).toBe('current');
    expect(first.sourceFingerprint).not.toBe(next.sourceFingerprint);
    expect(JSON.stringify(next.excerpts)).toContain('new'); expect(JSON.stringify(next.excerpts)).not.toContain('old');
    expect(JSON.stringify(next)).not.toContain('UNRELATED_PRIVATE');
    expect(JSON.stringify(next).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('discards excerpts when source changes during safe packing', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root), pack = deps.pack;
    deps.pack = async (...args) => { const result = await pack(...args); writeFileSync(join(root, 'target.ts'), 'changed'); return result; };
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } }, deps);
    expect(brief).toMatchObject({ status: 'unknown', files: [], excerpts: [], sourceFingerprint: null });
  });
  it('clamps the packer subprocess budget and exposes refusal as unknown with recovery', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export const x = 1;'); const deps = depsFor(root);
    deps.pack = async (_op, _args, effects) => {
      await effects!.exec('packer', [], { timeoutMs: 180_000 });
      return { answer: { ...answer([]), error: 'packer deadline' }, artifact: null };
    };
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } }, deps);
    expect(vi.mocked(deps.effects.exec).mock.calls[0]![2]!.timeoutMs).toBeLessThanOrEqual(6_000);
    expect(brief.status).toBe('unknown'); expect(brief.recover.tool).toBe('code:pack'); expect(brief.excerpts).toEqual([]);
  });
});
