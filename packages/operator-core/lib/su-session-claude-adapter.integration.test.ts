import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionCommand,
  type SuSessionEvent,
} from '@papercusp/chat-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PuiSuSessionBinding } from './launch-agent';
import {
  claudeSessionIdFromTranscriptPath,
  createClaudeSuSessionAdapter,
  openClaudeSuSession,
  type ClaudeSuRuntimeBinding,
  type ClaudeSuSessionControls,
} from './su-session-claude-adapter';

const CLAUDE_SESSION_A = '11111111-2222-4333-8444-555555555555';
const CLAUDE_SESSION_B = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function binding(nativeSession: PuiSuSessionBinding['nativeSession'] = null): PuiSuSessionBinding {
  return {
    operation: 'created',
    backend: 'claude',
    advSessionId: 81,
    ownerId: 'su-claude-pui',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    planSlug: 'pui-plan',
    nativeSession,
  };
}

function runtime(
  sessionId = CLAUDE_SESSION_A,
  configDir: string | null = '/tmp/claude-config',
  transcriptPath: string | null = null,
): ClaudeSuRuntimeBinding {
  return {
    nativeSession: {
      backend: 'claude',
      source: 'adv_sessions',
      ownerId: 'su-claude-pui',
      sessionId,
      configDir,
      configDirSource: configDir ? 'live-process' : null,
      configDirUnresolvedReason: configDir ? null : 'not available in fixture',
      exactResumeSupported: true,
      missingReason: null,
    },
    transcriptPath,
  };
}

function command(
  adapter: ReturnType<typeof createClaudeSuSessionAdapter>,
  value: SuSessionCommand<'claude'> extends infer C
    ? C extends SuSessionCommand<'claude'>
      ? Omit<C, 'schema' | 'protocolVersion' | 'issuedAt' | 'target'>
      : never
    : never,
): SuSessionCommand<'claude'> {
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-28T00:00:00.000Z',
    target: adapter.host.descriptor().identity,
    ...value,
  } as SuSessionCommand<'claude'>;
}

function events(adapter: ReturnType<typeof createClaudeSuSessionAdapter>): SuSessionEvent<'claude'>[] {
  return adapter.host.recent.map(({ event }) => event);
}

describe('Claude SU-session backend — PUI entry and native transcript translation', () => {
  it('records the actual root model from native initialization and resumed transcript records', () => {
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), { agentChatId: 'model-proof', register: false });
    try {
      expect(adapter.host.descriptor().model).toBeNull();
      adapter.ingestNativeLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }));
      expect(adapter.host.descriptor().model).toBe('claude-sonnet-4-6');
      adapter.ingestNativeLine(JSON.stringify({ type: 'assistant', message: {
        role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'restored reply' }],
      } }));
      expect(adapter.host.descriptor().model).toBe('claude-opus-4-8');
      for (const line of [
        { type: 'user', message: { model: 'untrusted-user-value', content: 'hi' } },
        { type: 'assistant', parent_tool_use_id: 'child', message: { model: 'child-model', content: [] } },
        { type: 'assistant', isSidechain: true, message: { model: 'sidechain-model', content: [] } },
        { type: 'assistant', message: { model: '<synthetic>', content: [] } },
      ]) adapter.ingestNativeLine(JSON.stringify(line));
      expect(adapter.host.descriptor().model).toBe('claude-opus-4-8');
    } finally { adapter.dispose(); }
  });

  it('creates through the canonical PUI entry, translates prompts/tools/results, and opens typed cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-su-session-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${CLAUDE_SESSION_A}.jsonl`);
    const nativeLines = [
      {
        type: 'user', uuid: 'user-1', timestamp: '2026-08-28T00:00:01.000Z',
        message: { role: 'user', content: 'inspect the tree' },
      },
      {
        type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-28T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', id: 'toolu-bash', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
      {
        type: 'user', uuid: 'tool-result-1', timestamp: '2026-08-28T00:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu-bash', content: '/workspace' }],
        },
      },
      {
        type: 'assistant', uuid: 'assistant-2', timestamp: '2026-08-28T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
      {
        type: 'result', subtype: 'success', is_error: false, result: 'Done',
        timestamp: '2026-08-28T00:00:05.000Z',
      },
      {
        type: 'assistant', uuid: 'user-card', timestamp: '2026-08-28T00:00:06.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', id: 'toolu-ask', name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Ship this change?',
                multiSelect: false,
                options: [{ label: 'Ship', description: 'Deploy now' }, { label: 'Hold' }],
              }],
            },
          }],
        },
      },
      {
        type: 'user', uuid: 'card-result', timestamp: '2026-08-28T00:00:07.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu-ask', content: 'Ship' }],
        },
      },
    ];
    writeFileSync(transcriptPath, nativeLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: 'ok', deferred: true, advSessionId: 81, ownerId: 'su-claude-pui',
        agent: body.agent, workspaceId: 'papercusp-workspace', harnessSlug: body.harness_slug,
        planSlug: body.plan_slug, nativeSession: null,
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const ownerTurn = vi.fn<ClaudeSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const opened = await openClaudeSuSession(
      {
        operation: 'create', backend: 'claude', carry: 'warm', slug: 'papercusp',
        planSlug: 'pui-plan', model: 'claude-opus-4-8', account: 'default',
      },
      {
        agentChatId: 'agent-chat-claude-create',
        controls: { ownerTurn },
        resolveRuntime: async () => runtime(CLAUDE_SESSION_A, dir, transcriptPath),
      },
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const adapter = opened.adapter;
    try {
      const launchBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
      expect(launchBody).toMatchObject({ agent: 'claude', defer_spawn: false, attached_engine: true, carry: 'warm', harness_slug: 'papercusp' });

      const ownerDispatch = adapter.host.startCommand(command(adapter, {
        type: 'owner_turn', commandId: 'owner-command-1', turnId: 'pui-turn-1', content: 'inspect the tree',
      }));
      await expect(ownerDispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', turnId: 'pui-turn-1', content: 'inspect the tree' });

      await adapter.consumeTranscriptSnapshot();
      const all = events(adapter);
      expect(adapter.host.descriptor()).toMatchObject({
        lifecycle: 'waiting-for-owner', model: 'claude-opus-4-8',
        identity: { nativeSessionId: CLAUDE_SESSION_A },
        backendExtension: { backend: 'claude', configDir: dir, configDirSource: 'live-process' },
      });
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'owner' && event.content === 'inspect the tree')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.content === 'I will inspect it.')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.content === 'Done.')).toBe(true);
      expect(all.find((event) => event.type === 'tool' && event.phase === 'started' && event.callId === 'toolu-bash')).toMatchObject({ name: 'Bash', input: { command: 'pwd' } });
      expect(all.find((event) => event.type === 'tool' && event.phase === 'completed' && event.callId === 'toolu-bash')).toMatchObject({ name: 'Bash', output: '/workspace', isError: false });
      expect(all.find((event) => event.type === 'card' && event.phase === 'opened' && event.card.correlationId === 'toolu-ask')).toMatchObject({ card: { prompt: 'Ship this change?', presentation: { kind: 'radio' } } });
      expect(all.find((event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === 'toolu-ask')).toMatchObject({ resolution: 'submitted' });
    } finally {
      adapter.dispose();
    }
  });

  it('replays a transcript idempotently: an early and a late snapshot, and a live record, each show once (WI-10004162)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-su-replay-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${CLAUDE_SESSION_A}.jsonl`);
    const line = (value: Record<string, unknown>) => JSON.stringify(value);
    const first = [
      line({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi! What can I help you with?' }] } }),
      'not json at all',
    ];
    writeFileSync(transcriptPath, first.join('\n') + '\n');
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay', register: false,
    });
    const count = (role: string, content: string) => events(adapter).filter((event) =>
      event.type === 'transcript' && event.phase === 'delta' && event.role === role && event.content === content).length;
    const malformed = () => events(adapter).filter((event) => event.type === 'error' && event.code === 'claude_record_malformed').length;
    try {
      // The early replay (before the SDK launch) and the authoritative one
      // after the SU tool connection read the same file on one host.
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hi! What can I help you with?')).toBe(1);
      expect(malformed()).toBe(1);

      // A record the engine streamed live is not repeated by a later replay,
      // while a record the runtime wrote since the last replay is added.
      adapter.ingestNativeLine(line({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: 'live reply' }] } }));
      writeFileSync(transcriptPath, [...first,
        line({ type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: 'live reply' }] } }),
        line({ type: 'assistant', uuid: 'a-3', message: { role: 'assistant', content: [{ type: 'text', text: 'written since' }] } }),
      ].join('\n') + '\n');
      await adapter.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(count('owner', 'hi')).toBe(1);
      expect(count('assistant', 'Hi! What can I help you with?')).toBe(1);
      expect(count('assistant', 'live reply')).toBe(1);
      expect(count('assistant', 'written since')).toBe(1);
      expect(malformed()).toBe(1);
    } finally {
      adapter.dispose();
    }

    // Control: without the host's record ledger the same double replay shows
    // the greeting twice, the duplicate seen in the P-006 review — so the
    // counts above measure the dedup, not a quirk of the fixture.
    const control = createClaudeSuSessionAdapter(binding(), runtime(CLAUDE_SESSION_A, dir, transcriptPath), {
      agentChatId: 'agent-chat-claude-replay-control', register: false,
    });
    try {
      control.host.claimNativeRecord = () => true;
      await control.consumeTranscriptSnapshot({ preserveLifecycle: true });
      await control.consumeTranscriptSnapshot({ preserveLifecycle: true });
      expect(events(control).filter((event) => event.type === 'transcript' && event.phase === 'delta'
        && event.role === 'assistant' && event.content === 'Hi! What can I help you with?')).toHaveLength(2);
    } finally {
      control.dispose();
    }
  });

  it('maps interrupt/resume, preserves identity across replacement, and converges unexpected exit', async () => {
    const interrupt = vi.fn<ClaudeSuSessionControls['interrupt']>(async () => ({ ok: true }));
    const resume = vi.fn<ClaudeSuSessionControls['resume']>(async () => ({ ok: true }));
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-reconcile', controls: { interrupt, resume }, register: false,
    });
    try {
      const identity = adapter.host.descriptor().identity;
      const interrupted = adapter.host.startCommand(command(adapter, {
        type: 'interrupt', commandId: 'interrupt-command-1', reason: 'owner stop',
      }));
      await expect(interrupted.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(interrupt).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', reason: 'owner stop' });
      const resumed = adapter.host.startCommand(command(adapter, {
        type: 'resume', commandId: 'resume-command-1', cause: 'runtime-replacement',
      }));
      await expect(resumed.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(resume).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', sessionId: CLAUDE_SESSION_A, cause: 'runtime-replacement' });

      adapter.replaceRuntime(runtime(CLAUDE_SESSION_B, '/tmp/claude-config-successor'), 'carry successor attached');
      expect(adapter.host.descriptor()).toMatchObject({
        identity, runtimeGeneration: 1, lifecycle: 'ready',
        backendExtension: { backend: 'claude', configDir: '/tmp/claude-config-successor' },
      });
      expect(adapter.runtime.nativeSession.sessionId).toBe(CLAUDE_SESSION_B);

      adapter.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
      adapter.reconcileRuntimeExit({ expected: false, exitCode: 137, signal: 'SIGKILL' });
      expect(adapter.host.descriptor().lifecycle).toBe('failed');
      expect(events(adapter).filter((event) => event.type === 'lifecycle' && event.state === 'failed')).toHaveLength(1);
    } finally {
      adapter.dispose();
    }
  });

  it('maps an accepted native end to one terminal state and exposes stable transcript ids', async () => {
    const end = vi.fn<ClaudeSuSessionControls['end']>(async () => ({ ok: true }));
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-end', controls: { end }, register: false,
    });
    try {
      const dispatch = adapter.host.startCommand(command(adapter, {
        type: 'end', commandId: 'end-command-1', reason: 'PUI pane closed',
      }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(end).toHaveBeenCalledWith({ ownerId: 'su-claude-pui', reason: 'PUI pane closed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ended');
      expect(events(adapter).filter((event) => event.type === 'lifecycle' && event.state === 'ended')).toHaveLength(1);
      expect(claudeSessionIdFromTranscriptPath(`/tmp/projects/${CLAUDE_SESSION_A}.jsonl`)).toBe(CLAUDE_SESSION_A);
      expect(claudeSessionIdFromTranscriptPath('/tmp/projects/not-a-session.txt')).toBeNull();
    } finally {
      adapter.dispose();
    }
  });

  it('surfaces a recoverable native result failure once', () => {
    const adapter = createClaudeSuSessionAdapter(binding(), runtime(), {
      agentChatId: 'agent-chat-claude-error', register: false,
    });
    try {
      adapter.ingestNativeLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }));
      adapter.ingestNativeLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }));
      expect(events(adapter).filter((event) => event.type === 'error')).toEqual([
        expect.objectContaining({ scope: 'turn', code: 'error', message: 'rate limited', recoverable: true }),
      ]);
      expect(adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
    } finally {
      adapter.dispose();
    }
  });
});
