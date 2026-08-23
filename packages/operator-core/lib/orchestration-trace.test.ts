import { describe, expect, it } from 'vitest';
import type { OrchestrationCallRecord, ProjectedTool } from '@papercusp/tooldef';
import { normalizeExecutionTrace } from './orchestration-trace';

function tool(name: string, capabilities: string[], effect: 'read' | 'write' = 'read'): ProjectedTool {
  return {
    pluginName: 'test',
    description: name,
    inputSchema: { type: 'object' },
    capabilities,
    effect,
    expose: { mcp: { name } },
    fn: async () => ({ content: [] }),
  } as unknown as ProjectedTool;
}

const TOOLS = [
  tool('work_items:get', ['work:read']),
  tool('capability:write_stdin', ['capability:bash'], 'write'),
  tool('assets:render', ['assets:read']),
];

describe('normalizeExecutionTrace (P-013)', () => {
  it('parameterizes stable authority bindings and excludes their values from the fingerprint', async () => {
    const first = await normalizeExecutionTrace({
      script: `return tools.workItems.get({ id: 'WI-100', harness: 'alpha' });`,
      tools: TOOLS,
    });
    const second = await normalizeExecutionTrace({
      script: `return tools.workItems.get({ id: 'WI-999', harness: 'omega' });`,
      tools: TOOLS,
    });

    expect(first.stableBindings).toEqual([
      { parameter: 'harness:1', kind: 'harness', value: 'alpha' },
      { parameter: 'item:1', kind: 'item', value: 'WI-100' },
    ]);
    expect(first.toolGraph.staticCalls[0]?.args).toEqual({
      harness: { $binding: 'harness:1' },
      id: { $binding: 'item:1' },
    });
    expect(first.structuralFingerprint).toBe(second.structuralFingerprint);
  });

  it('removes secret-bearing values and classifies ephemeral session/process/path values without retaining them', async () => {
    const trace = await normalizeExecutionTrace({
      script: `return tools.capability.writeStdin({
        sessionId: 'pty-secret-session',
        pid: 424242,
        cursor: 'cursor-secret-value',
        path: '/tmp/private-20260822.log',
        apiKey: 'top-secret-key',
        chars: 'Authorization: bearer also-secret'
      });`,
      tools: TOOLS,
    });
    const serialized = JSON.stringify(trace);

    expect(serialized).not.toContain('pty-secret-session');
    expect(serialized).not.toContain('424242');
    expect(serialized).not.toContain('cursor-secret-value');
    expect(serialized).not.toContain('/tmp/private-20260822.log');
    expect(serialized).not.toContain('top-secret-key');
    expect(serialized).not.toContain('also-secret');
    expect(trace.redactedSecretPaths).toEqual(['staticCalls[0].args.apiKey']);
    expect(trace.ephemeralValues.map((entry) => entry.kind)).toEqual([
      'cursor',
      'temp-path',
      'process-id',
      'session-id',
    ]);
    expect(trace.portability).toEqual({
      host: 'same',
      replayability: 'mixed',
      ephemeralKinds: ['cursor', 'process-id', 'session-id', 'temp-path'],
    });
  });

  it('preserves validated output-reference identity but excludes it and runtime outcomes from the fingerprint', async () => {
    const record = (uri: string, sha256: string, disposition: OrchestrationCallRecord['disposition']): OrchestrationCallRecord => ({
      ordinal: 0,
      tool: 'assets:render',
      effect: 'read',
      disposition,
      outputReferences: [{ uri, byteCount: 42, sha256, audience: 'workspace' }],
    });
    const script = `return tools.assets.render({ format: 'png' });`;
    const first = await normalizeExecutionTrace({
      script,
      tools: TOOLS,
      backend: 'server',
      callRecords: [record('papercusp://results/one', 'a'.repeat(64), 'settled')],
    });
    const second = await normalizeExecutionTrace({
      script,
      tools: TOOLS,
      backend: 'client-compat',
      callRecords: [record('papercusp://results/two', 'b'.repeat(64), 'uncertain')],
    });

    expect(first.toolGraph.runtimeCalls[0]?.outputReferences).toEqual([
      {
        uri: 'papercusp://results/one',
        byteCount: 42,
        sha256: 'a'.repeat(64),
        audience: 'workspace',
      },
    ]);
    expect(first.requirements).toEqual({
      tools: ['assets:render'],
      capabilities: ['assets:read'],
      premises: ['host:same'],
    });
    expect(first.structuralFingerprint).toBe(second.structuralFingerprint);
    expect(second.portability.replayability).toBe('client-bound');
  });
});
