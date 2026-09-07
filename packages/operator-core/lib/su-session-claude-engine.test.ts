import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { startClaudeSuEngine, type ClaudeEngineOptions, type ClaudeSuEngine } from './su-session-claude-engine';

vi.mock('./su-session-persistence', () => ({
  persistSuSessionDescriptor: vi.fn(async () => true),
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  readDurableSuSession: vi.fn(async () => null),
  classifySuSessionRuntime: vi.fn(),
}));

const nativeId = '11111111-2222-4333-8444-555555555555';
const dir = mkdtempSync(join(tmpdir(), 'pui-engine-test-'));
const promptFile = join(dir, 'su.md');
writeFileSync(promptFile, 'SU persona and workspace scope.\n'.repeat(400));
const boot = {
  agent: 'claude', sessionId: 61, nativeSessionId: nativeId, workspaceId: 'workspace',
  harnessSlug: 'project', planSlug: null, cwd: dir, promptFile,
  envelopeEnv: { PAPERCUSP_SID: 'su-test', PAPERCUSP_WORKSPACE: 'workspace', PAPERCUSP_HARNESS_SLUG: 'project', CLAUDE_CONFIG_DIR: dir },
} as BootstrapSuResult;
const binding = {
  operation: 'created' as const, backend: 'claude' as const, advSessionId: 61,
  ownerId: 'su-test', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null, nativeSession: null,
};
const runtime = { nativeSession: {
  backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: 'su-test', sessionId: nativeId,
  configDir: dir, configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
  exactResumeSupported: true as const, missingReason: null,
}, transcriptPath: null };
const engines: ClaudeSuEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) { await engine.close(); engine.adapter.dispose(); } });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function peer(config: { identity?: string; cwd?: string; connected?: boolean; holdInit?: boolean; noAck?: boolean } = {}) {
  const output = new PassThrough({ objectMode: true });
  const prompts: SDKUserMessage[] = [];
  let receivedOptions: Options | undefined;
  const close = vi.fn(() => output.end());
  const interrupt = vi.fn(async () => undefined);
  const factory: NonNullable<ClaudeEngineOptions['query']> = ({ prompt, options }) => {
    receivedOptions = options;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message);
        if (message.shouldQuery === false) {
          if (config.holdInit) continue;
          output.write({ type: 'system', subtype: 'init', session_id: config.identity ?? nativeId, cwd: config.cwd ?? dir });
          output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        } else if (!config.noAck) {
          output.write(message);
          output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'Correlated reply' }] } });
          output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        }
      }
    })();
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>,
      initializationResult: vi.fn(async () => ({ commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] })),
      mcpServerStatus: vi.fn(async () => [{ name: 'papercusp-su', status: config.connected === false ? 'failed' as const : 'connected' as const }]),
      interrupt, close,
    };
  };
  return { factory, output, prompts, close, interrupt, options: () => receivedOptions };
}
function open(p = peer(), extra: Partial<ClaudeEngineOptions> = {}) {
  const engine = startClaudeSuEngine(boot, binding, runtime, { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300, ...extra });
  engines.push(engine);
  return engine;
}
function command(engine: ClaudeSuEngine, type: 'owner_turn' | 'interrupt' | 'end' = 'owner_turn') {
  return { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId: `cmd-${type}`, issuedAt: '2026-09-07T00:00:00Z', target: engine.adapter.host.descriptor().identity,
    type, ...(type === 'owner_turn' ? { turnId: 'owner-turn-1', content: '  hi 雪\n\n' } : {}),
  };
}

describe('structured Claude SU engine', () => {
  it('requires the observed native identity, project and SU tools before ready', async () => {
    const p = peer(); const engine = open(p);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('starting');
    expect((await engine.adapter.host.acceptCommand(command(engine))).accepted).toBeNull();
    await engine.ready;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
    expect(engine.adapter.host.snapshot()).toMatchObject({ executorAttached: true, streamReady: true });
    expect(p.options()).toMatchObject({ sessionId: nativeId, cwd: dir, env: boot.envelopeEnv });
    expect(p.options()?.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent', 'Workflow']));
    expect(p.prompts).toHaveLength(1);
    expect(p.prompts[0]).toMatchObject({ isSynthetic: true, shouldQuery: false });
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript')).toBe(false);
  });

  it('delivers exact owner text and correlates the reply with the PUI turn', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result.status).toBe('completed');
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(p.prompts[1].message.content).toBe('  hi 雪\n\n');
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'assistant', turnId: 'owner-turn-1', content: 'Correlated reply',
    }));
  });

  it.each([{ identity: 'other-session' }, { cwd: '/another-project' }, { connected: false }])('cleans up a failed readiness check: %j', async (config) => {
    const p = peer(config); const engine = open(p);
    await expect(engine.ready).rejects.toThrow();
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'lifecycle' && event.state === 'ready')).toBe(false);
  });

  it('bounds a stalled startup and closes its protocol peer', async () => {
    const p = peer({ holdInit: true }); const engine = open(p, { startupTimeoutMs: 20 });
    await expect(engine.ready).rejects.toThrow('timed out');
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
  });

  it('converges an unexpected stream loss to a terminal failure', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    p.output.end(); await engine.done;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({ type: 'error', code: 'claude_stream_failed' }));
  });

  it('refuses an uncertain acknowledgement without retrying the owner text', async () => {
    const p = peer({ noAck: true }); const engine = open(p, { deliveryTimeoutMs: 20 }); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result).toMatchObject({ status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false } });
    expect(p.prompts.filter((message) => message.shouldQuery !== false)).toHaveLength(1);
  });

  it('uses structured interrupt and ends without a terminal control socket', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    expect((await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal).status).toBe('completed');
    expect(p.interrupt).toHaveBeenCalledOnce();
    expect((await engine.adapter.host.startCommand(command(engine, 'end')).terminal).status).toBe('completed');
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ended');
  });

  it('refuses a wrong bootstrap owner before constructing the engine', () => {
    const p = peer();
    expect(() => startClaudeSuEngine({ ...boot, envelopeEnv: { ...boot.envelopeEnv, PAPERCUSP_SID: 'other-owner' } }, binding, runtime, { agentChatId: 'chat', query: p.factory })).toThrow('durable SU identity');
    expect(p.options()).toBeUndefined();
  });
});
