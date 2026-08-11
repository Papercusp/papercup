import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../voice-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../voice-credentials')>();
  return {
    ...actual,
    readElevenLabsKey: vi.fn(async () => null),
    readOpenAiKey: vi.fn(async () => null),
    readCartesiaKey: vi.fn(async () => null),
    readDeepgramKey: vi.fn(async () => null),
    readPicovoiceKey: vi.fn(async () => null),
    writeElevenLabsKey: vi.fn(async () => undefined),
    writeOpenAiKey: vi.fn(async () => undefined),
    writeCartesiaKey: vi.fn(async () => undefined),
    writeDeepgramKey: vi.fn(async () => undefined),
    writePicovoiceKey: vi.fn(async () => undefined),
  };
});

import { readElevenLabsKey, writeElevenLabsKey } from '../../../voice-credentials';
import routes from './operator-credentials';

type Route = {
  handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response>;
};

const [getRoute, putRoute] = routes as unknown as [Route, Route];

function put(body: unknown): Promise<Response> {
  return putRoute.handler(
    new Request('http://localhost/api/agent-mcp/operator-credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

beforeEach(() => vi.clearAllMocks());

describe('operator credentials ElevenLabs validation', () => {
  it('rejects an API key ID before persisting it', async () => {
    const response = await put({ elevenlabsApiKey: 'api_key_id_123' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'invalid_elevenlabs_api_key',
    });
    expect(writeElevenLabsKey).not.toHaveBeenCalled();
  });

  it('reports a legacy API key ID as unhealthy', async () => {
    vi.mocked(readElevenLabsKey).mockResolvedValue('api_key_id_123');
    const response = await getRoute.handler(
      new Request('http://localhost/api/agent-mcp/operator-credentials'),
      { params: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      elevenlabs: {
        configured: false,
        healthy: false,
        error: expect.stringMatching(/begin with sk_/),
      },
    });
  });
});
