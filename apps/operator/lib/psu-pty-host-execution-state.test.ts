// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nativeExecutionFromRows, nativeTurnVerifierSupport } from '../scripts/psu-pty-host.mjs';

const timestamp = new Date(1000).toISOString();
const ctx = { receivedAtMs: 900, nowMs: 2000 };

describe('native execution observations', () => {
  it.each(['codex', 'claude', 'omp'])('reports missing evidence as unknown for %s', agent => {
    expect(nativeExecutionFromRows([], { agent, ...ctx }).phase).toBe('unknown');
  });

  it('distinguishes an aborted Codex turn from a running turn without reading error text', () => {
    const start = { type: 'event_msg', timestamp, payload: { type: 'task_started' } };
    expect(nativeExecutionFromRows([start], { agent: 'codex', ...ctx }).phase).toBe('running');
    expect(nativeExecutionFromRows([start, { ...start, payload: { type: 'turn_aborted' } }],
      { agent: 'codex', ...ctx }).phase).toBe('failed');
  });

  it('keeps a silent Codex tool active until its matching result', () => {
    const rows = [
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'tool-a' } },
    ];
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }).pendingTools).toBe(1);
    rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'tool-a' } });
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }).pendingTools).toBe(0);
  });

  it('does not treat OMP tool-use as terminal and recognizes arbitrary failed outcomes', () => {
    const user = { type: 'message', id: 'u', timestamp, message: { role: 'user' } };
    const tool = { type: 'message', id: 'a', timestamp, message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call' }] } };
    expect(nativeExecutionFromRows([user, tool], { agent: 'omp', ...ctx })).toMatchObject({ phase: 'running', pendingTools: 1 });
    const failed = { type: 'message', id: 'b', timestamp, message: { role: 'assistant', stopReason: 'error', errorMessage: 'unseen failure' } };
    expect(nativeExecutionFromRows([user, tool, failed], { agent: 'omp', ...ctx })).toMatchObject({ phase: 'failed', pendingTools: 0 });
  });

  it('does not certify older, future, or shared-home evidence', () => {
    const done = { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'done' } };
    expect(nativeExecutionFromRows([done], { agent: 'codex', receivedAtMs: 1001, nowMs: 2000 }).phase).toBe('unknown');
    expect(nativeExecutionFromRows([done], { agent: 'codex', receivedAtMs: 0, nowMs: 999 }).phase).toBe('unknown');
    expect(nativeTurnVerifierSupport('omp', { PI_CONFIG_DIR: '.omp' }).supported).toBe(false);
    expect(nativeTurnVerifierSupport('omp', { PI_CONFIG_DIR: '.papercusp/session-omp' }).supported).toBe(true);
  });

  it('keeps Claude tool results inside the same turn and uses typed API failure evidence', () => {
    const rows = [
      { type: 'user', timestamp, message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call' }] } },
      { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ];
    expect(nativeExecutionFromRows(rows, { agent: 'claude', ...ctx })).toMatchObject({ phase: 'running', pendingTools: 0 });
    rows.push({ type: 'assistant', timestamp, isApiErrorMessage: true, message: { role: 'assistant' } } as never);
    expect(nativeExecutionFromRows(rows, { agent: 'claude', ...ctx }).phase).toBe('failed');
  });
});
