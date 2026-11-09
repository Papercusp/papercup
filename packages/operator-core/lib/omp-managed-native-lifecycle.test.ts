import { afterEach, describe, expect, it, vi } from 'vitest';
import { ompLifecycleProvider } from '../test/omp-managed-native-provider';

function fixture(getActiveTools: () => string[]) {
  const hooks = new Map<string, () => Promise<void>>();
  type ToolCall = { type: string; id: string; name: string; arguments: Record<string, unknown> };
  type Reply = { role: string; toolCallId: string; content: { type: string; text: string }[]; isError?: boolean };
  let provider!: { streamSimple: (model: unknown, context: {
    tools: { name: string }[]; messages: Reply[];
  }) => { result: () => Promise<{ content: ToolCall[] }> } };
  const write = vi.fn();
  // Execute the exact extension source passed to the installed client.
  const extension = new Function('writeFileSync', ompLifecycleProvider
    .replace("import { writeFileSync } from 'node:fs';", '')
    .replace('export default function', 'return function'))(write);
  extension({ getActiveTools,
    on: (event: string, handler: () => Promise<void>) => hooks.set(event, handler),
    registerProvider: (_name: string, value: typeof provider) => { provider = value; },
  });
  return { ready: hooks.get('before_agent_start')!, provider, write };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('installed OMP fixture MCP readiness', () => {
  it('records actual extension, registration and inference stages in the owned startup receipt', async () => {
    vi.stubEnv('OMP_PROOF_PHASE_FILE', '/owned/startup.ndjson');
    const { ready, provider, write } = fixture(() => ['mcp__papercusp_tools_invoke']);
    await ready();
    const context = { tools: [{ name: 'mcp__papercusp_tools_invoke' }], messages: [] };
    for (let turn = 0; turn < 4; turn++) await provider.streamSimple({}, context).result();
    const phases = write.mock.calls.filter(call => call[0] === '/owned/startup.ndjson');
    expect(phases.map(call => JSON.parse(call[1]).name)).toEqual([
      'extension-entry', 'before-agent-start', 'mcp-ready',
      'inference-turn', 'inference-turn', 'inference-turn', 'inference-turn', 'proof-complete',
    ]);
    expect(phases.every(call => call[2]?.flag === 'a' && call[1].endsWith('\n'))).toBe(true);
    expect(JSON.parse(phases[2]![1])).toMatchObject({ dispatcher: 'mcp__papercusp_tools_invoke',
      names: ['mcp__papercusp_tools_invoke'], elapsedMs: expect.any(Number) });
  });

  it('waits for actual active MCP registration before the first inference', async () => {
    vi.useFakeTimers();
    let names = ['read'];
    const { ready } = fixture(() => names);
    const settled = vi.fn();
    const waiting = ready().then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();
    names = ['read', 'mcp__papercusp_tools_invoke'];
    await vi.advanceTimersByTimeAsync(25);
    await waiting;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('fails with the observed catalog when registration never completes', async () => {
    vi.useFakeTimers();
    const { ready } = fixture(() => ['read']);
    const result = ready().catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ message: expect.stringContaining('registration did not become active: ["read"]') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses to invent a dispatcher without a real device transport', () => {
    const { provider } = fixture(() => ['mcp__papercusp_tools_invoke']);
    expect(() => provider.streamSimple({}, { tools: [{ name: 'read' }], messages: [] }))
      .toThrow('OMP model catalog lacks MCP dispatch and device transport: ["read"]');
  });

  it('discovers the exact mounted path, reads its schema and dispatches both MCP controls through OMP write', async () => {
    const { ready, provider, write } = fixture(() => ['mcp__papercusp_tools_invoke']);
    await ready();
    const context = { tools: ['read', 'write'].map(name => ({ name })), messages: [] as {
      role: string; toolCallId: string; content: { type: string; text: string }[];
    }[] };
    const next = async () => (await provider.streamSimple({}, context).result()).content[0]!;
    const respond = (id: string, text: string) => context.messages.push({
      role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }],
    });
    const listing = await next();
    expect(listing).toMatchObject({ name: 'read', arguments: { path: 'xd://' } });
    respond(listing.id, 'xd:// 1 mounted tool devices.\nxd://mcp__papercusp_tools_invoke Local dispatcher');
    const schema = await next();
    expect(schema).toMatchObject({ name: 'read', arguments: { path: 'xd://mcp__papercusp_tools_invoke' } });
    respond(schema.id, '{"type":"object","properties":{"name":{"type":"string"},"args":{"type":"object"}}}');
    expect(await next()).toMatchObject({ name: 'bash', arguments: { command: "printf 'OMP_NATIVE_ESCAPE'" } });
    const managed = await next();
    expect(managed).toMatchObject({ name: 'write', arguments: { path: schema.arguments.path } });
    expect(JSON.parse(managed.arguments.content as string)).toMatchObject({ name: 'capability:bash',
      args: { command: "printf 'OMP_MANAGED_OK'" } });
    const refusal = await next();
    expect(refusal).toMatchObject({ name: 'write', arguments: { path: schema.arguments.path } });
    expect(JSON.parse(refusal.arguments.content as string)).toEqual({ name: 'capability:__omp_missing_control__', args: {} });
    await next();
    expect(JSON.parse(write.mock.calls[0]![1])).toMatchObject({ devicePath: schema.arguments.path, turns: 6 });
  });

  it('rejects a listing without the registered dispatcher instead of guessing a device path', async () => {
    const { ready, provider } = fixture(() => ['mcp__papercusp_tools_invoke']);
    await ready();
    const context = { tools: ['read', 'write'].map(name => ({ name })), messages: [] as {
      role: string; toolCallId: string; content: { type: string; text: string }[];
    }[] };
    const listing = (await provider.streamSimple({}, context).result()).content[0]!;
    context.messages.push({ role: 'toolResult', toolCallId: listing.id,
      content: [{ type: 'text', text: 'xd://another_tool Other tool' }] });
    expect(() => provider.streamSimple({}, context)).toThrow('OMP device listing lacks the registered MCP dispatcher');
  });

  it('keeps directly advertised MCP dispatch without device discovery', async () => {
    const dispatcher = 'mcp__papercusp_tools_invoke';
    const { ready, provider } = fixture(() => [dispatcher]);
    await ready();
    const context = { tools: [{ name: dispatcher }], messages: [] };
    const next = async () => (await provider.streamSimple({}, context).result()).content[0]!;
    expect(await next()).toMatchObject({ name: 'bash' });
    expect(await next()).toMatchObject({ name: dispatcher, arguments: { name: 'capability:bash' } });
    expect(await next()).toMatchObject({ name: dispatcher, arguments: { name: 'capability:__omp_missing_control__' } });
  });
});
