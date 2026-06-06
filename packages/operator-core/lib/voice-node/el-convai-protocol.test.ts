/**
 * el-convai-protocol — the Node port of the pui's EL Conv-AI raw-WS codec
 * (universal-voice-interface-2026-06-05, P-002). Parsing is tolerant (garbage →
 * `unknown`, never throws) and the outbound builders match EL's wire shape; both
 * are asserted here so the host can speak EL without a live endpoint.
 */
import { describe, expect, it } from 'vitest';
import {
  parseElServerEvent,
  elInitiationMessage,
  elUserAudioChunkMessage,
  elPongMessage,
  elClientToolResultMessage,
  pcmRateFromFormat,
  decodeAudioB64,
} from './el-convai-protocol';

describe('el-convai-protocol — inbound parse', () => {
  it('parses conversation_initiation_metadata → init', () => {
    const raw = JSON.stringify({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: {
        conversation_id: 'conv_1',
        agent_output_audio_format: 'pcm_16000',
      },
    });
    expect(parseElServerEvent(raw)).toEqual({
      type: 'init',
      conversationId: 'conv_1',
      agentOutputAudioFormat: 'pcm_16000',
    });
  });

  it('defaults the audio format when init omits it', () => {
    const raw = JSON.stringify({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: { conversation_id: 'c' },
    });
    const ev = parseElServerEvent(raw);
    expect(ev).toMatchObject({ type: 'init', conversationId: 'c', agentOutputAudioFormat: 'pcm_16000' });
  });

  it('parses an audio event, and drops one with no payload', () => {
    expect(parseElServerEvent(JSON.stringify({ type: 'audio', audio_event: { audio_base_64: 'AAA=' } }))).toEqual({
      type: 'audio',
      audioB64: 'AAA=',
    });
    expect(parseElServerEvent(JSON.stringify({ type: 'audio', audio_event: {} }))).toEqual({ type: 'unknown' });
  });

  it('parses ping with its event id (and 0 when absent)', () => {
    expect(parseElServerEvent(JSON.stringify({ type: 'ping', ping_event: { event_id: 42 } }))).toEqual({
      type: 'ping',
      eventId: 42,
    });
    expect(parseElServerEvent(JSON.stringify({ type: 'ping' }))).toEqual({ type: 'ping', eventId: 0 });
  });

  it('parses user_transcript and agent_response', () => {
    expect(
      parseElServerEvent(JSON.stringify({ type: 'user_transcript', user_transcription_event: { user_transcript: 'hi there' } })),
    ).toEqual({ type: 'user_transcript', text: 'hi there' });
    expect(
      parseElServerEvent(JSON.stringify({ type: 'agent_response', agent_response_event: { agent_response: '<say>hello</say>' } })),
    ).toEqual({ type: 'agent_response', text: '<say>hello</say>' });
  });

  it('parses interruption', () => {
    expect(parseElServerEvent(JSON.stringify({ type: 'interruption' }))).toEqual({ type: 'interruption' });
  });

  it('parses client_tool_call with parameters', () => {
    const raw = JSON.stringify({
      type: 'client_tool_call',
      client_tool_call: {
        tool_name: 'ask_operator',
        tool_call_id: 'tc_9',
        parameters: { question: 'status?' },
      },
    });
    expect(parseElServerEvent(raw)).toEqual({
      type: 'client_tool_call',
      toolName: 'ask_operator',
      toolCallId: 'tc_9',
      parameters: { question: 'status?' },
    });
  });

  it('falls back to empty parameters when client_tool_call omits them', () => {
    const raw = JSON.stringify({ type: 'client_tool_call', client_tool_call: { tool_name: 't', tool_call_id: 'x' } });
    expect(parseElServerEvent(raw)).toEqual({ type: 'client_tool_call', toolName: 't', toolCallId: 'x', parameters: {} });
  });

  it('is tolerant: garbage, non-object, and unknown types → unknown (never throws)', () => {
    expect(parseElServerEvent('not json {')).toEqual({ type: 'unknown' });
    expect(parseElServerEvent('42')).toEqual({ type: 'unknown' });
    expect(parseElServerEvent('null')).toEqual({ type: 'unknown' });
    expect(parseElServerEvent(JSON.stringify({ type: 'some_future_event' }))).toEqual({ type: 'unknown' });
  });
});

describe('el-convai-protocol — outbound builders', () => {
  it('builds the initiation message with overrides + dynamic variables', () => {
    const m = JSON.parse(elInitiationMessage({ agent: { language: 'en' } }, { workspace_id: 'w', surface: 'tui' }));
    expect(m).toEqual({
      type: 'conversation_initiation_client_data',
      conversation_config_override: { agent: { language: 'en' } },
      dynamic_variables: { workspace_id: 'w', surface: 'tui' },
    });
  });

  it('omits overrides/dynamic_variables when null/absent', () => {
    const m = JSON.parse(elInitiationMessage(null, undefined));
    expect(m).toEqual({ type: 'conversation_initiation_client_data' });
  });

  it('builds a user_audio_chunk as base64 of the pcm bytes', () => {
    const pcm = new Uint8Array([0, 1, 2, 3, 255]);
    const m = JSON.parse(elUserAudioChunkMessage(pcm));
    expect(m).toEqual({ user_audio_chunk: Buffer.from(pcm).toString('base64') });
    // round-trips back to the same bytes
    expect(Array.from(Buffer.from(m.user_audio_chunk, 'base64'))).toEqual(Array.from(pcm));
  });

  it('builds pong + client_tool_result', () => {
    expect(JSON.parse(elPongMessage(7))).toEqual({ type: 'pong', event_id: 7 });
    expect(JSON.parse(elClientToolResultMessage('tc_1', 'all good', false))).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'tc_1',
      result: 'all good',
      is_error: false,
    });
    expect(JSON.parse(elClientToolResultMessage('tc_2', 'boom', true))).toMatchObject({
      tool_call_id: 'tc_2',
      result: 'boom',
      is_error: true,
    });
  });
});

describe('el-convai-protocol — audio format helpers', () => {
  it('pcmRateFromFormat extracts the rate for pcm_* and returns null otherwise', () => {
    expect(pcmRateFromFormat('pcm_16000')).toBe(16000);
    expect(pcmRateFromFormat('pcm_44100')).toBe(44100);
    expect(pcmRateFromFormat('mp3_44100_128')).toBeNull();
    expect(pcmRateFromFormat('ulaw_8000')).toBeNull();
    expect(pcmRateFromFormat('pcm_')).toBeNull();
  });

  it('decodeAudioB64 round-trips base64 → raw bytes', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const b64 = Buffer.from(bytes).toString('base64');
    expect(Array.from(decodeAudioB64(b64))).toEqual(Array.from(bytes));
  });
});
