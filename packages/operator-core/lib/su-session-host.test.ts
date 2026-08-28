import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCapabilities,
  type SuSessionCommand,
  type SuSessionDescriptor,
  type SuSessionEvent,
} from '@papercusp/chat-protocol';
import {
  SuSessionHost,
  SuSessionHostError,
  _resetSuSessionHostsForTest,
  createSuSessionEventResponse,
  registerSuSessionHost,
  type SuSessionCommandExecutor,
} from './su-session-host';

const supported = { state: 'supported', implementation: 'native' } as const;
const hostSupported = { state: 'supported', implementation: 'host' } as const;
const capabilities: SuSessionCapabilities = {
  commands: {
    owner_turn: supported,
    interrupt: supported,
    resume: supported,
    fork: { state: 'unsupported', reason: 'fake backend has no fork' },
    focus: hostSupported,
    end: supported,
  },
  features: {
    'tool-events': supported,
    'interactive-cards': supported,
    'reasoning-stream': supported,
    usage: supported,
    compaction: supported,
  },
};

function descriptor(): SuSessionDescriptor<'claude'> {
  return {
    identity: {
      agentChatId: 'chat-1',
      advSessionId: 41,
      backend: 'claude',
      nativeSessionId: 'claude-native-1',
      ownerId: 'su-owner',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
    },
    lifecycle: 'starting',
    runtimeGeneration: 1,
    role: 'su',
    model: 'claude-opus',
    accountRoute: 'default',
    carry: 'warm',
    modes: ['auto'],
    capabilities,
    backendExtension: {
      backend: 'claude',
      configDir: '/tmp/claude-su',
      configDirSource: 'live-process',
    },
  };
}

function command(type: SuSessionCommand<'claude'>['type'], commandId = `command-${type}`): SuSessionCommand<'claude'> {
  const base = {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId,
    issuedAt: '2026-08-28T00:00:00.000Z',
    target: descriptor().identity,
  };
  switch (type) {
    case 'owner_turn':
      return { ...base, type, turnId: 'turn-1', content: 'Continue.' };
    case 'interrupt':
      return { ...base, type, reason: 'owner interrupt' };
    case 'resume':
      return { ...base, type, cause: 'pui-restart' };
    case 'fork':
      return { ...base, type, fromSequence: 3 };
    case 'focus':
      return { ...base, type };
    case 'end':
      return { ...base, type, reason: 'owner ended' };
  }
}

function eventTypes(host: SuSessionHost<'claude'>): string[] {
  return host.recent.map(({ event }) => event.type);
}

afterEach(() => {
  _resetSuSessionHostsForTest();
  vi.restoreAllMocks();
});

describe('SuSessionHost', () => {
  it('orders command acknowledgements, transcript/tool/card events, and typed backend metadata', async () => {
    const executor: SuSessionCommandExecutor<'claude'> = async (input, context) => {
      if (input.type === 'owner_turn') {
        context.emit({
          type: 'transcript',
          phase: 'delta',
          turnId: input.turnId,
          role: 'assistant',
          channel: 'text',
          content: 'Working',
        });
        context.emit({
          type: 'tool',
          phase: 'completed',
          turnId: input.turnId,
          callId: 'tool-1',
          name: 'coord:orient',
          output: { ok: true },
          isError: false,
        });
        context.emit({
          type: 'card',
          phase: 'opened',
          turnId: input.turnId,
          card: { correlationId: 'card-1', createdAt: 1, prompt: 'Choose' },
        });
        context.emit({
          type: 'backend',
          extension: {
            backend: 'claude',
            configDir: '/tmp/replaced',
            configDirSource: 'runtime-reattach',
          },
        });
      }
      return { status: 'completed' };
    };
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: executor });

    const dispatch = host.startCommand(command('owner_turn'));
    expect(dispatch.accepted).toMatchObject({ status: 'accepted', sequence: 2 });
    await expect(dispatch.terminal).resolves.toMatchObject({
      status: 'completed',
      sequence: 7,
    });

    expect(eventTypes(host)).toEqual([
      'session',
      'command_result',
      'transcript',
      'tool',
      'card',
      'backend',
      'command_result',
    ]);
    expect(host.recent.map(({ id, event }) => [id, event.sequence])).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((sequence) => [sequence, sequence]),
    );
    expect(host.descriptor().backendExtension).toEqual({
      backend: 'claude',
      configDir: '/tmp/replaced',
      configDirSource: 'runtime-reattach',
    });
  });

  it('executes one command id once and replays the same accepted/terminal result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => {
      await gate;
      return { status: 'completed' };
    });
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const input = command('owner_turn', 'same-id');

    const first = host.startCommand(input);
    const duplicate = host.startCommand(JSON.parse(JSON.stringify(input)));
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.accepted).toBe(first.accepted);
    expect(duplicate.terminal).toBe(first.terminal);
    release();
    await first.terminal;

    const lateDuplicate = host.startCommand(input);
    await lateDuplicate.terminal;
    expect(lateDuplicate.replayed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      host.recent.filter(({ event }) => event.type === 'command_result' && event.commandId === 'same-id'),
    ).toHaveLength(2);
  });

  it('rejects a command-id collision without re-running the original command', async () => {
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => ({
      status: 'completed',
    }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    await host.startCommand(command('owner_turn', 'collision')).terminal;
    const changed = {
      ...command('owner_turn', 'collision'),
      content: 'Different content',
    };

    expect(() => host.startCommand(changed)).toThrowError(SuSessionHostError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.recent.at(-1)?.event).toMatchObject({
      type: 'error',
      code: 'command_id_conflict',
    });
  });

  it('converges a crashed runtime once and visibly refuses later commands', async () => {
    const execute = vi.fn<SuSessionCommandExecutor<'claude'>>(async () => ({
      status: 'completed',
    }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });

    host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
    host.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
    expect(host.descriptor().lifecycle).toBe('failed');
    expect(host.recent.filter(({ event }) => event.type === 'lifecycle' && event.state === 'failed')).toHaveLength(1);

    const refused = host.startCommand(command('owner_turn', 'after-crash'));
    expect(refused.accepted).toBeNull();
    await expect(refused.terminal).resolves.toMatchObject({
      status: 'refused',
      refusal: { code: 'session_terminal', retryable: false },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reconnects with Last-Event-ID without duplication after a consumer drops', async () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    registerSuSessionHost(host);
    host.transition('ready'); // sequence 2

    const first = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let firstText = '';
    for (let i = 0; i < 8 && !firstText.includes('id: 2'); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstText += decoder.decode(chunk.value, { stream: true });
    }
    expect(firstText).toContain('id: 1');
    expect(firstText).toContain('id: 2');
    await reader.cancel();
    await vi.waitFor(() => expect(host.subscriberCount).toBe(0));

    host.emit({
      type: 'transcript',
      phase: 'delta',
      turnId: 'turn-2',
      role: 'assistant',
      channel: 'text',
      content: 'missed while disconnected',
    }); // sequence 3
    host.emit({
      type: 'tool',
      phase: 'started',
      turnId: 'turn-2',
      callId: 'call-2',
      name: 'plans:get',
    }); // sequence 4

    const resumed = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events', {
        headers: { 'Last-Event-ID': '2' },
      }),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    queueMicrotask(() => {
      host.reconcileRuntimeExit({ expected: true, exitCode: 0 }); // sequence 5
    });
    const resumedText = await resumed.text();
    expect(resumedText).toContain('id: 3');
    expect(resumedText).toContain('id: 4');
    expect(resumedText).toContain('id: 5');
    expect(resumedText).not.toContain('id: 1\n');
    expect(resumedText).not.toContain('id: 2\n');
    expect(resumedText.match(/id: 3/g)).toHaveLength(1);
  });

  it('emits resync for an evicted replay gap, then continues from the live edge', async () => {
    const host = new SuSessionHost({ descriptor: descriptor(), replaySize: 2 });
    registerSuSessionHost(host);
    host.transition('ready'); // 2
    host.emit({
      type: 'transcript',
      phase: 'delta',
      turnId: 'turn-gap',
      role: 'assistant',
      channel: 'text',
      content: 'three',
    }); // 3
    host.emit({
      type: 'tool',
      phase: 'started',
      turnId: 'turn-gap',
      callId: 'call-gap',
      name: 'coord:orient',
    }); // 4, ring now [3,4]

    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events', {
        headers: { 'Last-Event-ID': '1' },
      }),
      host as SuSessionHost,
      { heartbeatMs: 0 },
    );
    queueMicrotask(() => {
      host.reconcileRuntimeExit({ expected: true, exitCode: 0 }); // 5
    });
    const text = await response.text();
    expect(text).toContain('event: resync');
    expect(text).toContain('"reason":"gap"');
    expect(text).not.toContain('id: 3\n');
    expect(text).not.toContain('id: 4\n');
    expect(text).toContain('id: 5');
  });

  it('unsubscribes a response whose body remains backpressured', async () => {
    const host = new SuSessionHost({ descriptor: descriptor() });
    registerSuSessionHost(host);
    const response = createSuSessionEventResponse(
      new Request('http://localhost/su-session/events'),
      host as SuSessionHost,
      { heartbeatMs: 0, backpressureTimeoutMs: 5 },
    );

    await vi.waitFor(() => expect(host.subscriberCount).toBe(0), { timeout: 250 });
    await response.body?.cancel();
  });
});

describe('agent-chat SU-session route registration', () => {
  it('mounts snapshot, resumable event, and command endpoints on agent-chats', async () => {
    const routes = (await import('./endpoint-route/routes/agent-chats/su-session')).default;
    expect(routes.map((route) => [route.method, route.path])).toEqual([
      ['GET', '/harness/:slug/agent-chats/:chatId/su-session'],
      ['GET', '/harness/:slug/agent-chats/:chatId/su-session/events'],
      ['POST', '/harness/:slug/agent-chats/:chatId/su-session/commands'],
    ]);
  });
});
