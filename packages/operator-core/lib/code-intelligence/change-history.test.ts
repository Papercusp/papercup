import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { boundChangeHistoryProviders, changeHistoryProviders, coChangeFromCommits, coChangeOverlap,
  ledgerSymbolProvenance, readCoChange, readSymbolProvenance, registerChangeHistoryProviders, symbolProvenance,
  type HistoryCommit, type ProvenanceEdit, type LedgerProvenanceEdit } from './change-history';
import { composeReuseBrief, registeredReuseBriefProviders, type ReuseContribution } from './reuse-brief-providers';
import graphQuery from '../agent-tools/gitnexus/query';

const END = '2026-10-23T00:00:00.000Z';
const commit = (n: number, paths = ['a.ts', 'b.ts']): HistoryCommit => ({ sha: String(n).padStart(40, '0'),
  parents: ['f'.repeat(40)], at: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`,
  files: paths.map(path => ({ status: 'M', path })) });
const history = (commits: HistoryCommit[], paths = ['a.ts']) => coChangeFromCommits({ commits, paths, end: END,
  complete: true, commit: 'a'.repeat(40) });
const source = 'export function work() { return 2; }\n';
const edit: ProvenanceEdit = { invocation: 'invocation-7', at: '2026-10-10T12:00:00Z', owner: 'su-editor', session: 'session-exact',
  sessionOwners: ['su-editor'], status: 'ok', tool: 'Edit', input: { file_path: 'a.ts', old_string: 'return 1;', new_string: 'return 2;' } };
const assignment = { owner: 'su-editor', workItem: 'WI-responsible', start: '2026-10-09T00:00:00Z', end: '2026-10-11T00:00:00Z', complete: true };
const provenance = (patch: Partial<Parameters<typeof symbolProvenance>[0]> = {}) => symbolProvenance({ root: '/fixture', path: 'a.ts',
  source, edits: [edit], assignments: [assignment], complete: true, ...patch });
const ledgerEdit = (patch: Partial<LedgerProvenanceEdit> = {}): LedgerProvenanceEdit => ({
  id: '1', at: END, owner: 'former-owner', session: 'ended-session', workItem: 'WI-done', symbols: ['work'], ...patch });

describe('P001 edit-time ledger history', () => {
  const read = (rows: LedgerProvenanceEdit[], patch: Partial<Parameters<typeof ledgerSymbolProvenance>[0]> = {}) =>
    ledgerSymbolProvenance({ path: 'a.ts', source, rows, complete: true, ...patch });
  it('deduplicates completed/released work items without asserting current function identity', () => {
    const result = read([ledgerEdit(), ledgerEdit({ id: '2' }), ledgerEdit({ id: '3', workItem: 'WI-released' })]);
    expect(result.history[0]).toMatchObject({ status: 'measured', workItems: ['WI-done', 'WI-released'], currentIdentity: 'unknown' });
    expect(result.symbols[0]).toMatchObject({ status: 'unknown', workItem: null, recordedHistory: result.history[0] });
  });
  it('retains pre-capture and unattributed rows at file level, with unknown symbol attribution', () => {
    const result = read([ledgerEdit({ symbols: null }), ledgerEdit({ id: '2', symbols: [], workItem: null })]);
    expect(result.fileEdits).toHaveLength(2); expect(result.history).toEqual([]);
    expect(result.symbolStatus).toBe('unknown'); expect(result.symbols[0]?.workItem).toBeNull();
    expect(read([ledgerEdit({ workItem: null })]).history[0]).toMatchObject({ status: 'unknown', workItems: [] });
    expect(read([ledgerEdit({ symbols: [] })]).symbolStatus).toBe('measured');
  });
  it('surfaces the 50-row cap and parser failure instead of measured absence', () => {
    const capped = read(Array.from({ length: 51 }, (_, n) => ledgerEdit({ id: String(n) })));
    expect(capped).toMatchObject({ status: 'unknown', truncated: true });
    expect(capped.fileEdits).toHaveLength(50); expect(capped.history[0]?.status).toBe('unknown');
    const broken = read([ledgerEdit()], { source: 'export function work( {' });
    expect(broken).toMatchObject({ status: 'unknown', symbolStatus: 'unknown', symbols: [] });
    expect(broken.fileEdits).toHaveLength(1); expect(broken.limitations.join(' ')).toContain('parse');
  });
  it('does not infer rename, move, overload or nested identity from present-day names', () => {
    const renamed = read([ledgerEdit({ symbols: ['oldName'] })], { source: 'export function newName() {}' });
    expect(renamed.history[0]?.symbol).toBe('oldName'); expect(renamed.symbols[0]?.recordedHistory).toBeUndefined();
    const overloaded = read([ledgerEdit({ symbols: ['work', 'outer.inner'] })], {
      source: 'function work(x: string): string; function work(x: string) { return x; } function outer() { function inner() {} }' });
    expect(overloaded.history.every(row => row.currentIdentity === 'unknown')).toBe(true);
    expect(overloaded.symbols.every(row => row.status === 'unknown')).toBe(true);
    expect(read([], { name: 'work' }).history).toEqual([]); // A move has no evidence in this file.
  });
  it('preserves both recorded labels for a range split across functions without fabricating continuity', () => {
    const result = read([ledgerEdit({ symbols: ['left', 'right'] })], { source: 'function left() {} function right() {}' });
    expect(result.history.map(row => row.symbol)).toEqual(['left', 'right']);
    expect(result.symbols.every(row => row.status === 'unknown')).toBe(true);
  });
});

describe('P013 declared history and source provenance contracts', () => {
  it('counts distinct eligible first-parent commits with Jaccard and a three-shared floor', () => {
    const commits = [commit(1), commit(2), commit(3), commit(4, ['a.ts', 'c.ts']), commit(5, ['b.ts']), commit(1),
      { ...commit(6), parents: ['x', 'y'] }, { ...commit(7), at: '2025-01-01T00:00:00Z' }];
    const report = history(commits);
    expect(report.pairs).toEqual([{ path: 'a.ts', partner: 'b.ts', shared: 3, union: 5, score: 3 / 5 }]);
    expect(report.eligibleCommits).toBe(5);
    expect(report.window.lineage).toBe('first-parent');
  });
  it('follows recorded rename pairs and excludes mass/generated/vendor/retired changes', () => {
    const renamed = { ...commit(4, []), files: [{ status: 'R080', from: 'a.ts', path: 'renamed.ts' }] };
    const report = history([commit(1), commit(2), commit(3), renamed,
      commit(5, ['renamed.ts', 'vendor/x.ts', 'retired/y.ts', 'x.generated.ts']),
      commit(6, Array.from({ length: 101 }, (_, n) => n ? `other${n}.ts` : 'renamed.ts'))], ['renamed.ts']);
    expect(report.pairs[0]).toMatchObject({ path: 'renamed.ts', partner: 'b.ts', shared: 3, union: 5 });
    expect(report.eligibleCommits).toBe(5);
    expect(report.pairs.some(p => /vendor|retired|generated/.test(p.partner))).toBe(false);
  });
  it('leaves ambiguous/copy/reused identities unknown and never upgrades a truncated history', () => {
    const report = history([commit(1), commit(2), commit(3), { ...commit(4, []), files: [
      { status: 'R080', from: 'a.ts', path: 'moved.ts' }, { status: 'R090', from: 'b.ts', path: 'moved.ts' }] }]);
    expect(report.unknownPaths).toContain('moved.ts'); expect(report.pairs).toEqual([]);
    expect(coChangeFromCommits({ commits: [commit(1), commit(2), commit(3)], paths: ['a.ts'], end: END,
      commit: null, complete: false }).status).toBe('unknown');
  });
  it('joins exact invocation/session/assignment and current symbol bytes without authorship', () => {
    expect(provenance()[0]).toMatchObject({ status: 'measured', workItem: 'WI-responsible', symbol: 'work',
      edits: [{ invocation: 'invocation-7', session: 'session-exact', owner: 'su-editor', workItem: 'WI-responsible' }] });
    expect(provenance()[0]?.contentHash).toBe(createHash('sha256').update(source).digest('hex'));
  });
  it('keeps multiple/absent assignments, wrong sessions, stale bytes and partial ledgers unknown', () => {
    for (const patch of [{ assignments: [] }, { assignments: [assignment, { ...assignment, workItem: 'WI-other' }] },
      { edits: [{ ...edit, sessionOwners: ['su-other'] }] }, { edits: [{ ...edit, sessionOwners: ['su-editor', 'su-other'] }] },
      { source: source.replace('2', '3') }, { complete: false }, { edits: [{ ...edit, status: 'error' }] },
      { assignments: [{ ...assignment, end: edit.at }] }]) {
      expect(provenance(patch)[0]).toMatchObject({ status: 'unknown', workItem: null });
    }
  });
  it.each(['Write', 'MultiEdit', 'capability:edit'])('reads %s through the canonical hunk extractor', tool => {
    const input = tool === 'Write' ? { file_path: 'a.ts', content: source }
      : tool === 'MultiEdit' ? { file_path: 'a.ts', edits: [{ old_string: '1', new_string: 'return 2;' }] } : edit.input;
    expect(provenance({ edits: [{ ...edit, tool, input }] })[0]?.status).toBe('measured');
  });
  it('reports co-changing plan lanes and unanchored partners without claiming a dependency', () => {
    const report = history([commit(1), commit(2), commit(3)]);
    expect(coChangeOverlap(report, [{ itemId: 'P-001', paths: ['a.ts'] }, { itemId: 'P-002', paths: ['b.ts'] }]).pairs)
      .toContainEqual({ items: ['P-001', 'P-002'], paths: ['a.ts', 'b.ts'], shared: 3, union: 3 });
    expect(coChangeOverlap(report, [{ itemId: 'P-001', paths: ['a.ts'] }]).unanchored).toEqual(['b.ts']);
  });
  it.each(['claim', 'authoring', 'completion'] as const)('uses the P009 composition budget on %s', async surface => {
    const report = history([commit(1), commit(2), commit(3)]);
    const providers = changeHistoryProviders({ cochange: async () => report, provenance: async () => provenance() });
    const result = await composeReuseBrief({ base: { mandatory: 'unchanged', sections: [] as ReuseContribution[] }, providers,
      context: { surface, paths: ['a.ts'], sourceVersion: 'source-v1', commit: report.commit,
        workspaceId: 'workspace', owner: 'su-editor', invocation: 'claim-real' }, deadline: Date.now() + 6000,
      append: (base, contribution) => ({ ...base, sections: [...base.sections, contribution] }) });
    expect(result.brief.mandatory).toBe('unchanged');
    expect(result.brief.sections.map(p => p.provider)).toEqual(['cochange', 'provenance']);
    expect(result.brief.sections[0]?.text).toContain(surface === 'completion' ? 'Untouched' : 'Unanchored');
    expect(result.observations.map(row => row.status)).toEqual(['issued', 'issued']);
  });
  it('does not publish partial/stale provider results as measured absence', async () => {
    const providers = changeHistoryProviders({ cochange: async () => ({ ...history([]), status: 'unknown' }),
      provenance: async () => provenance({ complete: false }) });
    const context = { surface: 'claim' as const, paths: ['a.ts'], sourceVersion: 'source-v1', commit: 'other',
      workspaceId: 'workspace', owner: 'su-editor', invocation: 'claim-real' };
    for (const provider of providers) expect((await provider.read(context, new AbortController().signal)).status).toBe('unknown');
  });
  it('registers both producers once at P009 and rolls back duplicate installation', () => {
    const deps = { cochange: async () => history([]), provenance: async () => provenance() };
    const dispose = registerChangeHistoryProviders(deps);
    try {
      expect(registeredReuseBriefProviders().filter(row => ['cochange', 'provenance'].includes(row.id)).map(row => row.id))
        .toEqual(['cochange', 'provenance']);
      expect(() => registerChangeHistoryProviders(deps)).toThrow('already registered');
    } finally { dispose(); }
    expect(registeredReuseBriefProviders().some(row => row.id === 'cochange')).toBe(false);
  });
});

describe('P013 actual commit reader', () => {
  it('reads full first-parent commit file sets from a real repository, never author names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cochange-'));
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', root, ...args])).stdout.trim();
    try {
      await git('init', '-q'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'user.name', 'not-provenance');
      for (let n = 0; n < 3; n++) {
        await writeFile(join(root, 'a.ts'), `export const a=${n};`); await writeFile(join(root, 'b.ts'), `export const b=${n};`);
        await git('add', 'a.ts', 'b.ts'); await git('commit', '-qm', `fixture-${n}`);
      }
      const result = await readCoChange(root, ['a.ts'], new Date(Date.now() + 2000).toISOString());
      expect(result.status).toBe('measured'); expect(result.pairs[0]).toMatchObject({ partner: 'b.ts', shared: 3, union: 3 });
      const graph = await graphQuery.handler({ op: 'cochange', paths: ['a.ts'] } as never,
        { projectDir: root, workspaceId: 'history-test' } as never) as { data: { pairs: { partner: string }[] } };
      expect(graph.data.pairs[0]?.partner).toBe('b.ts');
      const unscoped = await graphQuery.handler({ op: 'provenance', file_path: 'a.ts' } as never,
        { projectDir: root, workspaceId: 'history-test' } as never) as { data: { status: string } };
      expect(unscoped.data.status).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('not-provenance');
      const bad = boundChangeHistoryProviders({ root: async () => root, harness: 'fixture' });
      await expect(bad[0]!.read({ surface: 'claim', workspaceId: 'w', owner: 'o', invocation: 'i', paths: ['a.ts'],
        sourceVersion: 'stale', commit: result.commit }, new AbortController().signal)).rejects.toThrow('fingerprint');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

