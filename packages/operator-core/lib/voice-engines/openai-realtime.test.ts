// @vitest-environment node
/**
 * Unit tests for the OpenAI Realtime full-agent engine (the fallback voice
 * provider, used when ElevenLabs Conv AI is down / over its concurrency limit).
 * It had zero coverage.
 *
 * The engine runs on the @openai/agents-realtime SDK (which wraps WebRTC + the
 * data channel + SDP), so we mock the SDK and the command registry and assert
 * the deterministic seams:
 *   - session/instruction shaping: persona always present; the converse prompt
 *     is layered in only in active mode; the language constraint is anchored
 *     from voice prefs;
 *   - tool-call dispatch round-trip: registry command/query defs become SDK
 *     tools whose execute() routes to runCommand/runQuery;
 *   - event parsing: history_updated → onTranscript / onAssistantText;
 *   - error + lifecycle: error event → onError; stop()/sendSystem() delegate to
 *     the session and swallow errors;
 *   - testRealtimeConnection request shaping + error mapping.
 *
 * P-003 of plan voice-production-test-coverage-2026-06-01.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── @openai/agents-realtime SDK mock ───────────────────────────────────────
const agentCfgs: Array<{ name: string; instructions: string; tools: Array<{ __tool: ToolDef }> }> = [];
const sessions: FakeSession[] = [];

interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (params: unknown) => Promise<unknown>;
}

class FakeSession extends EventEmitter {
  connectOpts: { apiKey?: string } | null = null;
  closeCalls = 0;
  closeThrows = false;
  sent: string[] = [];
  constructor(public agent: unknown) {
    super();
    sessions.push(this);
  }
  async connect(opts: { apiKey?: string }) {
    this.connectOpts = opts;
  }
  async close() {
    this.closeCalls += 1;
    if (this.closeThrows) throw new Error('close boom');
  }
  sendMessage(t: string) {
    this.sent.push(t);
  }
}

vi.mock('@openai/agents-realtime', () => ({
  // Regular functions (not arrows) so the SUT's `new RealtimeAgent(...)` /
  // `new RealtimeSession(...)` can construct them.
  RealtimeAgent: vi.fn(function (cfg: { name: string; instructions: string; tools: Array<{ __tool: ToolDef }> }) {
    agentCfgs.push(cfg);
    return { cfg };
  }),
  RealtimeSession: vi.fn(function (agent: unknown) {
    return new FakeSession(agent);
  }),
  tool: (def: ToolDef) => ({ __tool: def }),
}));

// ── command registry mock (drives buildRegistryTools) ──────────────────────
// `...args` so the `.mock.calls[N][i]` assertions type-check (bare `()=>` inferred a 0-arg empty tuple).
const runCommand = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'command' }));
const runQuery = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'query' }));
vi.mock('../commands/registry', () => ({
  list: vi.fn((sel: { kind: string }) =>
    sel.kind === 'command'
      ? [{ id: 'panel.open', description: 'Open panel', promptDescription: 'Open the panel', schema: {} }]
      : [{ id: 'status.summary', description: 'Status summary', schema: {} }],
  ),
  runCommand: (...a: unknown[]) => runCommand(...(a as [])),
  runQuery: (...a: unknown[]) => runQuery(...(a as [])),
}));
vi.mock('../commands/defs', () => ({}));

// ── operator mode (active vs passive) ───────────────────────────────────────
vi.mock('../operator-converse-tags', () => ({
  readOperatorModeFromSession: vi.fn(() => 'active'),
}));

import { readOperatorModeFromSession } from '../operator-converse-tags';
import { OPERATOR_PERSONA_PROMPT } from '../operator-persona';
import { OPERATOR_CONVERSE_PROMPT } from '../operator-converse-prompt';
import { startRealtimeSession, testRealtimeConnection } from './openai-realtime';

function prefsFetch(agentLanguage = 'en') {
  return vi.fn(async (url: string) => {
    if (String(url).includes('operator-voice-prefs')) {
      return new Response(JSON.stringify({ agentLanguage }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

beforeEach(() => {
  agentCfgs.length = 0;
  sessions.length = 0;
  runCommand.mockClear();
  runQuery.mockClear();
  vi.mocked(readOperatorModeFromSession).mockReturnValue('active');
  vi.stubGlobal('fetch', prefsFetch('en'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startRealtimeSession — instruction shaping', () => {
  it('always includes the operator persona', async () => {
    await startRealtimeSession('sk-test');
    expect(agentCfgs).toHaveLength(1);
    expect(agentCfgs[0].instructions).toContain(OPERATOR_PERSONA_PROMPT);
  });

  it('layers in the converse prompt in active mode', async () => {
    vi.mocked(readOperatorModeFromSession).mockReturnValue('active');
    await startRealtimeSession('sk-test');
    expect(agentCfgs[0].instructions).toContain(OPERATOR_CONVERSE_PROMPT);
  });

  it('omits the converse prompt in passive mode', async () => {
    vi.mocked(readOperatorModeFromSession).mockReturnValue('passive');
    await startRealtimeSession('sk-test');
    expect(agentCfgs[0].instructions).not.toContain(OPERATOR_CONVERSE_PROMPT);
    // persona still present
    expect(agentCfgs[0].instructions).toContain(OPERATOR_PERSONA_PROMPT);
  });

  it('anchors the reply language from voice prefs', async () => {
    vi.stubGlobal('fetch', prefsFetch('es'));
    await startRealtimeSession('sk-test');
    expect(agentCfgs[0].instructions).toContain('language code "es"');
  });

  it('falls back to English when the prefs fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await startRealtimeSession('sk-test');
    expect(agentCfgs[0].instructions).toContain('language code "en"');
  });
});

describe('startRealtimeSession — registry tools + dispatch', () => {
  it('exposes registry commands and queries as SDK tools (dotted ids → underscores)', async () => {
    await startRealtimeSession('sk-test');
    const names = agentCfgs[0].tools.map((t) => t.__tool.name).sort();
    expect(names).toEqual(['panel_open', 'status_summary']);
  });

  it('a command tool execute() round-trips through runCommand', async () => {
    await startRealtimeSession('sk-test');
    const cmd = agentCfgs[0].tools.find((t) => t.__tool.name === 'panel_open')!;
    const result = await cmd.__tool.execute({ foo: 1 });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toBe('panel.open');
    expect(runCommand.mock.calls[0][1]).toEqual({ foo: 1 });
    expect(result).toEqual({ ok: true, ran: 'command' });
  });

  it('a query tool execute() round-trips through runQuery', async () => {
    await startRealtimeSession('sk-test');
    const q = agentCfgs[0].tools.find((t) => t.__tool.name === 'status_summary')!;
    const result = await q.__tool.execute({});
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toBe('status.summary');
    expect(result).toEqual({ ok: true, ran: 'query' });
  });
});

describe('startRealtimeSession — connect, events, lifecycle', () => {
  it('connects with the provided api key', async () => {
    await startRealtimeSession('sk-secret');
    expect(sessions[0].connectOpts).toEqual({ apiKey: 'sk-secret' });
  });

  it('maps a user history entry to onTranscript', async () => {
    const onTranscript = vi.fn();
    await startRealtimeSession('sk-test', { onTranscript });
    sessions[0].emit('history_updated', [
      { type: 'message', role: 'user', content: [{ transcript: 'hello operator' }] },
    ]);
    expect(onTranscript).toHaveBeenCalledWith('hello operator');
  });

  it('maps an assistant history entry to onAssistantText', async () => {
    const onAssistantText = vi.fn();
    await startRealtimeSession('sk-test', { onAssistantText });
    sessions[0].emit('history_updated', [
      { type: 'message', role: 'assistant', content: [{ text: 'on it' }] },
    ]);
    expect(onAssistantText).toHaveBeenCalledWith('on it');
  });

  it('ignores an empty-transcript history entry', async () => {
    const onTranscript = vi.fn();
    await startRealtimeSession('sk-test', { onTranscript });
    sessions[0].emit('history_updated', [
      { type: 'message', role: 'user', content: [{ transcript: '   ' }] },
    ]);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('forwards a session error to onError as an Error', async () => {
    const onError = vi.fn();
    await startRealtimeSession('sk-test', { onError });
    sessions[0].emit('error', 'string failure');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe('string failure');
  });

  it('stop() closes the session and is safe to call twice / when close throws', async () => {
    const handle = await startRealtimeSession('sk-test');
    sessions[0].closeThrows = true;
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(sessions[0].closeCalls).toBe(2);
  });

  it('sendSystem() forwards to session.sendMessage', async () => {
    const handle = await startRealtimeSession('sk-test');
    handle.sendSystem('context: budget low');
    expect(sessions[0].sent).toEqual(['context: budget low']);
  });
});

describe('testRealtimeConnection', () => {
  it('POSTs the realtime sessions endpoint with Bearer + beta header and maps ok', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await testRealtimeConnection('sk-abc')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/sessions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
    expect(headers['OpenAI-Beta']).toBe('realtime=v1');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-4o-realtime-preview' });
  });

  it('maps a non-ok HTTP response to {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const res = await testRealtimeConnection('bad');
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('HTTP 401');
  });

  it('maps a thrown fetch to {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dns'); }));
    expect(await testRealtimeConnection('k')).toEqual({ ok: false, error: 'dns' });
  });
});
