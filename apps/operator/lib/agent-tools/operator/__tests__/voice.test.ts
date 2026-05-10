/**
 * operator:* voice tools — voice_utterance_log, voice_debug, voice_prefs,
 * conv_voice, voice_spend_summary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/voice-utterance-log');
  vi.doUnmock('@/lib/voice-debug-ring');
  vi.doUnmock('@/lib/voice-prefs');
  vi.doUnmock('@/lib/conv-voice');
  vi.doUnmock('@/lib/stt-spend');
  vi.doUnmock('@/lib/tts-spend');
  vi.doUnmock('@/lib/workspace-registry');
  vi.doUnmock('@restart/db-org');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('operator:voice_utterance_log', () => {
  it('returns the lib helper output', async () => {
    const logVoiceUtterance = vi.fn(async () => ({ ok: true }));
    vi.doMock('@/lib/voice-utterance-log', () => ({ logVoiceUtterance }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_utterance_log');
    const result = await tool.handler(
      { source: 'legacy', mode: 'm', lengthChars: 10 },
      MAKE_CTX(),
    );
    expect(logVoiceUtterance).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true });
  });

  it('passes degraded:true through verbatim', async () => {
    vi.doMock('@/lib/voice-utterance-log', () => ({
      logVoiceUtterance: vi.fn(async () => ({ ok: true, degraded: true })),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_utterance_log');
    const result = await tool.handler({ source: 'legacy' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.degraded).toBe(true);
  });
});

describe('operator:voice_debug', () => {
  it('append op writes to the ring', async () => {
    const appendVoiceDebugEvent = vi.fn(() => 5);
    vi.doMock('@/lib/voice-debug-ring', () => ({
      appendVoiceDebugEvent,
      readVoiceDebugEvents: vi.fn(),
      clearVoiceDebugEvents: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_debug');
    const result = await tool.handler(
      { op: 'append', event: 'wake-detected', detail: { x: 1 } },
      MAKE_CTX(),
    );
    expect(appendVoiceDebugEvent).toHaveBeenCalledWith({
      event: 'wake-detected',
      detail: { x: 1 },
      ts: undefined,
    });
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, count: 5 });
  });

  it('read op returns events', async () => {
    const events = [{ ts: 1, event: 'a' }];
    vi.doMock('@/lib/voice-debug-ring', () => ({
      appendVoiceDebugEvent: vi.fn(),
      readVoiceDebugEvents: vi.fn(() => events),
      clearVoiceDebugEvents: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_debug');
    const result = await tool.handler({ op: 'read' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ count: 1, events });
  });

  it('clear op rejects non-operator role at the handler level', async () => {
    vi.doMock('@/lib/voice-debug-ring', () => ({
      appendVoiceDebugEvent: vi.fn(),
      readVoiceDebugEvents: vi.fn(),
      clearVoiceDebugEvents: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_debug');
    await expect(
      tool.handler({ op: 'clear' }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/i);
  });

  it('clear op as operator flushes the ring', async () => {
    const clearVoiceDebugEvents = vi.fn(() => undefined);
    vi.doMock('@/lib/voice-debug-ring', () => ({
      appendVoiceDebugEvent: vi.fn(),
      readVoiceDebugEvents: vi.fn(),
      clearVoiceDebugEvents,
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_debug');
    const result = await tool.handler({ op: 'clear' }, MAKE_CTX({ role: 'operator' }));
    expect(clearVoiceDebugEvents).toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, cleared: true });
  });
});

describe('operator:voice_prefs', () => {
  it('get returns loadVoicePrefs result', async () => {
    vi.doMock('@/lib/voice-prefs', () => ({
      loadVoicePrefs: vi.fn(async () => ({ sttEngine: 'voicemode' })),
      saveVoicePrefs: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_prefs');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ sttEngine: 'voicemode' });
  });

  it('set passes patch verbatim to saveVoicePrefs', async () => {
    const saveVoicePrefs = vi.fn(async (p: unknown) => ({ ...(p as Record<string, unknown>) }));
    vi.doMock('@/lib/voice-prefs', () => ({
      loadVoicePrefs: vi.fn(),
      saveVoicePrefs,
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_prefs');
    await tool.handler(
      { op: 'set', patch: { sttEngine: 'deepgram' } },
      MAKE_CTX(),
    );
    expect(saveVoicePrefs).toHaveBeenCalledWith({ sttEngine: 'deepgram' });
  });
});

describe('operator:conv_voice', () => {
  it('get returns readConvVoice output', async () => {
    const readResult = {
      ok: true,
      voiceId: 'abc',
      voiceName: 'Rachel',
      modelId: 'eleven_turbo',
      agentId: 'agt_1',
    };
    vi.doMock('@/lib/conv-voice', () => ({
      readConvVoice: vi.fn(async () => readResult),
      setConvVoice: vi.fn(),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/conv_voice');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual(readResult);
  });

  it('set forwards voiceId + modelId to setConvVoice', async () => {
    const setConvVoice = vi.fn(async () => ({
      ok: true,
      voiceId: 'NEW',
      voiceName: 'NewVoice',
      modelId: 'eleven_turbo_v2',
    }));
    vi.doMock('@/lib/conv-voice', () => ({
      readConvVoice: vi.fn(),
      setConvVoice,
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/conv_voice');
    await tool.handler(
      { op: 'set', voiceId: 'NEWVOICEID12345', modelId: 'eleven_turbo_v2' },
      MAKE_CTX(),
    );
    expect(setConvVoice).toHaveBeenCalledWith({
      voiceId: 'NEWVOICEID12345',
      modelId: 'eleven_turbo_v2',
    });
  });
});

describe('operator:voice_spend_summary', () => {
  it('scope=all returns merged el/stt/tts', async () => {
    vi.doMock('@/lib/stt-spend', () => ({
      loadSttSpend: vi.fn(async () => ({ todayUsd: 0.1 })),
    }));
    vi.doMock('@/lib/tts-spend', () => ({
      loadSpend: vi.fn(async () => ({ perKCharRate: 0.18 })),
    }));
    vi.doMock('@/lib/voice-prefs', () => ({
      loadVoicePrefs: vi.fn(async () => ({ fullAgentMonthlyMinuteCap: 600 })),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    vi.doMock('@restart/db-org', () => ({
      withWorkspace: vi.fn(async (_w: string, fn: (tx: unknown) => Promise<unknown>) => {
        return fn(async () => [{ total: 60 }]);
      }),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_spend_summary');
    const result = await tool.handler({ scope: 'all' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.stt).toBeDefined();
    expect(payload.tts).toBeDefined();
    expect(payload.el).toBeDefined();
    expect((payload.tts as Record<string, unknown>).perKCharRate).toBe(0.18);
  });

  it('scope=stt returns only stt', async () => {
    vi.doMock('@/lib/stt-spend', () => ({
      loadSttSpend: vi.fn(async () => ({ todayUsd: 0.5 })),
    }));
    vi.doMock('@/lib/tts-spend', () => ({ loadSpend: vi.fn() }));
    vi.doMock('@/lib/voice-prefs', () => ({ loadVoicePrefs: vi.fn() }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: vi.fn(() => 'default'),
    }));
    const { default: tool } = await import('@/lib/agent-tools/operator/voice_spend_summary');
    const result = await tool.handler({ scope: 'stt' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ stt: { todayUsd: 0.5 } });
    expect(payload.el).toBeUndefined();
    expect(payload.tts).toBeUndefined();
  });
});
