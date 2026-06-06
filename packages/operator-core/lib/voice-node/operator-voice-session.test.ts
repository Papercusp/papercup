/**
 * OperatorVoiceSession host orchestration (universal-voice-interface-2026-06-05,
 * P-002/P-003/P-004/P-006/P-007). The host is pure logic over injected ports, so
 * these tests drive a full session with a fake EL socket + fake brain/lease and
 * assert the bus fan-out, control application, single-player election, and
 * single-mic gating — no live EL endpoint or audio hardware.
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@papercusp/p2p-voice';
import {
  decodeOpVoiceFrame,
  type OpVoiceMessage,
  type VoiceControlOp,
} from './operator-voice-bus';
import {
  elInitiationMessage,
  elUserAudioChunkMessage,
} from './el-convai-protocol';
import {
  OperatorVoiceSession,
  type ElConnectHandlers,
  type ElSocket,
  type OperatorVoiceSessionDeps,
} from './operator-voice-session';

/** A fake EL socket that records sends and lets the test push inbound text. */
class FakeEl implements ElSocket {
  sent: string[] = [];
  closed = false;
  handlers!: ElConnectHandlers;
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
  /** Drive an inbound EL server frame into the host. */
  push(obj: unknown): void {
    this.handlers.onText(JSON.stringify(obj));
  }
}

interface Harness {
  session: OperatorVoiceSession;
  el: FakeEl | null;
  /** Decoded bus messages the host broadcast, in order. */
  out: OpVoiceMessage[];
  deps: {
    persistTurn: ReturnType<typeof vi.fn>;
    askOperator: ReturnType<typeof vi.fn>;
    claimLease: ReturnType<typeof vi.fn>;
    releaseLease: ReturnType<typeof vi.fn>;
    resolveConfig: ReturnType<typeof vi.fn>;
  };
  getEl(): FakeEl;
}

function makeHarness(opts: { leaseGranted?: boolean; configError?: string } = {}): Harness {
  const out: OpVoiceMessage[] = [];
  let el: FakeEl | null = null;

  const persistTurn = vi.fn(async () => {});
  const askOperator = vi.fn(async () => '<say>here you go</say>');
  const claimLease = vi.fn(async () => opts.leaseGranted ?? true);
  const releaseLease = vi.fn(async () => {});
  const resolveConfig = vi.fn(async () =>
    opts.configError
      ? ({ ok: false as const, error: opts.configError })
      : ({ ok: true as const, config: { signedUrl: 'wss://el/x', overrides: { agent: { language: 'en' } }, dynamicVariables: { workspace_id: 'w', surface: 'tui' } } }),
  );

  const deps: OperatorVoiceSessionDeps = {
    resolveConfig,
    connect: vi.fn(async (_url: string, handlers: ElConnectHandlers) => {
      const sock = new FakeEl();
      sock.handlers = handlers;
      el = sock;
      return sock;
    }),
    askOperator,
    loadConversationId: vi.fn(async () => 'op_conv_1'),
    persistTurn,
    parseUtterance: (raw: string) => {
      const say = /<say>([\s\S]*?)<\/say>/i.exec(raw)?.[1]?.trim() ?? null;
      const setMode = /<set_mode>\s*(active|passive)\s*<\/set_mode>/i.exec(raw)?.[1] ?? null;
      return { say, setMode };
    },
    claimLease,
    releaseLease,
    broadcast: (frame: Uint8Array) => {
      const dec = new FrameDecoder();
      for (const f of dec.push(frame)) {
        const m = decodeOpVoiceFrame(f);
        if (m) out.push(m);
      }
    },
  };

  const session = new OperatorVoiceSession(deps);
  return {
    session,
    get el() {
      return el;
    },
    out,
    deps: { persistTurn, askOperator, claimLease, releaseLease, resolveConfig },
    getEl() {
      if (!el) throw new Error('EL socket not connected yet');
      return el;
    },
  } as Harness;
}

/** Flush pending microtasks/timers so async control flows settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const states = (out: OpVoiceMessage[]) => out.filter((m) => m.kind === 'session_state');
const lastState = (out: OpVoiceMessage[]) => {
  const s = states(out);
  return s[s.length - 1] as Extract<OpVoiceMessage, { kind: 'session_state' }> | undefined;
};

/** Bring a started, EL-connected session up with `clientId` as the player. */
async function startSession(h: Harness, clientId = 'desktop-1', kind: 'desktop' | 'tui' = 'desktop') {
  h.session.handleHello(clientId, kind);
  h.session.handleControl(clientId, { op: 'start' });
  await flush();
}

describe('OperatorVoiceSession — start + election (P-002/P-006)', () => {
  it('a client start elects it as player, claims the lease, mints config, opens EL, sends initiation', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');

    expect(h.deps.claimLease).toHaveBeenCalledWith('desktop-1', 'desktop', true);
    expect(h.deps.resolveConfig).toHaveBeenCalledTimes(1);
    const el = h.getEl();
    // initiation message is the first thing sent on the EL socket
    expect(JSON.parse(el.sent[0])).toEqual(
      JSON.parse(elInitiationMessage({ agent: { language: 'en' } }, { workspace_id: 'w', surface: 'tui' })),
    );
    const s = lastState(h.out);
    expect(s?.playerId).toBe('desktop-1');
    expect(s?.conversationId).toBe('op_conv_1');
    expect(s?.status).toBe('idle');
  });

  it('a failed config tears down with an error state', async () => {
    const h = makeHarness({ configError: 'no-api-key' });
    await startSession(h);
    const errState = states(h.out).find((s) => s.status === 'error');
    expect(errState).toBeTruthy();
    expect(errState?.reason).toContain('no-api-key');
  });
});

describe('OperatorVoiceSession — EL fan-out (P-003)', () => {
  it('init sets the audio format/rate from the EL output format', async () => {
    const h = makeHarness();
    await startSession(h);
    h.getEl().push({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'el_1', agent_output_audio_format: 'pcm_16000' },
    });
    const s = lastState(h.out);
    expect(s?.audioFormat).toBe('pcm_s16le');
    expect(s?.sampleRate).toBe(16000);
  });

  it('broadcasts response audio with the negotiated format + exact bytes', async () => {
    const h = makeHarness();
    await startSession(h);
    h.getEl().push({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'el_1', agent_output_audio_format: 'pcm_16000' },
    });
    const pcm = new Uint8Array([1, 2, 3, 4]);
    h.getEl().push({ type: 'audio', audio_event: { audio_base_64: Buffer.from(pcm).toString('base64') } });

    const audio = h.out.find((m) => m.kind === 'response_audio');
    expect(audio).toBeTruthy();
    if (audio?.kind === 'response_audio') {
      expect(audio.format).toBe('pcm_s16le');
      expect(audio.sampleRate).toBe(16000);
      expect(Array.from(audio.audio)).toEqual([1, 2, 3, 4]);
    }
    expect(lastState(h.out)?.status).toBe('speaking');
  });

  it('broadcasts input transcript + persists the user turn once (P-010)', async () => {
    const h = makeHarness();
    await startSession(h);
    h.getEl().push({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'el_42', agent_output_audio_format: 'pcm_16000' },
    });
    h.getEl().push({ type: 'user_transcript', user_transcription_event: { user_transcript: 'what is the status' } });
    await flush();

    const it_ = h.out.find((m) => m.kind === 'input_transcript');
    expect(it_).toMatchObject({ kind: 'input_transcript', text: 'what is the status', final: true });
    expect(h.deps.persistTurn).toHaveBeenCalledWith('user', 'what is the status', 'el_42');
    expect(lastState(h.out)?.status).toBe('listening');
  });

  it('broadcasts the raw agent response, emits a set_mode tag, persists the spoken text', async () => {
    const h = makeHarness();
    await startSession(h);
    h.getEl().push({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'el_7', agent_output_audio_format: 'pcm_16000' },
    });
    h.getEl().push({
      type: 'agent_response',
      agent_response_event: { agent_response: '<say>on it</say><set_mode>passive</set_mode>' },
    });
    await flush();

    expect(h.out.find((m) => m.kind === 'response_transcript')).toMatchObject({
      kind: 'response_transcript',
      text: '<say>on it</say><set_mode>passive</set_mode>',
    });
    expect(h.out.find((m) => m.kind === 'response_tag')).toMatchObject({ kind: 'response_tag', tag: 'set_mode', value: 'passive' });
    expect(h.deps.persistTurn).toHaveBeenCalledWith('assistant', 'on it', 'el_7');
  });

  it('answers a ping with a pong on the EL socket', async () => {
    const h = makeHarness();
    await startSession(h);
    const before = h.getEl().sent.length;
    h.getEl().push({ type: 'ping', ping_event: { event_id: 99 } });
    const pong = h.getEl().sent.slice(before).map((s) => JSON.parse(s)).find((m) => m.type === 'pong');
    expect(pong).toEqual({ type: 'pong', event_id: 99 });
  });

  it('runs the brain on an ask_operator tool call and returns the result to EL', async () => {
    const h = makeHarness();
    await startSession(h);
    const before = h.getEl().sent.length;
    h.getEl().push({
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'ask_operator', tool_call_id: 'tc_1', parameters: { question: 'how goes it' } },
    });
    await flush();
    expect(h.deps.askOperator).toHaveBeenCalledWith('how goes it', 'op_conv_1');
    const result = h.getEl().sent.slice(before).map((s) => JSON.parse(s)).find((m) => m.type === 'client_tool_result');
    expect(result).toMatchObject({ tool_call_id: 'tc_1', is_error: false, result: '<say>here you go</say>' });
  });

  it('rejects an unknown tool call with an error result', async () => {
    const h = makeHarness();
    await startSession(h);
    const before = h.getEl().sent.length;
    h.getEl().push({
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'rm_rf', tool_call_id: 'tc_x', parameters: {} },
    });
    await flush();
    expect(h.deps.askOperator).not.toHaveBeenCalled();
    const result = h.getEl().sent.slice(before).map((s) => JSON.parse(s)).find((m) => m.type === 'client_tool_result');
    expect(result).toMatchObject({ tool_call_id: 'tc_x', is_error: true });
  });
});

describe('OperatorVoiceSession — single mic capture (P-007)', () => {
  it('forwards mic ONLY from the elected player, and only when transmitting', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleHello('tui-2', 'tui'); // second client attaches, not the player
    const el = h.getEl();

    const pcm = new Uint8Array([5, 6, 7, 8]);
    const before = el.sent.length;
    h.session.handleMic('tui-2', pcm); // non-player → dropped
    expect(el.sent.length).toBe(before);

    h.session.handleMic('desktop-1', pcm); // player → forwarded to EL
    const chunk = el.sent.slice(before).map((s) => JSON.parse(s)).find((m) => 'user_audio_chunk' in m);
    expect(chunk).toEqual(JSON.parse(elUserAudioChunkMessage(pcm)));
  });

  it('drops player mic while muted', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleControl('desktop-1', { op: 'mute', muted: true });
    const el = h.getEl();
    const before = el.sent.length;
    h.session.handleMic('desktop-1', new Uint8Array([1, 2]));
    expect(el.sent.length).toBe(before);
  });
});

describe('OperatorVoiceSession — control applies once + broadcasts (P-004)', () => {
  it('mute / set-mode / ptt update state and re-broadcast', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');

    h.session.handleControl('desktop-1', { op: 'mute', muted: true });
    expect(lastState(h.out)?.muted).toBe(true);

    h.session.handleControl('tui-x', { op: 'set-mode', mode: 'push-to-talk' });
    expect(lastState(h.out)?.mode).toBe('push-to-talk');
  });

  it('stop tears the session down, releases the lease, settles state', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleControl('tui-x', { op: 'stop' });
    await flush();
    expect(h.getEl().closed).toBe(true);
    expect(h.deps.releaseLease).toHaveBeenCalledWith('desktop-1');
    expect(lastState(h.out)?.status).toBe('ended');
  });
});

describe('OperatorVoiceSession — player handoff + survival (P-006/P-011)', () => {
  it('force-host moves the player to another attached client', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleHello('tui-2', 'tui');
    h.deps.claimLease.mockClear();

    h.session.handleControl('tui-2', { op: 'force-host' });
    await flush();
    expect(h.deps.claimLease).toHaveBeenCalledWith('tui-2', 'tui', true);
    expect(lastState(h.out)?.playerId).toBe('tui-2');
  });

  it('a plain start from a second client does NOT steal the player (Model A attach-only)', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleHello('tui-2', 'tui');
    h.deps.claimLease.mockClear();

    h.session.handleControl('tui-2', { op: 'start' });
    await flush();
    expect(h.deps.claimLease).not.toHaveBeenCalled();
    expect(lastState(h.out)?.playerId).toBe('desktop-1');
  });

  it('when the player disconnects and another client is attached, re-elects it (session survives)', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleHello('tui-2', 'tui');
    h.deps.claimLease.mockClear();

    h.session.handleClientGone('desktop-1');
    await flush();
    expect(h.deps.claimLease).toHaveBeenCalledWith('tui-2', 'tui', true);
    expect(lastState(h.out)?.playerId).toBe('tui-2');
  });

  it('when the last client leaves, the session tears down', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.session.handleClientGone('desktop-1');
    await flush();
    expect(h.deps.releaseLease).toHaveBeenCalledWith('desktop-1');
    expect(lastState(h.out)?.playerId).toBeNull();
  });

  it('heartbeat refreshes the lease for the current player (non-forcing)', async () => {
    const h = makeHarness();
    await startSession(h, 'desktop-1', 'desktop');
    h.deps.claimLease.mockClear();
    await h.session.heartbeat();
    expect(h.deps.claimLease).toHaveBeenCalledWith('desktop-1', 'desktop', false);
  });
});

describe('OperatorVoiceSession — barge-in', () => {
  it('an EL interruption flips state back to listening (clients cut playout)', async () => {
    const h = makeHarness();
    await startSession(h);
    h.getEl().push({ type: 'audio', audio_event: { audio_base_64: Buffer.from([1]).toString('base64') } });
    expect(lastState(h.out)?.status).toBe('speaking');
    h.getEl().push({ type: 'interruption' });
    expect(lastState(h.out)?.status).toBe('listening');
  });
});

// `VoiceControlOp` is exercised exhaustively above; this keeps the import used
// for the typed control literals in case the union changes.
const _typecheck: VoiceControlOp = { op: 'start' };
void _typecheck;
