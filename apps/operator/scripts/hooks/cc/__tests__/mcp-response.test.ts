import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = join(HERE, '..');
const HELPER = join(HOOK_DIR, 'mcp_response.py');
const TARGET_HOOKS = [
  'pretooluse-locks-acquire.sh',
  'pretooluse-plans-read-guard.sh',
  'posttooluse-activity-report.sh',
  'userpromptsubmit-provenance.sh',
];

function parse(raw: string): { inner: unknown; error: unknown; phase: string } {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from mcp_response import parse_mcp_response',
    'inner, error, phase = parse_mcp_response(sys.stdin.read())',
    'print(json.dumps({"inner": inner, "error": error, "phase": phase}, sort_keys=True))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', script, HOOK_DIR], {
      input: raw,
      encoding: 'utf8',
    }),
  ) as { inner: unknown; error: unknown; phase: string };
}

describe('shared CC MCP response parser', () => {
  it('rejects the measured HTTP-200 result.isError envelope instead of exposing its text as a decision', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input' }) }],
        isError: true,
      },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: null,
      error: response.result,
      phase: 'is-error',
    });
  });

  it('parses a successful JSON response and an SSE-framed response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: 7 }) }] },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
    expect(parse(`event: message\ndata: ${JSON.stringify(response)}\n\n`)).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
  });

  it('preserves JSON-RPC errors and classifies missing content', () => {
    const rpcError = { code: -32602, message: 'invalid args' };
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: rpcError }))).toEqual({
      inner: null,
      error: rpcError,
      phase: 'rpc-error',
    });
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }))).toEqual({
      inner: null,
      error: null,
      phase: 'no-text',
    });
  });

  it('makes all four sibling hooks import the shared parser', () => {
    for (const hook of TARGET_HOOKS) {
      expect(readFileSync(join(HOOK_DIR, hook), 'utf8'), hook).toContain(
        'from mcp_response import parse_mcp_response',
      );
    }
    expect(readFileSync(join(HOOK_DIR, 'pretooluse-locks-acquire.sh'), 'utf8')).not.toContain(
      'def _parse_mcp_response',
    );
  });
});
