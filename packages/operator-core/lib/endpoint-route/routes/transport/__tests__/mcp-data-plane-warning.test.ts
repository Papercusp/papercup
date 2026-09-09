import { describe, expect, it } from 'vitest';
import { withMcpDiagnosticWarnings, type BuiltSpawnContext, type McpCallResult } from '../_mcp-handler';

function context(overrides: Partial<BuiltSpawnContext> = {}): BuiltSpawnContext {
  return {
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: 'run-1',
    spawnId: 'spawn-1',
    parentSpawnId: null,
    uiClientId: 'su-1',
    ...overrides,
    detectorSessionKey: overrides.detectorSessionKey ?? null,
  };
}

describe('withMcpDiagnosticWarnings', () => {
  it('adds the proxy degradation warning to a JSON tool result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body.ok).toBe(true);
    expect(body._dataPlaneMayBeDegraded).toContain('2026-09-04T20:00:00.000Z');
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('uses _meta for non-JSON text and composes with the scope warning', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: 'plain text result' }],
      _meta: { preserved: true },
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({
        workspaceResolution: 'registry-fallback',
        dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z'),
      }),
    );

    expect(annotated._meta).toMatchObject({
      preserved: true,
      scopeGuessWarning: expect.stringContaining('SCOPE GUESSED'),
      dataPlaneMayBeDegraded: expect.stringContaining('DATA PLANE MAY BE DEGRADED'),
    });
  });

  it('is a byte-identical no-op without a diagnostic signal or for an error result', () => {
    const healthy: McpCallResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const failed: McpCallResult = {
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    };

    expect(withMcpDiagnosticWarnings(healthy, context())).toBe(healthy);
    expect(
      withMcpDiagnosticWarnings(failed, context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') })),
    ).toBe(failed);
  });
});
