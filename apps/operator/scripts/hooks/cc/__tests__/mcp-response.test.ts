import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function parse(raw: string, env: Record<string, string> = {}): { inner: unknown; error: unknown; phase: string } {
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
      env: { ...process.env, ...env },
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

  it('unwraps inline result-door envelopes before returning the tool result', () => {
    const grant = { ok: true, lock_id: 'inline-lock' };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    expect(parse(JSON.stringify(response))).toEqual({ inner: grant, error: null, phase: 'ok' });
  });

  it('unwraps a spilled result-door grant from its validated scratch reference, not its preview', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-spill-'));
    const relative = ['workspace', 'locks:acquire', 'run-id', 'result.spill'];
    const spillPath = join(scratchRoot, ...relative);
    const grant = { ok: true, lock_id: 'spilled-lock' };
    const spilledPayload = {
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: `papercusp://scratch/${relative.join('/')}`,
        preview: '{"ok":false,"reason":"preview is not authoritative"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      mkdirSync(dirname(spillPath), { recursive: true });
      writeFileSync(spillPath, `result-door magic\nmanifest\n${JSON.stringify(spilledPayload)}\n`);
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: grant,
        error: null,
        phase: 'ok',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('does not trust a missing spill or its preview as a tool result', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-missing-spill-'));
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: 'papercusp://scratch/workspace/locks:acquire/run-id/result.spill',
        preview: '{"ok":true,"lock_id":"preview-only"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: null,
        error: null,
        phase: 'no-text',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
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
