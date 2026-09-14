/**
 * MCP notifications/papercusp/event integration tests.
 *
 * Ported from app/api/[transport]/mcp-notifications.test.ts during the
 * endpoint-route migration — the transport logic moved to
 * routes/transport/_mcp-handler.ts, which re-exports the same test
 * helpers (`__buildMcpToolContext_forTests`, `MCP_SERVER_CAPABILITIES`).
 * Only the import path changed; the assertions are unchanged.
 *
 * Drives the emit closure built by buildMcpToolContext and captures the
 * JSON-RPC notifications the MCP transport would send. Verifies:
 *   - emit('<name>', data) fires notifications/papercusp/event.
 *   - emit('progress', …) ALSO fires notifications/progress.
 *   - Uint8Array data is base64-enveloped, not numeric-keyed.
 *   - progressToken passes through.
 */
import { describe, expect, it } from 'vitest';

import {
  __buildMcpToolContext_forTests,
  type BuiltSpawnContext,
} from '../routes/transport/_mcp-host';
import { MCP_SERVER_CAPABILITIES } from '../routes/transport/mcp-contract';
import {
  getSessionSurface,
  __resetSessionSurfaces,
} from '../routes/transport/tool-allowlist';

const fakeSpawn: BuiltSpawnContext = {
  workspaceId: 'default',
  harnessSlug: 'system',
  role: 'operator',
  featureId: null,
  chunkId: null,
  runId: 'mcp-test-run',
  spawnId: 'mcp-test-spawn',
  parentSpawnId: null,
  uiClientId: null,
  detectorSessionKey: null,
};

/** A spawn with a stable session identity — required for activateTools. */
const seededSpawn: BuiltSpawnContext = { ...fakeSpawn, uiClientId: 'sess-A' };

function recordingSendNotification() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    sendNotification: async (notif: { method: string; params: Record<string, unknown> }) => {
      sent.push(notif);
    },
  };
}

describe('MCP emit → notifications', () => {
  it('emits notifications/papercusp/event for an arbitrary named event', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-1', sendNotification);
    ctx.emit('delta', { text: 'hello' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      method: 'notifications/papercusp/event',
      params: { progressToken: 'tok-1', event: 'delta', data: { text: 'hello' } },
    });
  });

  it('emit("progress", …) ALSO fires notifications/progress (spec-compliance)', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 42, sendNotification);
    ctx.emit('progress', { progress: 50, total: 100, message: 'halfway' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent.map((n) => n.method)).toEqual([
      'notifications/papercusp/event',
      'notifications/progress',
    ]);
    expect(sent[1].params).toEqual({
      progressToken: 42,
      progress: 50,
      total: 100,
      message: 'halfway',
    });
  });

  it('Uint8Array data is base64-enveloped, not JSON-stringified to numeric keys', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-bin', sendNotification);
    ctx.emit('chunk', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    const n = sent[0];
    expect(n.method).toBe('notifications/papercusp/event');
    const data = n.params.data as Record<string, unknown>;
    expect(data).toMatchObject({
      $papercuspBinary: true,
      encoding: 'base64',
      data: '3q2+7w==',
    });
    expect(data['0']).toBeUndefined();
  });

  it('notifications/progress is SKIPPED when data is Uint8Array (no spec interpretation)', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-bin-progress', sendNotification);
    ctx.emit('progress', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setImmediate(r));
    expect(sent.map((n) => n.method)).toEqual(['notifications/papercusp/event']);
  });

  it('emit is a no-op when client did not supply a progressToken', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, undefined, sendNotification);
    ctx.emit('delta', { text: 'should-not-send' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('emit is a no-op when sendNotification is undefined', async () => {
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-no-sender', undefined);
    expect(() => ctx.emit('delta', { text: 'silent' })).not.toThrow();
  });

  it('carries a validated MCP idempotency key into the unified tool context', async () => {
    const ctx = await __buildMcpToolContext_forTests(
      fakeSpawn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'retry-key-1',
    );
    expect(ctx.idempotencyKey).toBe('retry-key-1');
  });

  it('MCP_SERVER_CAPABILITIES declares the Papercusp typed-events extension (P4.8)', () => {
    expect(MCP_SERVER_CAPABILITIES).toMatchObject({
      tools: { listChanged: true },
      resources: {},
      prompts: {},
      experimental: {
        'papercusp/typedEvents': { version: '1' },
      },
    });
  });

  it('declares tools.listChanged (dynamic-tool-surface P-002) — required for OMP/Codex re-fetch', () => {
    // OMP checks `capabilities.tools?.listChanged === true` before it will act
    // on a tools/list_changed notification. If this regresses to `{}` the
    // dynamic-expansion round-trip silently breaks (the client never re-fetches).
    expect(MCP_SERVER_CAPABILITIES.tools.listChanged).toBe(true);
  });

  describe('ctx.activateTools → notifications/tools/list_changed (dynamic-tool-surface P-003)', () => {
    it('fires list_changed exactly once when a SEEDED session grows', async () => {
      __resetSessionSurfaces();
      // Seed the session as tools/list would on first contact.
      getSessionSurface('sess-A', new Set(['coord:orient']));
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set', 'harness:status']);
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(true);
      expect(sent).toEqual([{ method: 'notifications/tools/list_changed', params: {} }]);
      // The grown set is now visible to a re-fetch.
      expect(getSessionSurface('sess-A', new Set(['coord:orient']))).toEqual(
        new Set(['coord:orient', 'flags:set', 'harness:status']),
      );
    });

    it('does NOT fire when activation adds nothing new (no re-fetch spam)', async () => {
      __resetSessionSurfaces();
      getSessionSurface('sess-A', new Set(['coord:orient', 'flags:set']));
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set']); // already present
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('is a no-op for an UN-SEEDED (full-catalog / Claude) session — never fires', async () => {
      __resetSessionSurfaces();
      // No getSessionSurface() seeding → no surface entry for this session.
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set']);
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('never throws when sendNotification is undefined', async () => {
      __resetSessionSurfaces();
      getSessionSurface('sess-A', new Set(['coord:orient']));
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, undefined);
      expect(() => ctx.activateTools!(['flags:set'])).not.toThrow();
    });
  });

  describe('ctx.dispatchTool (tools:invoke engine, dynamic-tool-surface P-006)', () => {
    it('is present on an MCP ctx and returns unknown_tool for a bogus name', async () => {
      const ctx = await __buildMcpToolContext_forTests(fakeSpawn, undefined, undefined);
      expect(typeof ctx.dispatchTool).toBe('function');
      const r = await ctx.dispatchTool!('no:such_tool_xyz', {});
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toContain('unknown_tool');
    });
  });

  it('ctx.progress(pct, msg) routes through emit("progress", …) — alias parity', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-progress-alias', sendNotification);
    ctx.progress(75, 'three-quarters');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    const papercusp = sent.find((n) => n.method === 'notifications/papercusp/event')!;
    expect(papercusp.params).toEqual({
      progressToken: 'tok-progress-alias',
      event: 'progress',
      data: { progress: 75, total: 100, message: 'three-quarters' },
    });
  });
});
