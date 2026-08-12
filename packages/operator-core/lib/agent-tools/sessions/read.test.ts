/**
 * read.test.ts — EI-20236684982538421 regression.
 *
 * A 33-turn `sessions:read` window can exceed the MCP result-door text budget.
 * The handler historically returned only a hand-serialized JSON text block, so
 * the door cut it in the middle of a document and ptool could not parse it.
 * The typed object result below makes the same dispatch expose structuredContent
 * for programmatic callers while ordinary model-facing text remains doored.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

await import('./read');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('sessions:read')!;

function makeTx(rows: unknown[]) {
  return vi.fn(async () => rows);
}

describe('sessions:read EI-20236684982538421 — structured large-window response', () => {
  it('advertises an object result and preserves all rows in structuredContent', async () => {
    const rows = Array.from({ length: 33 }, (_, turn_idx) => ({
      source_kind: 'codex',
      turn_idx,
      speaker: 'assistant',
      owner: 'su-self',
      ts: '2026-08-12T09:00:00.000Z',
      text: `turn-${turn_idx}`,
    }));

    const dispatched = await dispatchProjectedTool(
      projected,
      'sessions:read',
      { session: 'sess-known', around: 16, context: 16 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'read-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(rows),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      session_id: 'sess-known',
      turn_count: 33,
    });
    const structured = dispatched.result?.structuredContent as { turns: unknown[] };
    expect(structured.turns).toHaveLength(33);
  });
});
