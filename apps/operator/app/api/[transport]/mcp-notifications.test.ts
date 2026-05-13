/**
 * MCP notifications/papercusp/event integration tests.
 *
 * Drives the emit closure built by buildMcpToolContext and captures
 * the JSON-RPC notifications the MCP transport would send. Verifies:
 *   - emit('<name>', data) fires notifications/papercusp/event with
 *     { progressToken, event, data }.
 *   - emit('progress', {progress,total}) ALSO fires notifications/progress
 *     for spec-compliance.
 *   - Uint8Array data is base64-enveloped, not JSON-stringified to
 *     {"0":...,"1":...}.
 *   - progressToken passes through to params.progressToken.
 *
 * Round 6 found a real Uint8Array corruption bug here with no test.
 * This locks the wire shape in.
 */
import { describe, expect, it } from 'vitest';

import {
  __buildMcpToolContext_forTests,
  MCP_SERVER_CAPABILITIES,
  type BuiltSpawnContext,
} from './route';

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
};

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
    // sendNotification is async; ctx.emit fires it without awaiting.
    // The closure path is microtask-only — let the queue drain.
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
    // Sanity: NOT the {"0":222,"1":173,…} corrupted shape.
    expect(data['0']).toBeUndefined();
  });

  it('notifications/progress is SKIPPED when data is Uint8Array (no spec interpretation)', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-bin-progress', sendNotification);
    ctx.emit('progress', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setImmediate(r));
    // Only the papercusp/event notification fired; progress dual-fire skipped.
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
    // Just verify it doesn't throw.
    expect(() => ctx.emit('delta', { text: 'silent' })).not.toThrow();
  });

  it('MCP_SERVER_CAPABILITIES declares the Papercusp typed-events extension (P4.8)', () => {
    // Third-party MCP clients read `initialize` response to discover
    // server capabilities. The Papercusp extension capability tells
    // them this server emits notifications/papercusp/event frames
    // carrying typed event payloads (the wire surfaced by tools/list).
    // Plan ref: phase-4-endpoint-system-2026-05-12.md T1.1.
    expect(MCP_SERVER_CAPABILITIES).toMatchObject({
      tools: {},
      resources: {},
      prompts: {},
      experimental: {
        'papercusp/typedEvents': { version: '1' },
      },
    });
  });

  it('ctx.progress(pct, msg) routes through emit("progress", …) — alias parity', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-progress-alias', sendNotification);
    ctx.progress(75, 'three-quarters');
    await new Promise((r) => setImmediate(r));
    // Both notifications fired — papercusp/event (the emit path) AND
    // notifications/progress (the spec-compliance dual-fire).
    expect(sent).toHaveLength(2);
    const papercusp = sent.find((n) => n.method === 'notifications/papercusp/event')!;
    expect(papercusp.params).toEqual({
      progressToken: 'tok-progress-alias',
      event: 'progress',
      data: { progress: 75, total: 100, message: 'three-quarters' },
    });
  });
});
