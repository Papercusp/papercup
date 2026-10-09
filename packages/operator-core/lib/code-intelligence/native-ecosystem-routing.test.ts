// Unit-level handler wiring proof: backend boundaries are mocked. Database,
// daemon and deployed behavior retain their separate integration obligations.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ compiler: vi.fn(), indexed: vi.fn(), daemon: vi.fn(), packer: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
vi.mock('./lsp-daemon-client', () => ({ queryLspDaemon: calls.daemon }));
vi.mock('./packer-facade', async importOriginal => ({
  ...await importOriginal<typeof import('./packer-facade')>(), packerFacade: calls.packer,
}));
vi.mock('./first-party-callers-offthread', () => ({ firstPartyCallersOffthread: calls.compiler }));
vi.mock('./gitnexus-facade', async importOriginal => ({
  ...await importOriginal<typeof import('./gitnexus-facade')>(), gitnexusFacade: calls.indexed,
}));
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';

const baselinePath = fileURLToPath(new URL('../../../../docs/evidence/native-code-intelligence-baseline-2026-10-09.json', import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
  routes: Array<{ tool: string; operations: string[]; backend?: string }>;
};
const graphRows = baseline.routes.filter(row => row.tool === 'graph:query');
const graphOperations = graphRows.flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));

beforeEach(() => {
  vi.clearAllMocks();
  calls.compiler.mockResolvedValue({ backend: 'typescript-service', sites: [], error: null });
  calls.indexed.mockResolvedValue({ backend: 'gitnexus', sites: [], error: null });
  calls.daemon.mockResolvedValue({ backend: 'lsp-adapter', sites: [], error: null });
  calls.packer.mockImplementation(async (op: string) => ({
    answer: { backend: op === 'pack' ? 'repomix' : 'code2prompt', sites: [], error: null },
  }));
});

describe('native baseline exposed semantic and packing handlers', () => {
  const semantic = baseline.routes.filter(row => row.tool === 'lsp:query')
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));
  it.each(semantic)('LSP $op selects the recorded $backend daemon route', async ({ op, backend }) => {
    const result = await lspQuery.handler(lspQuery.args.parse({ op, file: 'src/target.ts',
      line1: 1, character: 17, name: 'baselineTarget', newName: 'renamed' }),
    { projectDir: '/baseline-repo', workspaceId: 'baseline-workspace' } as never) as { data: { backend: string } };
    expect(result.data.backend).toBe(backend);
    expect(calls.daemon).toHaveBeenCalledWith(expect.objectContaining({ op, workspaceId: 'baseline-workspace',
      args: expect.objectContaining({ rootPath: '/baseline-repo', file: '/baseline-repo/src/target.ts' }) }));
  });

  const packing = baseline.routes.filter(row => row.tool === 'code:pack')
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));
  it.each(packing)('pack $op selects the recorded $backend engine', async ({ op, backend }) => {
    const result = await codePack.handler(codePack.args.parse({ op, include: ['src/**'] }),
      { projectDir: '/baseline-repo' } as never) as { data: { answer: { backend: string } } };
    expect(result.data.answer.backend).toBe(backend);
    expect(calls.packer).toHaveBeenCalledWith(op, expect.objectContaining({ rootPath: '/baseline-repo', include: ['src/**'] }));
  });

  it('enumerates every admitted exposed operation even if the inventory omits one', () => {
    expect(graphQuery.args.shape.op.options.toSorted()).toEqual([
      'callers', 'callees', 'diagnostics', 'health', 'impact', 'implementations', 'references',
      'rename-preview', 'structural-search', 'symbol', 'symbol-search', 'text-search',
    ].toSorted());
    expect(graphOperations.map(row => row.op).toSorted()).toEqual(['callers', 'callees', 'health', 'impact', 'symbol'].toSorted());
    expect(semantic.map(row => row.op).toSorted()).toEqual(lspQuery.args.shape.op.options.toSorted());
    expect(packing.map(row => row.op).toSorted()).toEqual(codePack.args.shape.op.options.toSorted());
  });
});

describe('native baseline against the exposed graph handler', () => {
  it('reports unknown indexed versions without assigning current-source identities', async () => {
    calls.indexed.mockResolvedValue({ backend: 'gitnexus', intent: 'callees', sites: [{ path: 'src/old.ts', line1: 2, kind: 'function' }],
      error: null, freshness: { health: 'healthy', indexedAt: null, indexedCommit: 'older-index', staleVsDisk: true } });
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'callees', name: 'target' }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.evidence!.sourceScope).toMatchObject({ repositoryId: null, identityKind: 'unknown', sourceFingerprint: null, supportingFiles: [] });
    expect(out.data.evidence!.siteIdentities).toEqual([{ siteIndex: 0, sourcePath: 'src/old.ts', contentHash: null, versionedSymbolId: null }]);
    expect(out.data.evidence!.relationships[0]).toMatchObject({ knowledge: 'unknown', runtimeExecution: 'unknown' });
    expect(out.data.freshness.indexedCommit).toBe('older-index');
  });

  it('labels LSP source versions as unknown when the daemon supplies no snapshots', async () => {
    const out = await lspQuery.handler(lspQuery.args.parse({ op: 'references', file: 'src/target.ts', line1: 1, character: 0 }),
      { projectDir: '/baseline-repo' } as never) as { data: import('./contracts').CodeIntelAnswer };
    expect(out.data.evidence!.sourceScope.sourceFingerprint).toBeNull();
    expect(out.data.evidence!.siteIdentities.every(site => site.contentHash === null && site.versionedSymbolId === null)).toBe(true);
    expect(out.data.evidence!.graphScope.sourceCompleteness).toBe('unverified');
  });

  it.each(graphOperations)('$op selects the recorded $backend backend', async ({ op, backend }) => {
    const args = graphQuery.args.parse({ op, name: 'baselineTarget' });
    const out = await graphQuery.handler(args, { projectDir: '/baseline-repo' } as never) as {
      data: { backend: string };
    };
    expect(out.data.backend).toBe(backend);
    expect(calls.compiler).toHaveBeenCalledTimes(backend === 'typescript-service' ? 1 : 0);
    expect(calls.indexed).toHaveBeenCalledTimes(backend === 'gitnexus' ? 1 : 0);
  });

  it('reports a compiler failure through the same first-party route without substituting indexed evidence', async () => {
    calls.compiler.mockResolvedValue({ backend: 'typescript-service', sites: [], error: 'compiler unavailable',
      freshness: { health: 'unhealthy', indexedAt: null, indexedCommit: null, staleVsDisk: null } });
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name: 'baselineTarget' }),
      { projectDir: '/baseline-repo' } as never) as { data: { error: string; freshness: { health: string } } };
    expect(out.data.error).toBe('compiler unavailable');
    expect(out.data.freshness.health).toBe('unhealthy');
    expect(calls.indexed).not.toHaveBeenCalled();
  });

  it('keeps refused semantic intents outside both topology backends', async () => {
    const out = await graphQuery.handler(graphQuery.args.parse({ op: 'references', name: 'baselineTarget' }),
      { projectDir: '/baseline-repo' } as never) as { data: { error: string } };
    expect(out.data.error).toMatch(/does not answer/);
    expect(calls.compiler).not.toHaveBeenCalled();
    expect(calls.indexed).not.toHaveBeenCalled();
  });
});
