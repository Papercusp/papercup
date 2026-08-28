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
vi.mock('../../../voice-node/local-whisper-service', () => ({
  warmLocalWhisper: vi.fn(async () => ({ ok: true, source: 'managed' })),
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
      localVoice: {
        kokoroProvisioned: true,
        whisperProvisioned: true,
        whisper: { ok: true, source: 'managed' },
      },
      elevenlabs: false,
      elevenlabsConfigured: true,
      elevenlabsError: expect.stringMatching(/begin with sk_/),
    });
    expect(readElevenLabsKey).toHaveBeenCalledWith({ allowInvalid: true });
  });

  it('does not call a provisioned Whisper capability healthy when its endpoint cannot warm', async () => {
    const { warmLocalWhisper } = await import('../../../voice-node/local-whisper-service');
    vi.mocked(warmLocalWhisper).mockResolvedValueOnce({
      ok: false,
      reason: 'unhealthy',
      detail: 'managed endpoint did not answer /health',
    });

    const response = await (route as unknown as Route).handler(
      new Request('http://localhost/api/agent-mcp/operator-voice-engine-health'),
      { params: {} },
    );
    expect(await response.json()).toMatchObject({
      voicemode: false,
      localVoice: {
        whisperProvisioned: true,
        whisper: { ok: false, reason: 'unhealthy' },
      },
    });
  });
});
