import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../voice-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../voice-credentials')>();
  return {
    ...actual,
    readElevenLabsKey: vi.fn(async () => 'api_key_id_123'),
    readOpenAiKey: vi.fn(async () => null),
    readCartesiaKey: vi.fn(async () => null),
  };
});
vi.mock('./operator-voice-proxy-helpers', () => ({
  probeKokoroHealth: vi.fn(async () => true),
  probeVoicemodeHealth: vi.fn(async () => false),
}));
vi.mock('../../../voice-node/kokoro-local', () => ({
  isKokoroLocalProvisioned: vi.fn(async () => true),
}));
vi.mock('../../../voice-node/local-voice-provision', () => ({
  getLocalVoiceProvisionStatus: vi.fn(async () => ({
    whisperBinary: { done: true },
    whisperModel: { done: true },
  })),
}));

import route from './operator-voice-engine-health';
import { readElevenLabsKey } from '../../../voice-credentials';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };

beforeEach(() => vi.clearAllMocks());

describe('operator voice engine health', () => {
  it('keeps local voice healthy while flagging an invalid legacy cloud key', async () => {
    const response = await (route as unknown as Route).handler(
      new Request('http://localhost/api/agent-mcp/operator-voice-engine-health'),
      { params: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kokoro: true,
      voicemode: true,
      localVoice: { kokoroProvisioned: true, whisperProvisioned: true },
      elevenlabs: false,
      elevenlabsConfigured: true,
      elevenlabsError: expect.stringMatching(/begin with sk_/),
    });
    expect(readElevenLabsKey).toHaveBeenCalledWith({ allowInvalid: true });
  });
});
