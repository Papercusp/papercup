/** SCRATCH — delete me. Verifies the mcp-handler capture harness works. */
import { describe, it, expect, vi } from 'vitest';

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;
const captured: Array<{ schema: unknown; fn: Handler }> = [];

vi.mock('mcp-handler', () => ({
  createMcpHandler: (setup: (server: unknown) => void) => {
    const fakeServer = {
      server: {
        setRequestHandler: (schema: unknown, fn: Handler) => {
          captured.push({ schema, fn });
        },
      },
    };
    setup(fakeServer);
    return async () => new Response('ok');
  },
}));

vi.mock('../../agent-tools/index', () => ({}));
vi.mock('../../spawn-signing', () => ({
  verifySpawnParams: vi.fn(async () => ({ ok: true })),
  logVerificationFailure: vi.fn(async () => {}),
}));
vi.mock('../../power-user-token', () => ({
  verifyAccessToken: vi.fn(async () => null),
}));
vi.mock('../../resolve-harness-paths', () => ({
  resolveHarnessPaths: vi.fn(async () => ({ projectDir: '/tmp/p', stateDir: '/tmp/s' })),
}));
vi.mock('../../plugin-spawn-impl', () => ({
  pluginSpawnImpl: vi.fn(),
  secretImpl: vi.fn(),
  makeSecretResolver: vi.fn(() => vi.fn()),
}));
vi.mock('../../projected-tool-deps', () => ({
  PROJECTED_DEPS: {},
  setReactionPostInvoke: vi.fn(),
  setPreconditionFire: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fakeSql = (() => Promise.resolve([])) as unknown;
  return {
    ...actual,
    getOrgPg: () => ({ sql: fakeSql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(fakeSql),
  };
});

describe('scratch capture', () => {
  it('captures list/call handlers', async () => {
    await import('../routes/transport/_mcp-handler');
    console.error('captured handlers:', captured.length);
    const sdk = await import('@modelcontextprotocol/sdk/types.js');
    const idx = captured.findIndex((c) => c.schema === sdk.ListToolsRequestSchema);
    console.error('list idx by identity:', idx);
    for (const c of captured) {
      const s = c.schema as { shape?: { method?: { value?: unknown } } };
      console.error('schema method:', s?.shape?.method?.value);
    }
    expect(captured.length).toBeGreaterThanOrEqual(2);
  });
});
