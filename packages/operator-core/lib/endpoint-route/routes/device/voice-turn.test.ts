/**
 * EI-13027 regression — the mobile desktop-local voice route must NOT silently
 * drop a turn.
 *
 * SYMPTOM: the STT leg lands a `voice_stt` row, but occasionally the brain
 * stream completes with an EMPTY completion (a silently-dropped brain call, which
 * correlates with pool latency under load). The old route then persisted no
 * assistant turn, emitted no audio, AND surfaced no error — it fired a silent
 * `done`, so the phone showed / spoke nothing and the user experienced a dropped
 * turn (no `voice_tts`, no error, self-recovers on retry).
 *
 * FIX: when the brain produces no reply, surface the existing `error` surface
 * (which already-shipped clients render as a retry prompt) instead of a silent
 * `done`. A deliberate `<sleep>` going-silent turn is NOT a drop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VOICE_BRAIN_NO_REPLY_MESSAGE, voiceTurnProducedNoReply } from '../../../voice-turn-deadline';

// ── heavy-dep mocks: isolate the STT→brain→(no)reply wiring ─────────────────
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../require-flag', () => ({ gateApiRoute: vi.fn(async () => null) }));
vi.mock('./_shared', () => ({
  DEVICE_AUTH: 'device',
  devicePrincipal: () => ({ slug: 'dev-1', label: 'Phone' }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ humanFacingRole: 'operator' })),
}));
vi.mock('../../../voice-node/kokoro-local', () => ({ kokoroTtsAvailable: vi.fn(async () => false) }));
vi.mock('../../../voice-node/local-whisper-service', () => ({
  whisperSttBaseUrl: () => 'http://whisper.stub',
  warmLocalWhisper: vi.fn(async () => ({ ok: true, source: 'managed' })),
}));
vi.mock('../agent-mcp/tts-synth', () => ({ synthesize: vi.fn() }));
vi.mock('../agent-mcp/operator-voice-proxy-helpers', () => ({
  decodeAudioBase64: () => ({ ok: true, audio: Buffer.from([1, 2, 3]) }),
  normalizeAudioFormat: () => 'wav',
  // TTS off — isolate the brain path so `speak()` never runs and audioSeq stays 0.
  resolveTtsEngine: vi.fn(async () => ({ ok: false, error: 'tts-disabled-in-test' })),
  MAX_TEXT_CHARS: 4000,
}));
vi.mock('../../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
  appendTurn: vi.fn(async () => ({ id: 't', seq: 1 })),
  listTurnsRecent: vi.fn(async () => ({ turns: [] })),
}));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

// dispatchProjectedToolStream + lookupByMcpName are overridden; defineTool /
// emitToSseSink stay real so the route builds and streams normally.
const dispatchMock = vi.fn();
vi.mock('@papercusp/agent-mcp', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    lookupByMcpName: vi.fn(() => ({ name: 'operator:converse' })),
    dispatchProjectedToolStream: (...args: unknown[]) => dispatchMock(...args),
  };
});

// Capture the SSE sink so we can assert exactly which events the turn emitted.
interface CapturedEvent {
  name: string;
  data: unknown;
}
const captured: { events: CapturedEvent[]; ready: Promise<void> } = {
  events: [],
  ready: Promise.resolve(),
};
vi.mock('@papercusp/sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sse')>()),
  sseResponse: ({ setup }: { setup: (sink: unknown) => Promise<void> | void }) => {
    const events: CapturedEvent[] = [];
    const sink = {
      event: (name: string, data: unknown) => events.push({ name, data }),
      done: (data: unknown) => events.push({ name: 'done', data }),
      close: () => {},
      onClose: (_fn: () => void) => {},
    };
    captured.events = events;
    captured.ready = Promise.resolve(setup(sink)).then(() => {});
    return new Response(null, { status: 200 });
  },
}));

import routes from './voice-turn';
import { appendTurn } from '../../../operator-conversations';

const append = vi.mocked(appendTurn);

type RouteTool = {
  method: string;
  path: string;
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};
const [voiceTurn] = routes as unknown as RouteTool[];

/** A dispatchProjectedToolStream stub that yields one `done` with the given assembled turn. */
function brainYielding(assembled: string): void {
  dispatchMock.mockImplementation(async function* () {
    yield {
      kind: 'done',
      result: { content: [{ text: JSON.stringify({ totalCost: 0.001, assembled }) }] },
    };
  });
}

/** A stub that streams raw `delta` chunks (tag protocol included) before `done`. */
function brainStreaming(chunks: string[], assembled: string): void {
  dispatchMock.mockImplementation(async function* () {
    for (const text of chunks) {
      yield { kind: 'event', name: 'delta', data: { text } };
    }
    yield {
      kind: 'done',
      result: { content: [{ text: JSON.stringify({ totalCost: 0.001, assembled }) }] },
    };
  });
}

function turnReq(): Request {
  return new Request('http://127.0.0.1/device/voice/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: 'AQID', format: 'wav' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // STT: whisper returns a real question.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'How many legs does a spider have?' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voiceTurnProducedNoReply', () => {
  it('is true for an empty completion (no say/report/audio, not silent)', () => {
    expect(voiceTurnProducedNoReply({ say: null, report: null, audioChunks: 0 })).toBe(true);
    expect(voiceTurnProducedNoReply({ say: '   ', report: null, audioChunks: 0 })).toBe(true);
  });
  it('is false when there is spoken/persisted content or audio', () => {
    expect(voiceTurnProducedNoReply({ say: 'hi', report: null, audioChunks: 0 })).toBe(false);
    expect(voiceTurnProducedNoReply({ say: null, report: { a: 1 }, audioChunks: 0 })).toBe(false);
    expect(voiceTurnProducedNoReply({ say: null, report: null, audioChunks: 2 })).toBe(false);
  });
  it('is false for a deliberate <sleep> going-silent turn', () => {
    expect(
      voiceTurnProducedNoReply({ say: null, report: null, audioChunks: 0, wentSilent: true }),
    ).toBe(false);
  });
});

describe('POST /device/voice/turn — EI-13027 no-reply drop', () => {
  it('surfaces a retry error (not a silent done) when the brain yields an empty completion', async () => {
    brainYielding(''); // the silent-drop case: STT logged, brain produced nothing
    await voiceTurn.handler(turnReq(), { params: {} });
    await captured.ready;

    const names = captured.events.map((e) => e.name);
    // The regression: an error is surfaced, and NO silent `done` fires.
    expect(names).toContain('error');
    expect(names).not.toContain('done');
    const err = captured.events.find((e) => e.name === 'error');
    expect(err?.data).toMatchObject({ stage: 'brain', message: VOICE_BRAIN_NO_REPLY_MESSAGE });
    // Only the user (voice_stt) turn was persisted — never an empty assistant turn.
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({ source: 'voice_stt' });
  });

  it('emits clean sentence deltas — raw <say>/tag markup never hits the wire (EI-13172)', async () => {
    // Tag split across chunk boundaries — the streaming case that defeats a
    // naive per-chunk regex strip.
    brainStreaming(
      ['<sa', 'y>A spider has eight legs.', ' Neat!</say', '>'],
      '<say>A spider has eight legs. Neat!</say>',
    );
    await voiceTurn.handler(turnReq(), { params: {} });
    await captured.ready;

    const deltas = captured.events.filter((e) => e.name === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    const joined = deltas.map((d) => (d.data as { text: string }).text).join('');
    expect(joined).toBe('A spider has eight legs. Neat!');
    expect(joined).not.toContain('<');
    // The turn still completes and persists the clean say text.
    expect(captured.events.map((e) => e.name)).toContain('done');
    expect(append.mock.calls[1][0]).toMatchObject({
      source: 'voice_tts',
      text: 'A spider has eight legs. Neat!',
    });
  });

  it('completes normally (done + persisted voice_tts) when the brain produces a reply', async () => {
    brainYielding('<say>A spider has eight legs.</say>');
    await voiceTurn.handler(turnReq(), { params: {} });
    await captured.ready;

    const names = captured.events.map((e) => e.name);
    expect(names).toContain('done');
    expect(names).not.toContain('error');
    // Both the user turn and the assistant (voice_tts) turn were persisted.
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][0]).toMatchObject({
      source: 'voice_tts',
      text: 'A spider has eight legs.',
    });
  });
});
