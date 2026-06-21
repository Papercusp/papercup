/**
 * POST /device/operator/converse — assistant-turn persistence must store the
 * PARSED tag-protocol output, never the raw assembled turn.
 *
 * Regression: the device route persisted `assembled` verbatim (with
 * `<say>…</say>` / `<set_mode>` / `<report>` markup) into the SHARED
 * operator conversation thread. Every reader of that thread (desktop chat
 * hydration, TUI, the phone's own conversation GET) renders `text`
 * verbatim — so a phone-originated turn showed up in the desktop
 * transcript as literal "<say>Mobile client smoke test passed…</say>".
 * The desktop client persists `parsed.say` + `parsed.report`; the device
 * route must match that contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── module mocks ────────────────────────────────────────────────────────

// What the fake operator:converse run returns as its assembled turn.
// Mutated per-test before invoking the route.
let assembledTurn = '';

const appendTurn = vi.fn(async (input: Record<string, unknown>) => ({
  id: 'turn-1',
  seq: 1,
  createdAt: 0,
  ...input,
}));

vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
  listTurnsRecent: vi.fn(async () => ({ turns: [], hasMoreEarlier: false })),
  appendTurn: (input: Record<string, unknown>) => appendTurn(input),
}));

vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

// P-012: the device route reads the `humanFacingRole` voice pref to repoint the
// brain to the Sentinel persona. Mutated per-test.
let humanFacingRole: 'operator' | 'sentinel' = 'operator';
vi.mock('../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ humanFacingRole })),
}));

// The route side-effect-imports the full tool registry; stub it out so the
// test doesn't drag in (and register) every agent tool.
vi.mock('../../agent-tools/index', () => ({}));

const lookupByMcpName = vi.fn((name: string) => ({ name }));
const dispatchProjectedToolStream = vi.fn(async function* (
  _tool: unknown,
  _toolName: string,
  _args: unknown,
) {
  yield {
    kind: 'done' as const,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ totalCost: 0.001, assembled: assembledTurn }),
        },
      ],
    },
  };
});

vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/agent-mcp')>();
  return {
    ...original,
    lookupByMcpName: (name: string) => lookupByMcpName(name),
    // Minimal stand-in for the converse tool's stream: one `done` event
    // whose result carries the assembled turn, same shape as the real
    // operator:converse return.
    dispatchProjectedToolStream: (...args: Parameters<typeof dispatchProjectedToolStream>) =>
      dispatchProjectedToolStream(...args),
  };
});

import deviceConverseRoutes from '../routes/device/operator-converse';

// ─── helpers ─────────────────────────────────────────────────────────────

type RouteShaped = {
  method: string;
  path: string;
  handler: (req: Request, ctx: unknown) => Promise<Response> | Response;
};

const converse = (deviceConverseRoutes as unknown as RouteShaped[]).find(
  (r) => r.method === 'POST' && r.path === '/device/operator/converse',
);

async function runConverse(userText: string): Promise<Response> {
  if (!converse) throw new Error('converse route not found in module exports');
  const req = new Request('http://localhost/api/device/operator/converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: userText }),
  });
  const ctx = {
    principal: { kind: 'device', slug: 'device-1', label: 'Test Phone' },
    params: {},
  };
  const res = await converse.handler(req, ctx);
  // Drain the SSE body — sink.done() closes the stream once the handler's
  // setup (including the assistant-turn persist) has completed.
  await res.text();
  return res;
}

function assistantAppends(): Array<Record<string, unknown>> {
  return appendTurn.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((input) => input.role === 'assistant');
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('POST /device/operator/converse — assistant turn persistence', () => {
  beforeEach(() => {
    appendTurn.mockClear();
    assembledTurn = '';
    humanFacingRole = 'operator';
    lookupByMcpName.mockClear();
    dispatchProjectedToolStream.mockClear();
  });

  it('persists parsed.say, not the raw tag-wrapped turn', async () => {
    assembledTurn =
      '<say>Mobile client smoke test passed — one round trip, clean response.</say>\n' +
      '<set_mode>active</set_mode>';
    await runConverse('run the smoke test');

    const assistant = assistantAppends();
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe(
      'Mobile client smoke test passed — one round trip, clean response.',
    );
    // No tag markup may survive into the shared thread.
    expect(String(assistant[0].text)).not.toMatch(/<\/?(say|set_mode|report|spawn|sleep)\b/i);
  });

  it('persists a parsed <report> payload alongside the say', async () => {
    assembledTurn =
      '<say>Three plans in flight.</say>' +
      '<report>{"plans":[{"title":"Rate limit v2","status":"active",' +
      '"items":[{"id":"P-1","text":"ship the limiter","status":"done"}]}]}</report>';
    await runConverse('status?');

    const assistant = assistantAppends();
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe('Three plans in flight.');
    expect(assistant[0].report).toEqual({
      plans: [
        {
          slug: undefined,
          title: 'Rate limit v2',
          status: 'active',
          summary: undefined,
          items: [{ id: 'P-1', text: 'ship the limiter', status: 'done' }],
        },
      ],
    });
  });

  it('persists nothing for a going-silent (sleep-only) turn', async () => {
    assembledTurn = '<sleep duration_minutes="30" reason="user busy"/>';
    await runConverse('I am heads-down, leave me alone');

    expect(assistantAppends()).toHaveLength(0);
  });

  it('still persists bare prose from a turn the model forgot to tag', async () => {
    assembledTurn = 'Plain reply with no tags at all.';
    await runConverse('hello');

    const assistant = assistantAppends();
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe('Plain reply with no tags at all.');
  });

  it('always persists the user turn', async () => {
    assembledTurn = '<say>ok</say>';
    await runConverse('typed on the phone');

    const users = appendTurn.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((input) => input.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].text).toBe('typed on the phone');
  });
});

describe('POST /device/operator/converse — persona role resolution (P-012)', () => {
  beforeEach(() => {
    appendTurn.mockClear();
    assembledTurn = '<say>ok</say>';
    humanFacingRole = 'operator';
    lookupByMcpName.mockClear();
    dispatchProjectedToolStream.mockClear();
  });

  it('loads the sentinel brain when humanFacingRole=sentinel', async () => {
    humanFacingRole = 'sentinel';
    await runConverse('hey');
    expect(lookupByMcpName).toHaveBeenCalledWith('sentinel:converse');
    const [, toolName, args] = dispatchProjectedToolStream.mock.calls[0];
    expect(toolName).toBe('sentinel:converse');
    expect((args as { role?: string }).role).toBe('sentinel');
  });

  it('loads the operator brain by default (humanFacingRole=operator)', async () => {
    humanFacingRole = 'operator';
    await runConverse('hey');
    expect(lookupByMcpName).toHaveBeenCalledWith('operator:converse');
    const [, toolName, args] = dispatchProjectedToolStream.mock.calls[0];
    expect(toolName).toBe('operator:converse');
    expect((args as { role?: string }).role).toBe('operator');
  });
});
