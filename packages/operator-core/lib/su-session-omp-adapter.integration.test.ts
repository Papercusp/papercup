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
  createOmpSuSessionAdapter,
  ompThreadIdFromTranscriptPath,
  openOmpSuSession,
  resolveOmpSuRuntime,
  type OmpSuRuntimeBinding,
  type OmpSuSessionControls,
} from './su-session-omp-adapter';

const THREAD_A = '11111111-2222-4333-8444-555555555555';
const THREAD_B = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function binding(nativeSession: PuiSuSessionBinding['nativeSession'] = null): PuiSuSessionBinding {
  return {
    operation: 'created', backend: 'omp', advSessionId: 91, ownerId: 'su-omp-pui',
    workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', planSlug: 'pui-plan', nativeSession,
  };
}

function runtime(threadId = THREAD_A, agentHome: string | null = '/tmp/omp-agent', transcriptPath: string | null = null): OmpSuRuntimeBinding {
  return {
    nativeSession: {
      backend: 'omp', source: 'adv_sessions', ownerId: 'su-omp-pui', ompThreadId: threadId,
      agentHome, exactResumeSupported: true, missingReason: null,
    },
    transcriptPath,
  };
}

function command(adapter: ReturnType<typeof createOmpSuSessionAdapter>, value: SuSessionCommand<'omp'> extends infer C
  ? C extends SuSessionCommand<'omp'> ? Omit<C, 'schema' | 'protocolVersion' | 'issuedAt' | 'target'> : never : never): SuSessionCommand<'omp'> {
  return {
    schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    issuedAt: '2026-08-28T00:00:00.000Z', target: adapter.host.descriptor().identity, ...value,
  } as SuSessionCommand<'omp'>;
}

function events(adapter: ReturnType<typeof createOmpSuSessionAdapter>): SuSessionEvent<'omp'>[] {
  return adapter.host.recent.map(({ event }) => event);
}

describe('OMP SU-session backend — PUI entry and native session translation', () => {
  it('creates through the canonical PUI entry and translates OMP messages, tools, reasoning, and cards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-su-session-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, `${Date.now()}_${THREAD_A}.jsonl`);
    const lines = [
      { type: 'session', id: THREAD_A, timestamp: '2026-08-28T00:00:00.000Z', cwd: '/workspace' },
      { type: 'message', id: 'user-1', timestamp: '2026-08-28T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'inspect the tree' }] } },
      { type: 'message', id: 'assistant-1', timestamp: '2026-08-28T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should inspect first.' }, { type: 'text', text: 'I will inspect it.' }, { type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { command: 'pwd' } }] } },
      { type: 'message', id: 'tool-1', timestamp: '2026-08-28T00:00:03.000Z', message: { role: 'toolResult', content: [{ type: 'text', text: '/workspace' }], toolCallId: 'call-bash' } },
      { type: 'message', id: 'assistant-2', timestamp: '2026-08-28T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } },
      { type: 'message', id: 'assistant-card', timestamp: '2026-08-28T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-ask', name: 'AskUserQuestion', arguments: { questions: [{ question: 'Ship this change?', options: [{ label: 'Ship' }, { label: 'Hold' }] }] } }] } },
      { type: 'message', id: 'tool-card', timestamp: '2026-08-28T00:00:06.000Z', message: { role: 'toolResult', content: [{ type: 'text', text: 'Ship' }], toolCallId: 'call-ask' } },
    ];
    writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: 'ok', deferred: true, advSessionId: 91, ownerId: 'su-omp-pui', agent: body.agent, workspaceId: 'papercusp-workspace', harnessSlug: body.harness_slug, planSlug: body.plan_slug, nativeSession: null }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const ownerTurn = vi.fn<OmpSuSessionControls['ownerTurn']>(async () => ({ ok: true }));
    const opened = await openOmpSuSession(
      { operation: 'create', backend: 'omp', carry: 'warm', slug: 'papercusp', planSlug: 'pui-plan', model: 'gpt-5.6-omp', account: 'default' },
      { agentChatId: 'agent-chat-omp-create', controls: { ownerTurn }, resolveRuntime: async () => runtime(THREAD_A, dir, transcriptPath) },
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const adapter = opened.adapter;
    try {
      expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ agent: 'omp', defer_spawn: false, attached_engine: true, carry: 'warm' });
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'owner_turn', commandId: 'owner-1', turnId: 'pui-turn-1', content: 'inspect the tree' }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(ownerTurn).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', turnId: 'pui-turn-1', content: 'inspect the tree' });
      await adapter.consumeTranscriptSnapshot();
      const all = events(adapter);
      expect(adapter.host.descriptor()).toMatchObject({ lifecycle: 'waiting-for-owner', model: 'gpt-5.6-omp', identity: { nativeSessionId: THREAD_A }, backendExtension: { backend: 'omp', agentHome: dir } });
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'owner' && event.content === 'inspect the tree')).toBe(true);
      expect(all.some((event) => event.type === 'transcript' && event.phase === 'delta' && event.role === 'assistant' && event.channel === 'reasoning' && event.content === 'I should inspect first.')).toBe(true);
      expect(all.find((event) => event.type === 'tool' && event.phase === 'started' && event.callId === 'call-bash')).toMatchObject({ name: 'bash', input: { command: 'pwd' } });
      expect(all.find((event) => event.type === 'tool' && event.phase === 'completed' && event.callId === 'call-bash')).toMatchObject({ output: '/workspace', isError: false });
      expect(all.find((event) => event.type === 'card' && event.phase === 'opened' && event.card.correlationId === 'call-ask')).toMatchObject({ card: { prompt: 'Ship this change?', presentation: { kind: 'radio' } } });
      expect(all.find((event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === 'call-ask')).toMatchObject({ resolution: 'submitted' });
    } finally { adapter.dispose(); }
  });

  it('repairs a stale shared-home attach handle to the tracked per-row OMP home', async () => {
    const returned = runtime(THREAD_A, '/home/test/.omp/agent').nativeSession;
    const resolved = await resolveOmpSuRuntime(binding(returned));
    expect(resolved?.nativeSession.agentHome).toMatch(
      /\/\.papercusp\/su-omp-homes\/session-91\/agent$/,
    );
    expect(resolved?.nativeSession.agentHome).not.toBe('/home/test/.omp/agent');
  });

  it('maps interrupt/resume, preserves identity on replacement, and converges unexpected exit', async () => {
    const interrupt = vi.fn<OmpSuSessionControls['interrupt']>(async () => ({ ok: true }));
    const resume = vi.fn<OmpSuSessionControls['resume']>(async () => ({ ok: true }));
    const adapter = createOmpSuSessionAdapter(binding(), runtime(), { agentChatId: 'agent-chat-omp-reconcile', controls: { interrupt, resume }, register: false });
    try {
      const identity = adapter.host.descriptor().identity;
      const interrupted = adapter.host.startCommand(command(adapter, { type: 'interrupt', commandId: 'interrupt-1', reason: 'owner stop' }));
      await expect(interrupted.terminal).resolves.toMatchObject({ status: 'completed' });
      const resumed = adapter.host.startCommand(command(adapter, { type: 'resume', commandId: 'resume-1', cause: 'runtime-replacement' }));
      await expect(resumed.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(resume).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', threadId: THREAD_A, cause: 'runtime-replacement' });
      adapter.replaceRuntime(runtime(THREAD_B, '/tmp/omp-successor'), 'carry successor attached');
      expect(adapter.host.descriptor()).toMatchObject({ identity, runtimeGeneration: 1, lifecycle: 'ready', backendExtension: { backend: 'omp', agentHome: '/tmp/omp-successor' } });
      adapter.reconcileRuntimeExit({ expected: false, exitCode: 17, signal: null });
      expect(adapter.host.descriptor().lifecycle).toBe('failed');
    } finally { adapter.dispose(); }
  });

  it('maps accepted end and rejects malformed native records without killing the host', async () => {
    const end = vi.fn<OmpSuSessionControls['end']>(async () => ({ ok: true }));
    const adapter = createOmpSuSessionAdapter(binding(), runtime(), { agentChatId: 'agent-chat-omp-end', controls: { end }, register: false });
    try {
      adapter.ingestNativeLine('{not-json');
      expect(events(adapter).some((event) => event.type === 'error' && event.code === 'omp_record_malformed')).toBe(true);
      const dispatch = adapter.host.startCommand(command(adapter, { type: 'end', commandId: 'end-1', reason: 'PUI pane closed' }));
      await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
      expect(end).toHaveBeenCalledWith({ ownerId: 'su-omp-pui', reason: 'PUI pane closed' });
      expect(adapter.host.descriptor().lifecycle).toBe('ended');
      expect(ompThreadIdFromTranscriptPath(`/tmp/sessions/123_${THREAD_A}.jsonl`)).toBe(THREAD_A);
      expect(ompThreadIdFromTranscriptPath('/tmp/sessions/no-thread.txt')).toBeNull();
    } finally { adapter.dispose(); }
  });
});
