/**
 * operator-converse SSE route — state-snapshot fan-out gating (audit).
 * Drives via the Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({
    id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    has_password: true,
  })),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
  // configureBackup (pulled in transitively via lib/backup) reads workspacesRoot;
  // omitting it broke this suite at import time after the @papercusp/backup seam landed.
  workspacesRoot: vi.fn(() => '/tmp/papercusp-test-ws'),
}));
vi.mock('../../operator-budget', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
  };
});
// P-012: the text route falls back to the `humanFacingRole` voice pref when the
// caller didn't set an explicit body.role. Mutated per-test.
let humanFacingRole: 'operator' | 'papercup' = 'operator';
vi.mock('../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ humanFacingRole })),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

// Records the args the route hands the converse tool (P-005: host-trust
// pass-through) — the stream result itself stays the minimal assembled turn.
const toolFn = vi.fn(async (_args: unknown, _ctx?: unknown) => ({
  content: [{ type: 'text', text: '{"totalCost":0,"assembled":""}' }],
}));
const fakeTool = {
  pluginName: 'test',
  description: 'fake',
  capabilities: [],
  expose: { mcp: { name: 'operator:converse' } },
  inputSchema: { type: 'object' },
  fn: (args: unknown, ctx?: unknown) => toolFn(args, ctx),
};

const lookupByMcpName = vi.fn((name: string) =>
  name === 'operator:converse' || name === 'papercup:converse' ? fakeTool : null,
);

vi.mock('@papercusp/agent-mcp', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/agent-mcp')>(
    '@papercusp/agent-mcp',
  );
  return {
    ...actual,
    lookupByMcpName: (name: string) => lookupByMcpName(name),
  };
});

vi.mock('../../agent-tools/index', () => ({}));

import { Hono } from 'hono';
import {
  _resetStateChannelForTests,
  openRun,
  setOpenCards,
} from '@papercusp/agent-mcp';
import { registerAllRoutes } from '../register';
import { UI_CONTEXT_MAX_CHARS } from '../../chat-context-sections';

let app: Hono;

beforeEach(() => {
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
  humanFacingRole = 'operator';
  lookupByMcpName.mockClear();
});
afterEach(() => _resetStateChannelForTests());

function post(body: object) {
  return app.request('/api/agent-mcp/operator-converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function collectEvents(res: Response, timeoutMs: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timed = await Promise.race([
      readPromise,
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (!timed) break;
    if (timed.done) break;
    buf += decoder.decode(timed.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.includes('event: state-snapshot')) events.push(block);
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

/** Same reader loop as collectEvents, but keeps every named event (not just
 *  state-snapshot) — used by the run-meta assertions below. */
async function collectAllEvents(res: Response, timeoutMs: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timed = await Promise.race([
      readPromise,
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (!timed) break;
    if (timed.done) break;
    buf += decoder.decode(timed.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      events.push(block);
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe('POST /api/agent-mcp/operator-converse — state-snapshot fan-out', () => {
  it('TEXT mode: does NOT subscribe; cross-conversation snapshots stay out', async () => {
    const res = await post({ messages: [], trigger: 'user_message' });
    openRun({ workspaceId: 'ws-test', runId: 'sibling-run' });
    setOpenCards('sibling-run', [
      {
        correlationId: 'cid-sibling',
        prompt: 'card from sibling',
        dataSchemaJson: {},
        fallbackText: 'sibling fallback',
        createdAt: 0,
      },
    ]);
    const events = await collectEvents(res, 300);
    expect(events).toEqual([]);
  });

  it('VOICE mode: forwards state-snapshots WITH fallbackText only', async () => {
    const res = await post({ messages: [], trigger: 'user_message', modality: 'voice' });
    openRun({ workspaceId: 'ws-test', runId: 'voice-run' });
    setOpenCards('voice-run', [
      {
        correlationId: 'cid-no-fb',
        prompt: 'no-fallback',
        dataSchemaJson: {},
        createdAt: 0,
      },
    ]);
    setOpenCards('voice-run', [
      {
        correlationId: 'cid-no-fb',
        prompt: 'no-fallback',
        dataSchemaJson: {},
        createdAt: 0,
      },
      {
        correlationId: 'cid-with-fb',
        prompt: 'with-fallback',
        dataSchemaJson: {},
        fallbackText: 'spoken text',
        createdAt: 0,
      },
    ]);
    const events = await collectEvents(res, 300);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].split('data: ')[1]);
    expect(payload.runId).toBe('voice-run');
    expect(payload.snapshot.openCards.some((c: { fallbackText?: string }) => c.fallbackText === 'spoken text')).toBe(true);
  });
});

describe('POST /api/agent-mcp/operator-converse — run-meta (WI-5023)', () => {
  // WI-5023: the route intentionally forwards state-snapshot cards onto THIS
  // stream only for modality='voice' — text-mode observers (llm-testing's
  // OperatorTarget) must instead watch the separate
  // GET /operator/state-snapshot channel, scoped to this turn's own runId.
  // `run-meta` is the (additive-only) mechanism that hands them that runId;
  // it must fire on EVERY modality, first, before any card traffic.
  it('emits run-meta with a runId on a TEXT turn (no modality forward, but still correlatable)', async () => {
    const res = await post({ messages: [], trigger: 'user_message' });
    const events = await collectAllEvents(res, 300);
    const runMeta = events.find((b) => b.includes('event: run-meta'));
    expect(runMeta).toBeDefined();
    const payload = JSON.parse(runMeta!.split('data: ')[1]);
    expect(typeof payload.runId).toBe('string');
    expect(payload.runId.length).toBeGreaterThan(0);
  });

  it('emits run-meta on a VOICE turn too, distinct from the state-snapshot forward', async () => {
    const res = await post({ messages: [], trigger: 'user_message', modality: 'voice' });
    const events = await collectAllEvents(res, 300);
    const runMeta = events.find((b) => b.includes('event: run-meta'));
    expect(runMeta).toBeDefined();
    const payload = JSON.parse(runMeta!.split('data: ')[1]);
    expect(typeof payload.runId).toBe('string');
  });
});

describe('POST /api/agent-mcp/operator-converse — persona role resolution (P-012)', () => {
  it('falls back to the sentinel brain when humanFacingRole=sentinel and no body role', async () => {
    humanFacingRole = 'papercup';
    const res = await post({ messages: [], trigger: 'user_message' });
    await collectEvents(res, 200);
    expect(lookupByMcpName).toHaveBeenCalledWith('papercup:converse');
    expect(lookupByMcpName).not.toHaveBeenCalledWith('operator:converse');
  });

  it('defaults to the operator brain when humanFacingRole is operator', async () => {
    humanFacingRole = 'operator';
    const res = await post({ messages: [], trigger: 'user_message' });
    await collectEvents(res, 200);
    expect(lookupByMcpName).toHaveBeenCalledWith('operator:converse');
    expect(lookupByMcpName).not.toHaveBeenCalledWith('papercup:converse');
  });

  it('an explicit body role WINS over the pref (P-006 precedence)', async () => {
    humanFacingRole = 'papercup';
    const res = await post({ messages: [], trigger: 'user_message', role: 'operator' });
    await collectEvents(res, 200);
    expect(lookupByMcpName).toHaveBeenCalledWith('operator:converse');
    expect(lookupByMcpName).not.toHaveBeenCalledWith('papercup:converse');
  });
});

describe('POST /api/agent-mcp/operator-converse — host-trust pass-through (papercup-chat P-005, D-007 §2)', () => {
  it('forwards hostTrust / principalToken (trimmed) / uiContext to the converse tool; absent ⇒ owner', async () => {
    toolFn.mockClear();
    let res = await post({
      messages: [],
      trigger: 'user_message',
      role: 'papercup',
      hostTrust: 'public',
      principalToken: '  portal-user-bearer  ',
      uiContext: '{"pane":"chat"}',
    });
    await collectEvents(res, 200);
    expect(toolFn).toHaveBeenCalled();
    expect(toolFn.mock.calls.at(-1)?.[0]).toMatchObject({
      role: 'papercup',
      hostTrust: 'public',
      principalToken: 'portal-user-bearer',
      uiContext: '{"pane":"chat"}',
    });
    // The desktop / TUI send none of them ⇒ the byte-identical owner path.
    toolFn.mockClear();
    res = await post({ messages: [], trigger: 'user_message', role: 'papercup' });
    await collectEvents(res, 200);
    expect(toolFn).toHaveBeenCalled();
    expect(toolFn.mock.calls.at(-1)?.[0]).toMatchObject({
      hostTrust: 'owner',
      principalToken: undefined,
      uiContext: undefined,
    });
  });

  it('rejects an unknown hostTrust and an oversized uiContext with 400 before any brain work', async () => {
    toolFn.mockClear();
    expect((await post({ messages: [], hostTrust: 'root' })).status).toBe(400);
    expect((await post({ messages: [], uiContext: 'x'.repeat(UI_CONTEXT_MAX_CHARS + 1) })).status).toBe(400);
    expect((await post({ messages: [], uiContext: 42 })).status).toBe(400);
    expect(toolFn).not.toHaveBeenCalled();
  });
});
