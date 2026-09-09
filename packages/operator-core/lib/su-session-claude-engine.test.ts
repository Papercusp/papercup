import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import { startClaudeSuEngine, type ClaudeEngineOptions, type ClaudeSuEngine } from './su-session-claude-engine';
import type { ClaudeSuRuntimeBinding } from './su-session-claude-adapter';

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
  status: 'ok', specificationRevision: 'fixture-spec', stateRevision: 'fixture-state', compositionSource: 'blueprint',
  codexHome: null, coordExtPath: null,
  agent: 'claude', sessionId: 61, nativeSessionId: nativeId, workspaceId: 'workspace',
  harnessSlug: 'project', planSlug: null, cwd: dir, promptFile,
  envelopeEnv: { PAPERCUSP_SID: 'su-test', PAPERCUSP_WORKSPACE: 'workspace', PAPERCUSP_HARNESS_SLUG: 'project', CLAUDE_CONFIG_DIR: dir },
} satisfies BootstrapSuResult;
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

function peer(config: { identity?: string; cwd?: string; connected?: boolean; holdInit?: boolean; holdMcp?: boolean; pendingMcp?: boolean; noAck?: boolean; holdResult?: boolean; streamOnly?: boolean; streamParent?: string } = {}) {
  const output = new PassThrough({ objectMode: true });
  const prompts: SDKUserMessage[] = [];
  let receivedOptions: Options | undefined;
  const close = vi.fn(() => output.end());
  const interrupt = vi.fn(async () => undefined);
  let mcpReads = 0;
  const factory: NonNullable<ClaudeEngineOptions['query']> = ({ prompt, options }) => {
    receivedOptions = options;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(message);
        if (!config.noAck) {
          // A real CLI's turn metadata arrives only after a querying input.
          // No transcript-only startup traffic is fabricated by this peer.
          output.write({ type: 'system', subtype: 'init', session_id: config.identity ?? nativeId, cwd: config.cwd ?? dir });
          if (config.streamOnly) {
            if (options.includePartialMessages) output.write({
              type: 'stream_event', session_id: nativeId, parent_tool_use_id: config.streamParent ?? null,
              event: { type: 'message_start', message: { id: 'native-long-reply', role: 'assistant', content: [] } },
            });
            continue;
          }
          output.write(message);
          if (config.holdResult) continue;
          output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'Correlated reply' }] } });
          output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        }
      }
    })();
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>,
      initializationResult: vi.fn(async () => {
        if (config.holdInit) await new Promise(() => {});
        return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] };
      }),
      mcpServerStatus: vi.fn(async () => {
        if (config.holdMcp) await new Promise(() => {});
        if (config.pendingMcp && mcpReads++ === 0) return [{ name: 'papercusp-su', status: 'pending' as const }];
        return [{ name: 'papercusp-su', status: config.connected === false ? 'failed' as const : 'connected' as const }];
      }),
      interrupt, close,
    };
  };
  return { factory, output, prompts, close, interrupt, options: () => receivedOptions };
}
function open(p = peer(), extra: Partial<ClaudeEngineOptions> = {}, nativeRuntime: ClaudeSuRuntimeBinding = runtime) {
  const engine = startClaudeSuEngine(boot, binding, nativeRuntime, { agentChatId: 'chat', accountRoute: 'default', carry: 'warm', query: p.factory, register: false, startupTimeoutMs: 300, ...extra });
  engines.push(engine);
  return engine;
}
function command(engine: ClaudeSuEngine, type: 'owner_turn' | 'interrupt' | 'end' = 'owner_turn') {
  return { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId: `cmd-${type}`, issuedAt: '2026-09-07T00:00:00Z', target: engine.adapter.host.descriptor().identity,
    type, ...(type === 'owner_turn' ? { turnId: 'owner-turn-1', content: '  hi 雪\n\n' } : {}),
  };
}
function openCards(engine: ClaudeSuEngine) {
  const events = engine.adapter.host.recent.map(({ event }) => event);
  const closed = new Set(events.flatMap((event) => event.type === 'card' && event.phase === 'closed' ? [event.correlationId] : []));
  return events.flatMap((event) => event.type === 'card' && event.phase === 'opened' && !closed.has(event.card.correlationId) ? [event.card] : []);
}

describe('structured Claude SU engine', () => {
  it.each([
    { toolApproval: undefined, permissionMode: 'bypassPermissions', dangerouslySkip: true },
    { toolApproval: 'prompt' as const, permissionMode: 'default', dangerouslySkip: undefined },
  ])('maps tool approval $toolApproval to the native SDK policy', async ({ toolApproval, permissionMode, dangerouslySkip }) => {
    const p = peer();
    const engine = open(p, toolApproval ? { toolApproval } : {});
    await engine.ready;
    expect(p.options()?.permissionMode).toBe(permissionMode);
    expect(p.options()?.allowDangerouslySkipPermissions).toBe(dangerouslySkip);
  });

  it('keeps restored history in startup until the new executor is ready', async () => {
    const transcriptPath = join(dir, 'history-readiness.jsonl');
    writeFileSync(transcriptPath, [
      { type: 'user', sessionId: nativeId, uuid: 'saved-user', message: { role: 'user', content: 'Saved greeting' } },
      { type: 'assistant', sessionId: nativeId, uuid: 'saved-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }] } },
      { type: 'result', sessionId: nativeId, subtype: 'success', is_error: false },
    ].map((record) => JSON.stringify(record) + '\n').join(''));
    let beforeReady: ReturnType<ClaudeSuEngine['adapter']['host']['snapshot']> | undefined;
    const p = peer();
    const engine = open(p, { resume: true, beforeReady: async () => {
      beforeReady = engine.adapter.host.snapshot();
    } }, { ...runtime, transcriptPath });
    await engine.ready;
    expect(p.options()?.systemPrompt).toEqual({
      type: 'custom', prompt: readFileSync(promptFile, 'utf8'), snapshot: true,
    });
    expect(p.options()?.env?.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED).toBe('1');
    expect(p.options()?.extraArgs).not.toHaveProperty('system-prompt-file');
    expect(beforeReady).toMatchObject({ streamReady: false, executorAttached: false,
      descriptor: { lifecycle: expect.stringMatching(/^(starting|resuming)$/) } });
    expect(engine.adapter.host.recent.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'transcript', phase: 'completed', role: 'assistant', content: 'Saved reply' }),
    ]));
    expect(engine.adapter.host.snapshot()).toMatchObject({ streamReady: true, executorAttached: true,
      descriptor: { lifecycle: 'ready' } });
  });

  it('restores historical assistant text without sending a new native turn', async () => {
    const transcriptPath = join(dir, 'saved-history.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', sessionId: nativeId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Saved assistant reply' }] } }) + '\n');
    const p = peer();
    const engine = open(p, { resume: true }, { ...runtime, transcriptPath });
    await engine.ready;
    expect(engine.adapter.host.recent.map(({ event }) => event).filter((event) =>
      event.type === 'transcript' && event.phase === 'completed' && event.role === 'assistant'))
      .toEqual([expect.objectContaining({ content: 'Saved assistant reply' })]);
    expect(p.prompts).toHaveLength(0);
  });

  it('refuses resume readiness when saved history cannot be read', async () => {
    const engine = open(peer(), { resume: true }, { ...runtime, transcriptPath: join(dir, 'missing.jsonl') });
    await expect(engine.ready).rejects.toThrow('ENOENT');
    expect(engine.adapter.host.snapshot().streamReady).toBe(false);
  });

  it('requires initialized SDK controls and SU tools without inventing a startup model turn', async () => {
    const p = peer(); const engine = open(p);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('starting');
    expect((await engine.adapter.host.acceptCommand(command(engine))).accepted).toBeNull();
    await engine.ready;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
    expect(engine.adapter.host.snapshot()).toMatchObject({ executorAttached: true, streamReady: true });
    expect(p.options()).toMatchObject({ sessionId: nativeId, cwd: dir, env: boot.envelopeEnv });
    expect(p.options()?.systemPrompt).toEqual({
      type: 'custom', prompt: readFileSync(promptFile, 'utf8'), snapshot: true,
    });
    expect(p.options()?.env?.PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED).toBe('1');
    expect(p.options()?.extraArgs).not.toHaveProperty('system-prompt-file');
    expect(p.options()?.disallowedTools).toEqual(expect.arrayContaining(['Task', 'Agent', 'Workflow']));
    expect(p.prompts).toHaveLength(0);
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript')).toBe(false);
  });

  it('delivers exact owner text and correlates the reply with the PUI turn', async () => {
    const p = peer(); const engine = open(p); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result.status).toBe('completed');
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(p.prompts[0].message.content).toBe('  hi 雪\n\n');
    expect(p.prompts[0].origin).toEqual({ kind: 'human' });
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'assistant', turnId: 'owner-turn-1', content: 'Correlated reply',
    }));
  });

  it('keeps overlapping accepted turns queued until the current reply completes', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const second = engine.adapter.host.startCommand({ ...command(engine), commandId: 'second-command', turnId: 'second-turn', content: 'second' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(p.prompts.filter((message) => message.shouldQuery !== false)).toHaveLength(1);
    p.output.write({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'text', text: 'first reply' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    expect((await second.terminal).status).toBe('completed');
    expect(p.prompts.at(-1)?.message.content).toBe('second');
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({ type: 'transcript', turnId: 'owner-turn-1', content: 'first reply' }));
  });

  it('streams a long native response before canonical replay or result completion without duplicating text', async () => {
    const p = peer({ streamOnly: true });
    const engine = open(p, { deliveryTimeoutMs: 100 });
    await engine.ready;
    expect((await engine.adapter.host.startCommand(command(engine)).terminal).status).toBe('completed');
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.role === 'assistant')).toBe(false);
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'long reply' } } });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'delta', turnId: 'owner-turn-1', content: 'long reply',
    })));
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.phase === 'completed')).toBe(false);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 } });
    // The canonical block is authoritative, including a tail missing from the
    // partial feed. It must finish the existing segment, not append a duplicate.
    p.output.write({ type: 'assistant', session_id: nativeId, message: { id: 'native-long-reply', content: [{ type: 'text', text: 'long reply finished' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', role: 'assistant', turnId: 'owner-turn-1', content: 'long reply finished',
    }));
    expect(engine.adapter.host.recent.map(({ event }) => event)
      .filter((event) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'completed'))
      .toHaveLength(1);
    expect(engine.adapter.host.recent.flatMap(({ event }) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'delta' ? [event.content] : []).join(''))
      .toBe('long reply finished');
  });

  it('reconciles separate text blocks sharing a native message id and preserves the intervening tool', async () => {
    const p = peer({ streamOnly: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const partial = (event: unknown, parent: string | null = null) => p.output.write({
      type: 'stream_event', session_id: nativeId, parent_tool_use_id: parent, event,
    });
    const canonical = (content: unknown[]) => p.output.write({ type: 'assistant', session_id: nativeId,
      message: { id: 'native-long-reply', content } });
    for (const index of [0, 2]) {
      partial({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      partial({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Same text.' } });
      await vi.waitFor(() => expect(engine.adapter.host.recent.filter(({ event }) => event.type === 'transcript'
        && event.phase === 'delta' && event.role === 'assistant')).toHaveLength(index === 0 ? 1 : 2));
      canonical([{ type: 'text', text: 'Same text.' }]);
      partial({ type: 'content_block_stop', index });
      if (index === 0) {
        canonical([{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: 'README.md' } }]);
        // A child response must not change which root block is being streamed.
        partial({ type: 'message_start', message: { id: 'child-message', role: 'assistant' } }, 'read-tool');
        partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child text' } }, 'read-tool');
      }
    }
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    const events = engine.adapter.host.recent.map(({ event }) => event);
    expect(events.filter((event) => event.type === 'transcript' && event.role === 'assistant' && event.phase === 'completed'))
      .toEqual([0, 2].map(() => expect.objectContaining({ content: 'Same text.', turnId: 'owner-turn-1' })));
    expect(events.filter((event) => event.type === 'tool' && event.phase === 'started')).toEqual([
      expect.objectContaining({ callId: 'read-tool', name: 'Read', turnId: 'owner-turn-1' }),
    ]);
    expect(events.some((event) => event.type === 'transcript' && 'content' in event && event.content === 'child text')).toBe(false);
  });

  it('preserves an interrupted partial response and clears its reconciliation state for the next owner turn', async () => {
    const p = peer({ streamOnly: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    p.output.write({ type: 'stream_event', session_id: nativeId, parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unfinished' } } });
    await vi.waitFor(() => expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'delta', content: 'unfinished',
    })));
    await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal;
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'completed', turnId: 'owner-turn-1', content: 'unfinished',
    }));
    await engine.adapter.host.startCommand({ ...command(engine), commandId: 'next-command', turnId: 'next-turn' }).terminal;
    p.output.write({ type: 'assistant', session_id: nativeId, message: { id: 'native-long-reply', content: [{ type: 'text', text: 'fresh reply' }] } });
    p.output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
    await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner'));
    expect(engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
      type: 'transcript', phase: 'completed', turnId: 'next-turn', content: 'fresh reply',
    }));
  });

  it('does not acknowledge owner input from a nested agent stream', async () => {
    const p = peer({ streamOnly: true, streamParent: 'other-agent-call' });
    const engine = open(p, { deliveryTimeoutMs: 20 });
    await engine.ready;
    expect(await engine.adapter.host.startCommand(command(engine)).terminal).toMatchObject({
      status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false },
    });
  });

  it('waits for a workspace-bound PUI answer before returning a Claude question result', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const input = { questions: [{ question: 'Which destination?', header: 'Destination', multiSelect: false,
      options: [{ label: 'Here', description: 'Current directory' }, { label: 'There', description: 'Another directory' }] }],
      answers: { 'Which destination?': 'forged answer' } };
    p.output.write({ type: 'assistant', session_id: nativeId, message: { content: [
      { type: 'tool_use', id: 'native-question', name: 'AskUserQuestion', input },
    ] } });
    const answer = p.options()!.canUseTool!('AskUserQuestion', input, {
      signal: new AbortController().signal, toolUseID: 'native-question', requestId: 'question-request',
    });
    let settled = false; void answer.then(() => { settled = true; });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const card = openCards(engine)[0];
    expect(card.correlationId).not.toBe('native-question');
    expect(settled).toBe(false);
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'wrong' }).ok).toBe(false);
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which destination?': 'There' } } });
    expect(openCards(engine)).toHaveLength(0);
    expect(engine.adapter.host.recent.filter(({ event }) => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
    expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
  });

  it('returns a native denial when a PUI permission is declined and cancels questions on interrupt', async () => {
    const p = peer({ holdResult: true }); const engine = open(p); await engine.ready;
    await engine.adapter.host.startCommand(command(engine)).terminal;
    const canUseTool = p.options()!.canUseTool!;
    const permission = canUseTool('Bash', { command: 'touch approved.txt' }, {
      signal: new AbortController().signal, toolUseID: 'permission', requestId: 'permission-request', title: 'Create approved.txt?',
    });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    const card = openCards(engine)[0];
    expect(resolveCardResponse({ correlationId: card.correlationId, action: 'submit', payload: { picks: ['1'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    const questions = canUseTool('AskUserQuestion', { questions: [
      { question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Second?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] }, { signal: new AbortController().signal, toolUseID: 'questions', requestId: 'two-questions' });
    await vi.waitFor(() => expect(openCards(engine)).toHaveLength(1));
    await engine.adapter.host.startCommand(command(engine, 'interrupt')).terminal;
    await expect(questions).resolves.toMatchObject({ behavior: 'deny' });
    expect(openCards(engine)).toHaveLength(0);
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'card' && event.phase === 'opened' && event.card.prompt === 'Second?')).toBe(false);
  });

  it('cleans up a disconnected SU tool connection before ready', async () => {
    const p = peer({ connected: false }); const engine = open(p);
    await expect(engine.ready).rejects.toThrow('SU tool connection is failed');
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'lifecycle' && event.state === 'ready')).toBe(false);
  });

  it('waits for a pending MCP handshake instead of mistaking it for a missing server', async () => {
    const p = peer({ pendingMcp: true }); const engine = open(p, { startupTimeoutMs: 1_000 });
    expect(engine.adapter.host.descriptor().lifecycle).toBe('starting');
    await engine.ready;
    expect(engine.adapter.host.descriptor().lifecycle).toBe('ready');
    expect(p.prompts).toHaveLength(0);
  });

  it.each([{ holdInit: true }, { holdMcp: true }])('bounds a stalled SDK control handshake and closes its peer: %j', async (config) => {
    const p = peer(config); const engine = open(p, { startupTimeoutMs: 20 });
    await expect(engine.ready).rejects.toThrow('timed out');
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
  });

  it.each([{ identity: 'other-session' }, { cwd: '/another-project' }])('refuses the first owner turn when its native identity or project differs: %j', async (config) => {
    const p = peer(config); const engine = open(p); await engine.ready;
    const result = await engine.adapter.host.startCommand(command(engine)).terminal;
    expect(result.status).toBe('refused');
    await engine.done;
    expect(p.close).toHaveBeenCalled();
    expect(engine.adapter.host.descriptor().lifecycle).toBe('failed');
    expect(engine.adapter.host.recent.some(({ event }) => event.type === 'transcript' && event.role === 'assistant')).toBe(false);
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
