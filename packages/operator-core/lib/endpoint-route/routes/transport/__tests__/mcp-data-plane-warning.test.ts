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

  it('does not warn for a populated dev:pg_query rows result', () => {
    const body = {
      mode: 'query',
      rowCount: 38,
      truncated: false,
      fields: ['n'],
      elapsedMs: 322,
      rows: Array.from({ length: 38 }, (_, index) => ({ n: index + 1 })),
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T10:08:38.199Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated fleet:assignments agents result', () => {
    const body = {
      ok: true,
      self: { ownerId: 'su-1' },
      summary: { agents: 1 },
      agents: [{ agentId: 'su-1', claims: [], present: true }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:54:40.696Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('keeps the warning for an empty fleet:assignments agents result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, agents: [] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:54:40.696Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body._dataPlaneMayBeDegraded).toContain('2026-10-06T13:54:40.696Z');
  });

  it.each([
    ['loop:status', { ok: true, ownerId: 'su-1', loop: { active: true, goal: 'keep working' } }],
    ['scheduler:get_next', { ok: true, workItem: { id: 'EI-25212384048274593', state: 'open' } }],
    ['scheduler:get_claim_spec', { ok: true, source: 'fleet', spec: { kinds: ['bug'] } }],
    ['events:status', { ok: true, event_inspection: { current_generation: 1, current_state: 'fired', waiters: [{ await_id: 229122, state: 'fired' }] } }],
  ])('does not warn for a populated %s result envelope', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T09:18:42.036Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it.each([
    ['improvements:capture', {
      ok: true,
      created: false,
      reason: 'coalesced',
      coalescedOnto: { id: 'EI-22040058994011473', repeatCount: 2 },
      issue: { id: 'EI-22040058994011473', kind: 'change', state: 'open' },
    }],
    ['locks:acquire', {
      ok: true,
      lock_id: '29ee5601-ba68-487e-9136-f0534ced9aa4',
      held: ['packages/operator-core/lib/endpoint-route/routes/transport/mcp-diagnostic-warnings.ts'],
      newly_held: ['packages/operator-core/lib/endpoint-route/routes/transport/mcp-diagnostic-warnings.ts'],
    }],
  ])('does not warn for a populated %s domain result', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:28:18.593Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated scorecards:get result with complete criterion evidence', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        scorecard: {
          issueId: 'EI-24800707337861422',
          criteria: [{ key: 'oracle-independence', rating: 'pass', evidence: 'complete criterion evidence' }],
        },
        evidenceRead: { complete: true, scope: 'selected-criterion', offset: 2540, totalChars: 5081 },
      }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T02:32:07.251Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toMatchObject({
      scorecard: { issueId: 'EI-24800707337861422' },
      evidenceRead: { complete: true },
    });
  });

  it('does not warn for a scorecards:emit result with a recorded completion receipt', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        created: true,
        issueId: 'EI-24889905021992714',
        completionReceipt: { status: 'recorded', effectRef: 'EI-24889905021992714' },
      }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T17:34:18.330Z') }),
    );

    expect(annotated).toBe(result);
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

  it('does not warn for a populated tools:find envelope without an ok field', () => {
    const body = {
      query: 'mcp-diagnostic-warnings',
      count: 1,
      totalMatches: 1,
      truncated: false,
      activated: false,
      hits: [{ tool: 'facts:list' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T06:26:03.371Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated testing:runs ledger envelope without an ok field', () => {
    const body = {
      count: 3,
      total: 3,
      truncatedByLimit: false,
      latestPerFile: false,
      effectiveSourceFilter: 'none (exact testRunIds receipt lookup)',
      omittedBySourceFilter: 0,
      runs: [{ id: 20649884, filePath: 'packages/operator-core/lib/example.test.ts', status: 'pass' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-03T07:06:23.421Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for populated activity:tool-log counts', () => {
    const body = {
      ok: true,
      calls: 11,
      rawRows: 14,
      span: { from: '2026-10-05T17:44:30Z', to: '2026-10-05T17:52:30Z' },
      log: 'tools_invoke ×11 ·',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-05T17:52:29.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('keeps the warning for empty activity:tool-log counts', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          calls: 0,
          rawRows: 0,
          span: { from: '2026-10-05T17:44:30Z', to: '2026-10-05T17:52:30Z' },
          log: '',
        }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-05T17:52:29.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('keeps the warning for an empty tools:find envelope without an ok field', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ query: 'mcp-diagnostic-warnings', count: 0, totalMatches: 0, hits: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T06:26:03.371Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
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

  it('does not warn on a recoverable output envelope containing evidence references', () => {
    const body = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      summaryProvenance: 'authored',
      content: [{
        kind: 'evidence-reference',
        uri: 'papercusp://scratch/papercusp-workspace/scorecards:get/result.spill',
        preview: 'criterion page',
        byteCount: 2048,
        sha256: 'abc123',
        expiresAt: '2026-10-07T00:00:00.000Z',
        ownerId: 'su-1',
        audience: 'owner',
        evidenceClass: 'work-item',
      }],
      state: 'incomplete',
      incomplete: {
        reason: 'aggregate-output-budget-exceeded',
        spilledItems: 1,
        recoverable: true,
        note: 'Read the evidence reference to recover the complete result.',
      },
      metrics: {},
      accounting: { summaryChars: 0, summaryBytes: 0, contentBytes: 128, totalBytes: 128, summaryBudgetChars: 0 },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T02:24:09.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
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
