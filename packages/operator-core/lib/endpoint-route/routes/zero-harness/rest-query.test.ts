import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveNamedQueryMock = vi.fn();
const observeResolveMock = vi.fn();
const serializeJsonResponseMock = vi.fn(async (value: unknown, _itemCount?: number) => JSON.stringify(value));

vi.mock('../../../sync-resolver', () => ({
  resolveNamedQueryV2: (...args: unknown[]) => resolveNamedQueryMock(...args),
  NAME_NOT_FOUND: Symbol('NAME_NOT_FOUND'),
}));
vi.mock('../../../sync-resolver/resolve-observability', () => ({
  observeResolve: (input: unknown) => observeResolveMock(input),
}));
vi.mock('../../../sync-resolver/resource-delta-config', () => ({ resourceDeltaConfig: () => undefined }));
vi.mock('@papercusp/tooldef', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef')>()),
  negotiateRowsDelta: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (input: unknown) => input }));
vi.mock('../../../cpu-task-worker', () => ({
  serializeJsonResponse: (value: unknown, itemCount: number) => serializeJsonResponseMock(value, itemCount),
}));

type RestRoute = {
  auth?: unknown;
  handler: (req: Request) => Promise<Response>;
};

async function route(): Promise<RestRoute> {
  return (await import('./rest-query')).default as unknown as RestRoute;
}

beforeEach(() => {
  vi.clearAllMocks();
  serializeJsonResponseMock.mockImplementation(async (value: unknown, _itemCount?: number) => JSON.stringify(value));
});

describe('GET /zero-harness/rest-query stale-process diagnosis', () => {
  it('keeps the sync read surface loopback-only', async () => {
    expect((await route()).auth).toBe('loopback');
  });

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
    expect(observeResolveMock).toHaveBeenCalledTimes(1);
  });

  it('records a post-resolver response failure before returning 500', async () => {
    resolveNamedQueryMock.mockResolvedValueOnce([{ id: 'run-1' }]);
    serializeJsonResponseMock.mockRejectedValueOnce(new Error('serialization worker unavailable'));

    const response = await (await route()).handler(
      new Request(
        'http://localhost:3070/api/zero-harness/rest-query?name=workItemAdmission.runs&args=%7B%22harnessSlug%22%3A%22papercusp%22%2C%22limit%22%3A200%7D',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'serialization worker unavailable',
      name: 'workItemAdmission.runs',
    });
    expect(observeResolveMock).toHaveBeenCalledTimes(2);
    expect(observeResolveMock.mock.calls[1]?.[0]).toMatchObject({
      name: 'workItemAdmission.runs',
      argsJson: '{"harnessSlug":"papercusp","limit":200}',
      error: expect.objectContaining({
        message: 'post-resolve response failed: serialization worker unavailable',
      }),
    });
  });

  it('carries resolver timing with an explicit millisecond unit on successful reads', async () => {
    resolveNamedQueryMock.mockResolvedValueOnce([{ id: 'p-1' }]);

    const response = await (await route()).handler(
      new Request('http://localhost:3070/api/zero-harness/rest-query?name=plans.list&args=%7B%7D'),
    );
    const body = (await response.json()) as {
      timing?: {
        unit: string;
        resolverStartedAtMs: number;
        resolverCompletedAtMs: number;
        resolverMs: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.timing?.unit).toBe('ms');
    expect(body.timing?.resolverCompletedAtMs).toBeGreaterThanOrEqual(body.timing?.resolverStartedAtMs ?? 0);
    expect(body.timing?.resolverMs).toBe(
      body.timing!.resolverCompletedAtMs - body.timing!.resolverStartedAtMs,
    );
  });
});
