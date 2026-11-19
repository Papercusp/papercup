import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isolatedRuntimeEvidenceKeys, isolatedRuntimeInheritedEnvironment } from '../../../scripts/lib/with-test-pg-env.mjs';
import { listMcpProjections } from '@papercusp/tooldef';

const originalArgv = process.argv;

const state = vi.hoisted(() => ({
  primary: new Error('request listener failed'),
  cleanup: new Error('request listener cleanup failed'),
  cleanupFails: false,
}));

// Keep the real built-in exports while replacing fixture Git and worker launch.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => 'fixture-head'),
  fork: vi.fn(),
}));
vi.mock('node:crypto', async original => ({
  ...await original<typeof import('node:crypto')>(), randomUUID: () => 'fixture-token',
}));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(), writeFileSync: vi.fn(),
    // Fixture paths read as absent; real source modules in the partial db-org graph (for example
    // a module-scope self-digest) still read their own files.
    readFileSync: vi.fn(((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
      String(path).startsWith('/fixture/')
        ? undefined
        : (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync),
  };
});
vi.mock('node:http', () => ({ createServer: () => ({
  once: vi.fn(),
  listen: () => { throw state.primary; },
  closeAllConnections: () => { if (state.cleanupFails) throw state.cleanup; },
  close: (done: () => void) => done(),
}) }));
vi.mock('@hono/node-server', () => ({ getRequestListener: () => vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { end: vi.fn() } }), _resetForTests: vi.fn(),
}));
vi.mock('../../../apps/operator/bin/host-handler', () => ({ handler: vi.fn() }));
vi.mock('../../../apps/operator/lib/mcp-proxy/proxy', () => ({ createMcpProxy: vi.fn(), readMcpWorkerTargets: vi.fn() }));
vi.mock('../lib/harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })), saveHarnessRegistry: vi.fn(),
}));
vi.mock('../lib/endpoint-ipc-discovery', () => ({ writeEndpointIpcDiscovery: vi.fn() }));
vi.mock('../lib/superuser-token', () => ({
  readSuperuserToken: () => 'fixture-token', superuserTokenPath: () => '/fixture/token',
}));
vi.mock('../lib/serving-host-identity', () => ({ getServingHostIdentity: vi.fn() }));
vi.mock('../lib/process-identity', () => ({ readProcessIdentity: vi.fn() }));
vi.mock('../lib/memory/embed-sidecar-server', () => ({ runEmbedSidecarServer: vi.fn() }));
// These services are reached only after the request listener starts. The
// cleanup test deliberately fails there, so importing their real platform
// graph adds unrelated startup work before either assertion can run.
vi.mock('../lib/harness/git-sync/git-sync-action', () => ({ registerGitSyncResource: vi.fn() }));
vi.mock('../lib/agent-tools/locks/in-workspace-txn', () => ({ inWorkspaceTxn: vi.fn() }));
vi.mock('../lib/events/await/store', () => ({ registerAwait: vi.fn(), listActiveAwaits: vi.fn() }));
vi.mock('../lib/events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  process.argv = [...originalArgv, '--source-root=/fixture/source'];
  vi.stubEnv('FRICTION_SOURCE_ROOT', undefined);
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'test-runtime-cleanup-proof');
  vi.stubEnv('PAPERCUSP_PG_PORT', '65432');
  vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
  vi.stubEnv('PAPERCUSP_DBOS_ROUTINES', '0');
  vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
  vi.stubEnv('PAPERCUSP_EMBED_SIDECAR_MODE', '0');
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('requires an explicit source-root argument even when an ambient source root is present', async () => {
  process.argv = originalArgv;
  vi.stubEnv('FRICTION_SOURCE_ROOT', '/ambient/source');
  const { runGitSyncTargetWorkerFixture } = await import('./git-sync-target-worker-fixture');
  await expect(runGitSyncTargetWorkerFixture())
    .rejects.toThrow('explicit source root required for the bundled private fixture');
});

it('enters the embed sidecar without fixture argv or isolated-runtime assertions', async () => {
  process.argv = originalArgv;
  vi.stubEnv('PAPERCUSP_EMBED_SIDECAR_MODE', '1');
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', undefined);
  vi.stubEnv('PAPERCUSP_PG_PORT', '5432');
  vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', undefined);
  vi.stubEnv('PAPERCUSP_DBOS_ROUTINES', undefined);
  const { runEmbedSidecarServer } = await import('../lib/memory/embed-sidecar-server');
  await import('./git-sync-target-worker-fixture');
  expect(runEmbedSidecarServer).toHaveBeenCalledOnce();
});

it('validates the real public metadata-worker request schema without assuming root properties', async () => {
  await import('../lib/agent-tools/git_sync/run');
  const { assertMetadataRepairCatalog } = await import('./git-sync-target-worker-fixture');
  const tools = listMcpProjections('operator', 'engineer');
  const request = { installSlug: 'private-fixture', target: { environment: 'staging',
    buildSha: 'a'.repeat(40), installRoot: '/fixture/source' }, repairMetadata: {
    base: 'b'.repeat(40), expectedPendingLockSha256: 'c'.repeat(64), requestId: 'fixture',
    generation: 1, publishedLibrarySelections: [],
  } };
  expect(tools.find(entry => entry.name === 'git-sync:run')).toBeDefined();
  expect(() => assertMetadataRepairCatalog(tools, request)).not.toThrow();
  expect(() => assertMetadataRepairCatalog([], request)).toThrow('must contain git-sync:run');
  expect(() => assertMetadataRepairCatalog(tools, { ...request,
    repairMetadata: { ...request.repairMetadata, generation: 0 } })).toThrow('rejects metadata repair');
  for (const omitted of ['repairMetadata', 'target']) {
    const properties = { installSlug: { type: 'string' },
      repairMetadata: { type: 'object', required: ['base'] }, target: { type: 'object', required: ['buildSha'] } };
    delete properties[omitted as 'repairMetadata' | 'target'];
    expect(() => assertMetadataRepairCatalog([{ name: 'git-sync:run', inputSchema: {
      type: 'object', properties,
    } }], request)).toThrow(omitted === 'target' ? 'must validate the exact target' : 'must validate metadata repair');
  }
});

it.each([0, 1, 12])('finds the exact metadata tool after %s catalog pages and follows every cursor', async before => {
  const { readMetadataRepairCatalog } = await import('./git-sync-target-worker-fixture');
  const tool = { name: 'git-sync:run', inputSchema: { type: 'object' as const } };
  const listTools = vi.fn();
  for (let index = 0; index < before; index++) {
    listTools.mockResolvedValueOnce({ tools: [{ ...tool, name: 'other:tool' }], nextCursor: `page-${index + 1}` });
  }
  listTools.mockResolvedValueOnce({ tools: [tool] });
  expect((await readMetadataRepairCatalog({ listTools })).tools).toEqual([tool]);
  expect(listTools).toHaveBeenCalledTimes(before + 1);
  expect(listTools.mock.calls.map(([params]) => params)).toEqual([
    undefined, ...Array.from({ length: before }, (_, index) => ({ cursor: `page-${index + 1}` })),
  ]);
});

it('reports an absent metadata tool only after exhausting catalog recovery', async () => {
  const { readMetadataRepairCatalog, assertMetadataRepairCatalog } = await import('./git-sync-target-worker-fixture');
  const listTools = vi.fn().mockResolvedValueOnce({ tools: [], nextCursor: 'last-page' })
    .mockResolvedValueOnce({ tools: [] });
  const catalog = await readMetadataRepairCatalog({ listTools });
  expect(listTools).toHaveBeenCalledTimes(2);
  expect(() => assertMetadataRepairCatalog(catalog.tools, {})).toThrow('must contain git-sync:run');
});

it.each([false, true])('retains the original worker scenario failure when cleanup fails: %s', async cleanupFails => {
  state.cleanupFails = cleanupFails;
  const inherited = isolatedRuntimeInheritedEnvironment({
    FRICTION_SOURCE_ROOT: '/ambient/source', FRICTION_RELEASE_CONTINUATION: '1',
  }, isolatedRuntimeEvidenceKeys('owned-test-db-directory'));
  expect(inherited.environment).toEqual({});
  expect(inherited.discardedKeys).toEqual(['FRICTION_RELEASE_CONTINUATION', 'FRICTION_SOURCE_ROOT']);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runGitSyncTargetWorkerFixture } = await import('./git-sync-target-worker-fixture');
  const reported = await runGitSyncTargetWorkerFixture().catch(error => error);
  if (cleanupFails) {
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([state.primary, state.cleanup]);
    expect((reported as Error).message).toContain(state.primary.message);
    expect((reported as Error).message).toContain(state.cleanup.message);
  } else {
    expect(reported).toBe(state.primary);
  }
});
