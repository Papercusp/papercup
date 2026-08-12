import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatAction } from './registry';

// Side-effect import — registers session-actions into the shared registry
// once for this file (same pattern as PostureActions.test.ts).
import './SessionActions';
import {
  canFocusWindow,
  canForkSession,
  focusWindow,
  launchInNewTerminal,
  resumableSessionId,
  stopAgent,
  type SessionActionCtx,
} from './SessionActions';

const baseCtx: SessionActionCtx = { sessionOwnerId: 'su-abc123' };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionActions — pure predicates', () => {
  it('resumableSessionId: codex is always excluded, regardless of id fields', () => {
    expect(resumableSessionId({ ...baseCtx, agent: 'codex', sessionId: 'x', ompThreadId: 'y' })).toBeNull();
  });

  it('resumableSessionId: prefers claude sessionId, falls back to ompThreadId', () => {
    expect(resumableSessionId({ ...baseCtx, agent: 'claude', sessionId: 's1' })).toBe('s1');
    expect(resumableSessionId({ ...baseCtx, agent: 'omp', ompThreadId: 't1' })).toBe('t1');
    expect(resumableSessionId({ ...baseCtx, agent: 'claude', sessionId: 's1', ompThreadId: 't1' })).toBe('s1');
  });

  it('resumableSessionId: null when neither id is present', () => {
    expect(resumableSessionId({ ...baseCtx, agent: 'claude' })).toBeNull();
  });

  it('canForkSession: true only for claude', () => {
    expect(canForkSession({ ...baseCtx, agent: 'claude' })).toBe(true);
    expect(canForkSession({ ...baseCtx, agent: 'omp' })).toBe(false);
    expect(canForkSession({ ...baseCtx, agent: 'codex' })).toBe(false);
    expect(canForkSession({ ...baseCtx })).toBe(false);
  });

  it('canFocusWindow: true with a windowId, an advSessionId, or both; false with neither (pid alone is not enough)', () => {
    expect(canFocusWindow({ ...baseCtx, windowId: 'w1' })).toBe(true);
    expect(canFocusWindow({ ...baseCtx, advSessionId: 42 })).toBe(true);
    expect(canFocusWindow({ ...baseCtx, windowId: 'w1', advSessionId: 42 })).toBe(true);
    expect(canFocusWindow({ ...baseCtx, pid: 1234 })).toBe(false);
    expect(canFocusWindow({ ...baseCtx })).toBe(false);
  });
});

// P-015: three INDEPENDENT one-click buttons mirroring AgentInspectorModal,
// replacing P-006's single `session-actions` entry whose params opened a radio
// card. The behaviour under test moved from "which options does the card
// offer" to "which buttons are available" — same predicates, different shape.
const IDS = ['session-resume', 'session-fork', 'session-focus', 'session-stop'] as const;

describe('SessionActions — registration', () => {
  it('registers three separate actions, all in the "session" group', () => {
    for (const id of IDS) {
      const action = getChatAction(id);
      expect(action, `${id} should be registered`).toBeDefined();
      expect(action?.group).toBe('session');
    }
  });

  it('the old collapsed single-entry action is gone', () => {
    expect(getChatAction('session-actions')).toBeUndefined();
  });

  it('none of them declares params — a click runs the action directly', () => {
    // This is what makes them ONE-CLICK, matching the dropdown. A params()
    // here would silently reintroduce the card step P-015 exists to remove.
    for (const id of IDS) {
      expect(getChatAction(id)!.params, `${id} must not declare params`).toBeUndefined();
    }
  });

  it('carries the dropdown\'s icons so the two surfaces read as the same control', () => {
    expect(getChatAction('session-resume')!.icon).toBe('↻');
    expect(getChatAction('session-fork')!.icon).toBe('⑂');
  });

  it('registers stop as a confirmed one-click action', () => {
    expect(getChatAction('session-stop')!.label).toBe('Stop agent');
    expect(getChatAction('session-stop')!.params).toBeUndefined();
    const confirm = getChatAction('session-stop')!.confirm;
    expect(typeof confirm).toBe('function');
    if (typeof confirm !== 'function') return;
    expect(confirm({ ...baseCtx })).toMatchObject({
      confirmLabel: 'Stop agent',
    });
  });
});

describe('SessionActions — per-button availability', () => {
  const availability = (ctx: SessionActionCtx): string[] =>
    IDS.filter((id) => getChatAction(id)!.available(ctx));

  it('claude session with a window: all three buttons', () => {
    expect(availability({ ...baseCtx, agent: 'claude', sessionId: 's1', windowId: 'w1' })).toEqual([
      'session-resume', 'session-fork', 'session-focus', 'session-stop',
    ]);
  });

  it('omp session: resumable but NOT forkable (--fork-session is claude-only)', () => {
    expect(availability({ ...baseCtx, agent: 'omp', ompThreadId: 't1' })).toEqual(['session-resume', 'session-stop']);
  });

  it('codex session with an advSessionId: focus only, never resume/fork', () => {
    expect(availability({ ...baseCtx, agent: 'codex', sessionId: 's1', advSessionId: 7 })).toEqual([
      'session-focus', 'session-stop',
    ]);
  });

  it('no sessionOwnerId: nothing is offered', () => {
    expect(availability({ sessionOwnerId: '', agent: 'claude', sessionId: 's1', windowId: 'w1' })).toEqual([]);
  });

  it('claude session with no window: resume + fork, but no focus', () => {
    expect(availability({ ...baseCtx, agent: 'claude', sessionId: 's1' })).toEqual([
      'session-resume', 'session-fork', 'session-stop',
    ]);
  });

  it('pid alone does not make a window focusable', () => {
    expect(availability({ ...baseCtx, pid: 1234 })).toEqual(['session-stop']);
  });
});

describe('SessionActions — run dispatches without a card', () => {
  it('session-resume posts fork:false', async () => {
    await getChatAction('session-resume')!.run(
      { ...baseCtx, agent: 'claude', sessionId: 's1', ownerLabel: 'Ada' } as SessionActionCtx,
      undefined,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ fork: false });
  });

  it('session-fork posts fork:true', async () => {
    await getChatAction('session-fork')!.run(
      { ...baseCtx, agent: 'claude', sessionId: 's1', ownerLabel: 'Ada' } as SessionActionCtx,
      undefined,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ fork: true });
  });

  it('session-focus posts to the focus route', async () => {
    await getChatAction('session-focus')!.run({ ...baseCtx, advSessionId: 7 } as SessionActionCtx, undefined);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/adv/sessions/focus');
  });
});

describe('SessionActions — launchInNewTerminal', () => {
  it('resume posts resumeSessionId + fork:false + a label to the console launch route', async () => {
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1', ownerLabel: 'Ada' };
    await launchInNewTerminal(ctx, false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent-mcp/console/launch');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'text/plain' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ resumeSessionId: 's1', fork: false, label: 'resume · Ada' });
  });

  it('fork posts fork:true and a fork-labelled request', async () => {
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await launchInNewTerminal(ctx, true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ resumeSessionId: 's1', fork: true, label: 'fork · su-abc123' });
  });

  it('throws when no resumable session id is present', async () => {
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'codex', sessionId: 's1' };
    await expect(launchInNewTerminal(ctx, false)).rejects.toThrow(/no resumable session id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the server error when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await expect(launchInNewTerminal(ctx, false)).rejects.toThrow(/resume failed: boom/);
  });

  it('throws with the HTTP status when the response is not ok and carries no error body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => null });
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await expect(launchInNewTerminal(ctx, false)).rejects.toThrow(/resume failed: HTTP 502/);
  });

  it('throws when the response is ok but the payload status is not "ok"', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'error', error: 'nope' }) });
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await expect(launchInNewTerminal(ctx, false)).rejects.toThrow(/resume failed: nope/);
  });
});

describe('SessionActions — focusWindow', () => {
  it('posts id/windowId/pid to the focus route', async () => {
    const ctx: SessionActionCtx = { ...baseCtx, advSessionId: 7, windowId: 'w1', pid: 99 };
    await focusWindow(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/adv/sessions/focus');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ id: 7, windowId: 'w1', pid: 99 });
  });

  it('throws when there is nothing focusable (no windowId, no advSessionId)', async () => {
    const ctx: SessionActionCtx = { ...baseCtx, pid: 99 };
    await expect(focusWindow(ctx)).rejects.toThrow(/no focusable window/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with status + truncated body text when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'window not found' });
    const ctx: SessionActionCtx = { ...baseCtx, windowId: 'w1' };
    await expect(focusWindow(ctx)).rejects.toThrow(/focus failed: HTTP 404 — window not found/);
  });
});

describe('SessionActions — stopAgent', () => {
  it('posts the owner-targeted kill through the loopback admin proxy', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { results: [{ ok: true }] } }),
    });
    await stopAgent({ ...baseCtx, ownerLabel: 'Ada' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/coordination/fleet/kill');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'text/plain' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      owner: 'su-abc123',
      close_terminal: true,
    });
  });

  it('surfaces a failed kill instead of reporting success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { results: [{ ok: false, error: 'not found' }] } }),
    });
    await expect(stopAgent(baseCtx)).rejects.toThrow(/stop failed: not found/);
  });
});

// NOTE: the former 'SessionActions — run()' block lived here. It drove the
// single `session-actions` entry through a { picks: [...] } payload, which no
// longer exists — P-015 replaced the radio card with three direct buttons.
// Its coverage is preserved by 'SessionActions — run dispatches without a card'
// above, which asserts the same three outcomes via `run(ctx, undefined)`.
