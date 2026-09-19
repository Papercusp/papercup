import { beforeEach, describe, expect, it, vi } from 'vitest';

const PORT_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = `${PORT_ID}.${'a'.repeat(64)}`;

const getSessionPortMock = vi.fn();
const transitionSessionPortMock = vi.fn();
const deleteSessionPortArtifactMock = vi.fn();
const parsePortTokenMock = vi.fn();
const verifyPortTokenMock = vi.fn();
const updateAdvSessionPortStatusMock = vi.fn();
const recordSessionPortTelemetryMock = vi.fn();

vi.mock('../../session-port/store', () => ({
  getSessionPort: (...args: unknown[]) => getSessionPortMock(...args),
  transitionSessionPort: (...args: unknown[]) => transitionSessionPortMock(...args),
}));

vi.mock('../../session-port/artifact', () => ({
  deleteSessionPortArtifact: (...args: unknown[]) =>
    deleteSessionPortArtifactMock(...args),
  parsePortToken: (...args: unknown[]) => parsePortTokenMock(...args),
  verifyPortToken: (...args: unknown[]) => verifyPortTokenMock(...args),
}));

vi.mock('../../session-port/telemetry', () => ({
  classifySessionPortFailure: vi.fn(() => 'target-routing'),
  recordSessionPortTelemetry: (...args: unknown[]) =>
    recordSessionPortTelemetryMock(...args),
  telemetryFromInspection: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-sessions')>()),
  updateAdvSessionPortStatus: (...args: unknown[]) =>
    updateAdvSessionPortStatusMock(...args),
}));

vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: vi.fn(async () => null),
}));
vi.mock('../../omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('../../omp-sessions', () => ({
  findOmpSessionNear: vi.fn(),
  getOmpSessionRowSummary: vi.fn(() => null),
  getOmpSessionState: vi.fn(),
  searchOmpSessions: vi.fn(),
}));

type Route = {
  method: string;
  path: string;
  handler: (request: Request, context?: unknown) => Promise<Response>;
};

async function delivery(body: Record<string, unknown>): Promise<Response> {
  const routes = (await import('../routes/adv/sessions')).default as Route[];
  const route = routes.find(
    (candidate) =>
      candidate.method === 'POST' &&
      candidate.path === '/adv/sessions/port/delivery',
  );
  if (!route) throw new Error('session-port delivery route not registered');
  return route.handler(
    new Request('http://localhost:3170/api/adv/sessions/port/delivery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        transformVersion: 3,
        workspace: 'papercusp-workspace',
        portId: PORT_ID,
        ...body,
      }),
    }),
  );
}

function port(overrides: Record<string, unknown> = {}) {
  return {
    id: PORT_ID,
    workspaceId: 'papercusp-workspace',
    protocolVersion: 1,
    status: 'prepared',
    sourceAdvSessionId: 41,
    targetAdvSessionId: null,
    sourceBackend: 'claude',
    targetBackend: 'codex',
    targetModel: 'gpt-5.6-sol:xhigh',
    tokenHash: 'token-hash',
    artifactPath: '/managed/port.seed.md',
    sourceHash: 'a'.repeat(64),
    normalizedHash: 'b'.repeat(64),
    renderedHash: 'c'.repeat(64),
    metadata: {},
    error: null,
    preparedAt: '2026-09-19T20:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionPortMock.mockResolvedValue(port());
  transitionSessionPortMock.mockImplementation(
    async (_id: string, _workspace: string, status: string, fields: object) =>
      port({ status, ...fields }),
  );
  deleteSessionPortArtifactMock.mockResolvedValue(true);
  parsePortTokenMock.mockImplementation((value: string) =>
    value === TOKEN ? { portId: PORT_ID, secret: 'a'.repeat(64) } : null,
  );
  verifyPortTokenMock.mockImplementation((value: string) => value === TOKEN);
  updateAdvSessionPortStatusMock.mockResolvedValue(true);
  recordSessionPortTelemetryMock.mockResolvedValue(true);
});

describe('POST /adv/sessions/port/delivery — post-prepare failure finalization', () => {
  it('token-finalizes a prepared row with no target and deletes its seed immediately', async () => {
    const response = await delivery({
      status: 'failed',
      preparationToken: TOKEN,
      error:
        'target bootstrap/spawn failed after preparation: prepared target did not match bootstrap',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'failed',
      targetAdvSessionId: null,
      artifactDeleted: true,
    });
    expect(transitionSessionPortMock).toHaveBeenCalledWith(
      PORT_ID,
      'papercusp-workspace',
      'failed',
      {
        error:
          'target bootstrap/spawn failed after preparation: prepared target did not match bootstrap',
      },
    );
    expect(deleteSessionPortArtifactMock).toHaveBeenCalledWith(
      '/managed/port.seed.md',
    );
    expect(updateAdvSessionPortStatusMock).not.toHaveBeenCalled();
    expect(recordSessionPortTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'failed',
        portId: PORT_ID,
        targetAdvSessionId: null,
        cleanupOutcome: 'deleted',
        failureClass: 'target-routing',
      }),
    );
  });

  it('refuses a no-target failure without the exact opaque preparation token', async () => {
    const response = await delivery({
      status: 'failed',
      preparationToken: `${PORT_ID}.${'b'.repeat(64)}`,
      error: 'bootstrap failed',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'valid preparationToken for this port is required',
    });
    expect(transitionSessionPortMock).not.toHaveBeenCalled();
    expect(deleteSessionPortArtifactMock).not.toHaveBeenCalled();
  });

  it('keeps the existing target-bound pending failure path unchanged', async () => {
    getSessionPortMock.mockResolvedValueOnce(
      port({ status: 'pending', targetAdvSessionId: 99 }),
    );
    const response = await delivery({
      status: 'failed',
      targetAdvSessionId: 99,
      error: 'native persistence verification failed',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'failed',
      artifactDeleted: true,
    });
    expect(updateAdvSessionPortStatusMock).toHaveBeenCalledWith(
      99,
      'papercusp-workspace',
      'failed',
      { deliveryError: 'native persistence verification failed' },
    );
  });
});
