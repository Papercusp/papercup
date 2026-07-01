/**
 * session-timeline-parsers tests — codex rollout + omp session lines → the
 * thinking pane's AgentTimelineEntry vocabulary. Line shapes sampled from real
 * files on the dev box (su-codex-homes rollouts / ~/.omp/agent/sessions).
 */

import { describe, expect, it } from 'vitest';
import { createCodexTimelineParser, createOmpTimelineParser } from './session-timeline-parsers';

describe('createCodexTimelineParser', () => {
  const p = () => createCodexTimelineParser();

  it('maps user_message → prompt and agent_message → text (with ts)', () => {
    expect(p().parseLine(JSON.stringify({
      timestamp: '2026-06-26T10:09:39.704Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'fix the roster' },
    }))).toEqual([{ kind: 'prompt', text: 'fix the roster', ts: '2026-06-26T10:09:39.704Z' }]);

    expect(p().parseLine(JSON.stringify({
      timestamp: 't2',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'On it.' },
    }))).toEqual([{ kind: 'text', text: 'On it.', ts: 't2' }]);
  });

  it('maps function_call (+namespace, string args) → tool_use with parsed input', () => {
    const [e] = p().parseLine(JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'omp_sessions',
        namespace: 'mcp__papercusp_su',
        arguments: '{"op":"list"}',
        call_id: 'call_1',
      },
    }));
    expect(e).toEqual({
      kind: 'tool_use',
      toolName: 'mcp__papercusp_su.omp_sessions',
      toolInput: { op: 'list' },
      toolId: 'call_1',
      ts: 't',
    });
  });

  it('maps function_call_output / custom_tool_call_output → tool_result', () => {
    expect(p().parseLine(JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'done', call_id: 'call_1' },
    }))).toEqual([{ kind: 'tool_result', text: 'done', toolId: 'call_1', ts: 't' }]);
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: 'patched', call_id: 'c2' },
    }))[0].kind).toBe('tool_result');
  });

  it('skips encrypted reasoning but surfaces a readable summary as status', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' },
    }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'plan the fix' }] },
    }))).toEqual([{ kind: 'status', text: '[thinking] plan the fix', ts: undefined }]);
  });

  it('skips meta noise (session_meta, token_count, turn_context) and bad json', () => {
    expect(p().parseLine(JSON.stringify({ type: 'session_meta', payload: {} }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'turn_context', payload: {} }))).toEqual([]);
    expect(p().parseLine('{not json')).toEqual([]);
  });

  it('marks a compaction as a status entry', () => {
    expect(p().parseLine(JSON.stringify({ timestamp: 't', type: 'compacted', payload: {} })))
      .toEqual([{ kind: 'status', text: 'context compacted', ts: 't' }]);
  });
});

describe('createOmpTimelineParser', () => {
  const p = () => createOmpTimelineParser();

  it('maps user text → prompt, assistant text → text, thinking → status', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't1',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    }))).toEqual([{ kind: 'prompt', text: 'do the thing', ts: 't1' }]);

    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't2',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Done.' },
        ],
      },
    }))).toEqual([
      { kind: 'status', text: '[thinking] hmm', ts: 't2' },
      { kind: 'text', text: 'Done.', ts: 't2' },
    ]);
  });

  it('maps assistant toolCall → tool_use and toolResult-role text → tool_result', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'search_tool_bm25', arguments: { query: 'orient' } }],
      },
    }))).toEqual([{
      kind: 'tool_use', toolName: 'search_tool_bm25', toolInput: { query: 'orient' }, toolId: 'call_1', ts: 't',
    }]);

    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: { role: 'toolResult', content: [{ type: 'text', text: '{"match_count":0}' }] },
    }))).toEqual([{ kind: 'tool_result', text: '{"match_count":0}', ts: 't' }]);
  });

  it('skips non-message records (session/title/model_change) and bad json', () => {
    expect(p().parseLine(JSON.stringify({ type: 'session', id: 'x' }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'title', title: '' }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'model_change', model: 'm' }))).toEqual([]);
    expect(p().parseLine('nope')).toEqual([]);
  });

  it('accepts plain-string message content as one block', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: { role: 'user', content: 'plain' },
    }))).toEqual([{ kind: 'prompt', text: 'plain', ts: 't' }]);
  });
});
