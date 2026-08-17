import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveNamedQueryMock = vi.fn();

vi.mock('../../../sync-resolver', () => ({
  resolveNamedQueryV2: (...args: unknown[]) => resolveNamedQueryMock(...args),
  NAME_NOT_FOUND: Symbol('NAME_NOT_FOUND'),
}));
vi.mock('../../../sync-resolver/resolve-observability', () => ({ observeResolve: vi.fn() }));
vi.mock('../../../sync-resolver/resource-delta-config', () => ({ resourceDeltaConfig: () => undefined }));
vi.mock('@papercusp/tooldef', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef')>()), negotiateRowsDelta: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()), defineTool: (input: unknown) => input }));
vi.mock('../../../cpu-task-worker', () => ({
  serializeJsonResponse: async (value: unknown) => JSON.stringify(value),
}));

type RestRoute = {
  handler: (req: Request) => Promise<Response>;
};

async function route(): Promise<RestRoute> {
  return (await import('./rest-query')).default as unknown as RestRoute;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /zero-harness/rest-query stale-process diagnosis', () => {
  it('turns an ESM link failure into an actionable stale-operator response', async () => {
    resolveNamedQueryMock.mockRejectedValueOnce(
      new Error(
        "The requested module '@papercusp/orchestrator/codex-gateway-config' does not provide an export named 'codexManagedFeaturesToml'",
      ),
    );

    const response = await (await route()).handler(
      new Request(
        'http://localhost:3070/api/zero-harness/rest-query?name=agentDetail.byOwner&args=%7B%7D',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      name: 'agentDetail.byOwner',
      code: 'stale_operator_module_link',
      staleOperator: true,
    });
    expect(body.error).toMatchObject(expect.any(String));
    expect(body.error).toContain('Restart the operator process');
  });

  it('keeps ordinary resolver failures as ordinary 500 responses', async () => {
    resolveNamedQueryMock.mockRejectedValueOnce(new Error('database connection refused'));

    const response = await (await route()).handler(
      new Request('http://localhost:3070/api/zero-harness/rest-query?name=plans.list&args=%7B%7D'),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'database connection refused', name: 'plans.list' });
  });
});
