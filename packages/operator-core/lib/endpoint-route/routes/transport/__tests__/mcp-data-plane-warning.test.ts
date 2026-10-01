import { describe, expect, it } from 'vitest';
import { encode } from '@papercusp/result-encoding';
import { type BuiltSpawnContext } from '../_mcp-host';
import { withMcpDiagnosticWarnings, type McpCallResult } from '../mcp-diagnostic-warnings';

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

  it('does not warn for an explicitly authoritative empty result', () => {
    const body = { ecosystem: 'react-tailwind', results: [], authoritative: true };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated successful result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [{ id: 'WI-10000979' }] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body).toEqual({ ok: true, results: [{ id: 'WI-10000979' }] });
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['facts:list', { ok: true, mode: 'key', found: true, count: 1, facts: [{ key: 'guard-rail:example' }] }],
    ['tools:find', { ok: true, hits: [{ tool: 'facts:list' }] }],
  ])('does not warn for populated %s result arrays', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('keeps the proxy degradation warning on an empty facts:list key lookup', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, mode: 'key', key: 'guard-rail:absent', found: false, count: 0, facts: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('does not add the proxy degradation warning to a populated TOON bulk result', () => {
    const body = {
      ok: true,
      results: [{ ok: true, id: 'EI-22641900519389010', post: { id: 203955 } }],
      counts: { ok: 1, failed: 0 },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: `format: toon\n${encode(body, 'toon')}` }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(annotated).toEqual(result);
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['loop:end', { ok: true, ended: true }],
    ['events:await', { ok: true, await_id: 158065 }],
    ['loop:checkpoint', { ok: true, verified: true, contentHash: '81efa6f12cc1' }],
  ])('does not add the proxy degradation warning to a successful %s lifecycle result', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:19:37.402Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:declare-intent result', () => {
    const body = {
      ok: true,
      presence: { ownerId: 'su-1', intent: 'verify warning classification' },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:whoami identity result', () => {
    const body = {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      source: 'omp-hook-session',
      workspaceId: 'papercusp-workspace',
      inbox_wake_key: 'coord-wake:su-1',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:inbox result without ok', () => {
    const body = {
      owner_id: 'su-1',
      summary: { total: 1, returned: 1 },
      entries: [{ msg_id: 'coord-send-1' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('keeps the proxy degradation warning on an empty coord:inbox result', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ owner_id: 'su-1', summary: { total: 0, returned: 0 }, entries: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('keeps the warning for an unknown successful envelope shape', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
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
