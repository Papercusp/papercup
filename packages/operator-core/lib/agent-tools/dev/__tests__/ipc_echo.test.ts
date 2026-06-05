import { describe, it, expect, vi } from 'vitest';

type EmittedEvent = { name: string; data: unknown };

function recordingCtx() {
  const events: EmittedEvent[] = [];
  return {
    events,
    ctx: {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: (name: string, data: unknown) => events.push({ name, data }),
      workspaceId: 'default',
      harnessSlug: 'sheets',
      role: 'operator' as const,
      runId: 'run_T',
      spawnId: 'spw_T',
    } as never,
  };
}

describe('dev:ipc_echo', () => {
  it('emits one delta per token + one progress per token', async () => {
    const { default: tool } = await import('../ipc_echo');
    const { events, ctx } = recordingCtx();
    const result = await tool.handler(
      { message: 'hi there', emitBinary: false, delayMs: 0 },
      ctx,
    );
    const deltas = events.filter((e) => e.name === 'delta');
    const progress = events.filter((e) => e.name === 'progress');
    // 'hi there' splits into ['hi', ' ', 'there'] — 3 tokens.
    expect(deltas).toHaveLength(3);
    expect((deltas[0].data as { text: string }).text).toBe('hi');
    expect(progress).toHaveLength(3);
    const final = JSON.parse((result.content[0] as { text: string }).text);
    expect(final.echo).toBe('hi there');
  });

  it('emits a binary event when emitBinary=true', async () => {
    const { default: tool } = await import('../ipc_echo');
    const { events, ctx } = recordingCtx();
    await tool.handler({ message: 'x', emitBinary: true, delayMs: 0 }, ctx);
    const bin = events.find((e) => e.name === 'binary');
    expect(bin).toBeTruthy();
    expect(bin!.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(bin!.data as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('throws on aborted signal mid-stream', async () => {
    const { default: tool } = await import('../ipc_echo');
    const controller = new AbortController();
    const ctx = {
      log: vi.fn(),
      signal: controller.signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'default',
      role: 'operator' as const,
      runId: 'r',
      spawnId: 's',
    } as never;
    controller.abort();
    await expect(
      tool.handler({ message: 'a b c', emitBinary: false, delayMs: 0 }, ctx),
    ).rejects.toThrow(/abort/i);
  });

  it('schema-inferred wire — binary event is classified as binary', async () => {
    await import('../ipc_echo');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');
    const t = lookupByMcpName('dev:ipc_echo')!;
    expect(t.eventWireKinds?.delta).toBe('json');
    expect(t.eventWireKinds?.binary).toBe('binary');
    expect(t.eventWireKinds?.progress).toBe('json');
  });
});
