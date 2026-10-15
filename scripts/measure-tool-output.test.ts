import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/measure-tool-output.mjs');

function runFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tool-output-measure-'));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const out = join(root, 'result.json');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const claudeResult = 'x'.repeat(17) + '\n[result-door: spilled]';
  writeFileSync(join(claude, 'session.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { id: 'a1', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'cat file' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: claudeResult }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'a2', content: [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'cat file' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'retry output' }] } }),
  ].join('\n'));
  writeFileSync(join(codex, 'rollout-fixture.jsonl'), [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf hi' }) } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'outer exec output truncated at cap' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf hi' }) } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'retry' } }),
  ].join('\n'));
  try {
    execFileSync(process.execPath, [SCRIPT, '--claude-root', claude, '--codex-root', codex, '--out', out], { encoding: 'utf8' });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('measure-tool-output raw transcript instrument', () => {
  it('reads Claude and Codex fixtures and reports bytes, caps, rereads and reruns', () => {
    const result = runFixture();
    expect(result.schemaVersion).toBe('tool-output-measurement-v1');
    expect(result.baseline24h.windowHours).toBe(24);
    expect(result.clients.claude.results).toBe(2);
    expect(result.clients.claude.truncation.byCap['papercusp-door'].results).toBe(1);
    expect(result.clients.claude.reruns.resultsAfterTruncation).toBe(1);
    expect(result.clients.codex.results).toBe(2);
    expect(result.clients.codex.truncation.byCap['codex-outer-exec'].results).toBe(1);
    expect(result.clients.codex.reruns.resultsAfterTruncation).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.rereadBytes).toBeGreaterThan(0);
    expect(result.clients.claude.tools[0].size.p50).toBeGreaterThan(0);
  });
});
