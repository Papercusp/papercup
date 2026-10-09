// Unit-level handler wiring proof: backend boundaries are mocked. Database,
// daemon and deployed behavior retain their separate integration obligations.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ compiler: vi.fn(), indexed: vi.fn() }));
vi.mock('./first-party-callers-offthread', () => ({ firstPartyCallersOffthread: calls.compiler }));
vi.mock('./gitnexus-facade', async importOriginal => ({
  ...await importOriginal<typeof import('./gitnexus-facade')>(), gitnexusFacade: calls.indexed,
}));
import graphQuery from '../agent-tools/gitnexus/query';

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
});

describe('native baseline against the exposed graph handler', () => {
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
