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
vi.mock('../../operator-budget', () => ({
  checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
}));
// P-012: the text route falls back to the `humanFacingRole` voice pref when the
// caller didn't set an explicit body.role. Mutated per-test.
let humanFacingRole: 'operator' | 'papercup' = 'operator';
vi.mock('../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ humanFacingRole })),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

const fakeTool = {
  pluginName: 'test',
  description: 'fake',
  capabilities: [],
  expose: { mcp: { name: 'operator:converse' } },
  inputSchema: { type: 'object' },
  fn: async () => ({ content: [{ type: 'text', text: '{"totalCost":0,"assembled":""}' }] }),
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
