import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskBrief, getClaimTimeTaskBrief, TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import type { CodeIntelAnswer } from './contracts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'task-brief-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const answer = (paths: string[]): CodeIntelAnswer => ({ backend: 'repomix', intent: 'pack', query: 'fixture',
  sites: paths.map(path => ({ path, line1: null, kind: 'file', detail: null })),
  truncation: { truncated: false, totalAvailable: null, continuation: null },
  freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null }, latencyMs: 0, error: null });
function depsFor(root: string): TaskBriefDeps {
  return { root: vi.fn(async () => root), effects: { exec: vi.fn(async () => ({ stdout: '' })),
    now: () => new Date(), writeArtifact: vi.fn(async () => '') },
    graph: vi.fn(async () => ({ ...answer([]), error: 'not configured' })),
    pack: vi.fn(async (_op, args) => {
      const { readFileSync } = await import('node:fs');
      const path = join(root, 'pack.xml');
      writeFileSync(path, args.include.map((p: string) => `<file path="${p}">${readFileSync(join(root, p), 'utf8')}</file>`).join('\n'));
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
  it('preserves verified source when optional compiler enrichment misses the remaining brief budget', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "CURRENT_SOURCE"; }');
    const deps = depsFor(root), pack = deps.pack;
    // Advance the wall clock after packing to reproduce the measured nearly-full
    // source budget without sleeping or changing the source oracle.
    const clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    deps.pack = async (...args) => { const packed = await pack(...args); now.mockReturnValue(clock + 5_500); return packed; };
    deps.graph = vi.fn(() => new Promise<CodeIntelAnswer>(() => {}));
    try {
      const result = await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
        payload: { paths: ['target.ts'] } } }, deps);
      expect(result?.taskBrief.status).toBe('current');
      expect(result?.taskBrief.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result?.taskBrief.files).toEqual([expect.objectContaining({ path: 'target.ts' })]);
      expect(JSON.stringify(result?.taskBrief.excerpts)).toContain('CURRENT_SOURCE');
      expect(result?.taskBrief.graph.status).toBe('unknown');
      expect(result?.taskBrief.graph.reason).toMatch(/budget|unavailable/);
      expect(vi.mocked(deps.graph).mock.calls[0]![4]).toBeLessThan(500);
    } finally { now.mockRestore(); }
  }, 10_000);
  it('keeps scoped source current after compiler failure but still rejects a concurrent source edit', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "CURRENT_SOURCE"; }');
    const deps = depsFor(root);
    const ref = { workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } };
    deps.graph = async () => { throw new Error('compiler unavailable'); };
    const current = await buildTaskBrief(ref, deps);
    expect(current.status).toBe('current'); expect(JSON.stringify(current.excerpts)).toContain('CURRENT_SOURCE');
    expect(current.graph.status).toBe('unknown');
    deps.graph = async () => { writeFileSync(join(root, 'target.ts'), 'export function target() { return "CHANGED"; }');
      throw new Error('compiler unavailable'); };
    expect(await buildTaskBrief(ref, deps)).toMatchObject({ status: 'unknown', files: [], excerpts: [], sourceFingerprint: null });
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
  it('recovers the registered repository rather than a payload root and cites canonical cross-plan authority', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root);
    deps.decisions = vi.fn(async () => ({ planSlug: 'task-plan', totalDecisions: 2,
      totalLocalDecisions: 1, totalAffectedDecisions: 1, affectedDecisions: 1, authorityReadFailed: false,
      decisions: [{ id: 'D-003', title: 'local', snippet: 'body' },
        { id: 'D-004', title: 'inbound', snippet: 'body', sourcePlanSlug: 'governing-plan' }] }));
    const brief = await buildTaskBrief({ workspaceId: 'task-workspace', workItem: { id: 'WI-task', harness: 'h',
      sourcePlanSlug: 'task-plan', payload: { rootPath: '/untrusted', paths: ['target.ts'] } } }, deps);
    expect(brief.repository).toEqual({ workspaceId: 'task-workspace', rootPath: root });
    expect(brief.recover).toEqual({ tool: 'code:pack', args: { op: 'pack', include: ['target.ts'], rootPath: root } });
    expect(brief.decisions).toEqual({ status: 'measured', refs: [{ plan: 'task-plan', id: 'D-003' },
      { plan: 'governing-plan', id: 'D-004' }], recover: { tool: 'plans:get', args: { slug: 'task-plan', harness: 'h', heading: 'Decisions' } } });
    expect(JSON.stringify(brief)).not.toContain('/untrusted');
  });
  it('keeps a failed governing-authority read explicitly unknown while preserving current scoped source', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root); deps.decisions = vi.fn(async () => { throw new Error('authority unavailable'); });
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', sourcePlanSlug: 'task-plan',
      payload: { paths: ['target.ts'] } } }, deps);
    expect(brief.status).toBe('current'); expect(brief.decisions?.status).toBe('unknown');
    expect(brief.decisions?.refs).toEqual([]); expect(brief.decisions?.recover.args.slug).toBe('task-plan');
  });
  it('preserves scoped recovery and at least one source card when deep task paths and decisions fill the inline budget', async () => {
    const root = fixture(), prefix = 'packages/operator-core/lib/code-intelligence';
    mkdirSync(join(root, prefix), { recursive: true });
    const paths = ['task-brief.ts', 'task-brief.test.ts', 'task-brief.integration.test.ts',
      'native-ecosystem.integration.test.ts', 'native-ecosystem.e2e.test.ts'].map(name => `${prefix}/${name}`);
    for (const path of paths) writeFileSync(join(root, path), 'export function target() { return "SCOPED_SOURCE"; }');
    const plan = 'native-code-intelligence-ecosystem-and-dream-2026-10-09';
    const deps = depsFor(root);
    deps.decisions = async () => ({ planSlug: plan, totalDecisions: 8, totalLocalDecisions: 8,
      totalAffectedDecisions: 0, affectedDecisions: 0, authorityReadFailed: false,
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `D-00${i + 1}`, title: 'authority', snippet: 'body' })) });
    const brief = await buildTaskBrief({ workspaceId: 'papercusp-workspace', workItem: { id: 'WI-native-task', harness: 'papercusp',
      sourcePlanSlug: plan, payload: { paths } } }, deps);
    expect(brief.status).toBe('current');
    expect(brief.files.length).toBeGreaterThan(0);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: root, include: paths.slice().sort() } });
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.exclusions.join(' ')).toMatch(/omitted/);
  });
});
