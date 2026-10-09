/** P-001 baseline proof through the actual handler, compiler and forked worker. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// Enable the interfaces in this isolated fixture; analysis/transport code is real.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';
import { runLspDaemonServer } from './lsp-daemon-server';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import type { CodeIntelAnswer } from './contracts';
import { admitArm } from './fair-comparison-admission';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../docs/evidence/native-code-intelligence-baseline-2026-10-09.json', import.meta.url,
)), 'utf8')) as { routes: Array<{ tool: string; operations: string[]; backend?: string }> };

let root = '';
let server: Server;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
const rpcOperations: string[] = [];
const put = (path: string, text: string) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'native-baseline-'));
  put('tsconfig.json', JSON.stringify({ compilerOptions: {
    target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true,
  } }));
  put('src/target.ts', 'export function baselineTarget(n: number) { return n + 1; }\n');
  put('src/barrel.ts', 'export * from "./target";\n');
  put('src/consumer.ts', [
    'import { baselineTarget } from "./barrel";',
    '// baselineTarget(99) is a comment',
    'export const label = "baselineTarget(99) is a string";',
    'export const answer = baselineTarget(1);',
    '',
  ].join('\n'));
  process.env[LSP_DAEMON_SOCKET_ENV] = join(root, 'baseline.sock');
  server = runLspDaemonServer(async request => {
    rpcOperations.push(request.op);
    expect(request.args.rootPath).toBe(root);
    // Provider fixture models the daemon seam. This proves handler/facade/RPC
    // selection, while the compiler tests below independently exercise TS.
    return { backend: 'lsp-adapter', intent: 'references', query: request.op,
      sites: [{ path: 'src/consumer.ts', line1: 4, kind: 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null },
      latencyMs: 0, error: null };
  });
  await once(server, 'listening');
});
afterAll(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  if (root) rmSync(root, { recursive: true, force: true });
});

const query = async (name: string, paths?: string[]): Promise<CodeIntelAnswer> => {
  const result = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name, paths }),
    { projectDir: root } as never) as { data: CodeIntelAnswer };
  return result.data;
};
const locations = (answer: CodeIntelAnswer) => answer.sites.map(site => `${site.path}:${site.line1}`).sort();

describe('native baseline real compiler route', () => {
  it('matches the recorded route and an independently enumerated barrel consumer', async () => {
    const answer = await query('baselineTarget');
    const recorded = baseline.routes.find(row => row.tool === 'graph:query' && row.operations.includes('callers'));
    expect(answer.error).toBeNull();
    expect(answer.backend).toBe(recorded?.backend);
    // Literal oracle: declarations, comments and strings are deliberately excluded.
    expect(locations(answer)).toEqual(['src/consumer.ts:4']);
    expect(answer.freshness.health).toBe('healthy');
  }, 60_000);

  it('reconciles changed and deleted callers from current source rather than an old index', async () => {
    put('src/changed.ts', 'import { baselineTarget } from "./target";\nexport const fresh = baselineTarget(2);\n');
    try {
      expect(locations(await query('baselineTarget'))).toEqual(['src/changed.ts:2', 'src/consumer.ts:4']);
      put('src/changed.ts', '// baselineTarget(2) was removed\nexport const fresh = 2;\n');
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
      rmSync(join(root, 'src/changed.ts'));
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
    } finally { rmSync(join(root, 'src/changed.ts'), { force: true }); }
  }, 60_000);

  it('distinguishes a measured empty from an invalid search scope', async () => {
    const empty = await query('absentBaselineSymbol');
    expect(empty.error).toBeNull();
    expect(empty.sites).toEqual([]);
    expect(empty.freshness.health).toBe('healthy');
    const refused = await query('baselineTarget', ['../outside']);
    expect(refused.error).toMatch(/outside the repository/);
    expect(refused.freshness.health).toBe('unhealthy');
  }, 60_000);

  it('preserves the separate internal-comparison and distribution decisions', () => {
    expect(admitArm('gitnexus@1.6.9').admission.distribution?.decision).toBe('excluded');
    expect(() => admitArm('gitnexus@1.6.9', undefined, 'distribution')).toThrow(/excluded from product distribution/);
    expect(() => admitArm('no-third-party', undefined, 'distribution')).toThrow(/no explicit approved decision/);
  });
});

describe('native baseline admitted operation inventory across real interfaces', () => {
  const operations = (tool: string) => baseline.routes.filter(row => row.tool === tool)
    .flatMap(row => row.operations.map(op => ({ op, backend: row.backend })));

  it.each(operations('graph:query').filter(row => row.op !== 'callers'))(
    'graph $op reaches the recorded $backend provider through the actual facade', async ({ op, backend }) => {
      const dispatched: string[] = [];
      const result = await graphQuery.handler(graphQuery.args.parse({ op, name: 'baselineTarget' }), {
        projectDir: root,
        dispatchTool: async (tool: string) => {
          dispatched.push(tool);
          throw new Error('baseline indexed provider sentinel');
        },
      } as never) as { data: CodeIntelAnswer };
      expect(result.data.backend).toBe(backend);
      expect(result.data.error).toContain('baseline indexed provider sentinel');
      expect(dispatched[0]).toBe('gitnexus.list_repos');
      expect(dispatched).toEqual(op === 'health' ? ['gitnexus.list_repos']
        : ['gitnexus.list_repos', op === 'impact' ? 'gitnexus.impact' : 'gitnexus.context']);
    });

  it.each(operations('lsp:query'))('LSP $op crosses the real daemon RPC route', async ({ op, backend }) => {
    const before = rpcOperations.length;
    const result = await lspQuery.handler(lspQuery.args.parse({ op, file: 'src/target.ts',
      line1: 1, character: 17, name: 'baselineTarget', newName: 'renamed' }),
    { projectDir: root, workspaceId: 'native-baseline-fixture' } as never) as { data: CodeIntelAnswer };
    expect(result.data.error).toBeNull();
    expect(result.data.backend).toBe(backend);
    expect(result.data.sites).toEqual([{ path: 'src/consumer.ts', line1: 4, kind: 'reference' }]);
    expect(rpcOperations.slice(before)).toEqual([op]);
  });

  it.each(operations('code:pack'))('packing $op selects the recorded $backend engine in the actual facade',
    async ({ op, backend }) => {
      const result = await codePack.handler(codePack.args.parse({ op, include: ['src/**'] }),
        { projectDir: root } as never) as { data: { answer: CodeIntelAnswer } };
      expect(result.data.answer.backend).toBe(backend);
      // The fixture has no git repository; diff/provisioning failures remain
      // typed errors. Only engine selection is the inventory claim here.
      expect(result.data.answer).toHaveProperty('error');
    }, 60_000);
});
