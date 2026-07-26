import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatAction } from './registry';
import type { CardOption, CardPresentation } from '@papercusp/agent-mcp';

// Side-effect import — registers session-actions into the shared registry
// once for this file (same pattern as PostureActions.test.ts).
import './SessionActions';
import {
  canFocusWindow,
  canForkSession,
  focusWindow,
  launchInNewTerminal,
  resumableSessionId,
  type SessionActionCtx,
} from './SessionActions';

/** Narrow a CardPresentation to its radio/checkbox member and pull `options`. */
function optionsOf(presentation: CardPresentation | undefined): CardOption[] {
  if (!presentation || (presentation.kind !== 'radio' && presentation.kind !== 'checkbox')) {
    throw new Error(`expected a radio/checkbox presentation, got ${presentation?.kind ?? 'undefined'}`);
  }
  return presentation.options;
}

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

describe('SessionActions — registration', () => {
  it('registers session-actions in the "session" group', () => {
    const action = getChatAction('session-actions');
    expect(action).toBeDefined();
    expect(action?.group).toBe('session');
  });

  it('available requires sessionOwnerId AND (resumable OR focusable)', () => {
    const action = getChatAction('session-actions')!;
    expect(action.available({ ...baseCtx, agent: 'claude', sessionId: 's1' })).toBe(true);
    expect(action.available({ ...baseCtx, windowId: 'w1' })).toBe(true);
    // no owner id
    expect(action.available({ sessionOwnerId: '', agent: 'claude', sessionId: 's1' })).toBe(false);
    // owner id present but neither resumable nor focusable
    expect(action.available({ ...baseCtx, agent: 'codex', sessionId: 's1' })).toBe(false);
    expect(action.available({ ...baseCtx })).toBe(false);
  });
});

describe('SessionActions — params (radio, options vary by ctx)', () => {
  it('claude session with a window: offers resume, fork, and focus', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1', windowId: 'w1' };
    const spec = await action.params!(ctx);
    expect(spec.presentation?.kind).toBe('radio');
    expect(spec.allowDecline).toBe(true);
    const ids = optionsOf(spec.presentation).map((o) => o.id);
    expect(ids).toEqual(['resume', 'fork', 'focus']);
  });

  it('omp session: resumable but not forkable (no fork option)', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'omp', ompThreadId: 't1' };
    const spec = await action.params!(ctx);
    const ids = optionsOf(spec.presentation).map((o) => o.id);
    expect(ids).toEqual(['resume']);
  });

  it('codex session with only a window: focus-only, no resume/fork', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'codex', sessionId: 's1', advSessionId: 7 };
    const spec = await action.params!(ctx);
    const ids = optionsOf(spec.presentation).map((o) => o.id);
    expect(ids).toEqual(['focus']);
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

describe('SessionActions — run()', () => {
  it('picking "resume" calls launchInNewTerminal(ctx, false)', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await action.run(ctx, { picks: ['resume'] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fork).toBe(false);
  });

  it('picking "fork" calls launchInNewTerminal(ctx, true)', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, agent: 'claude', sessionId: 's1' };
    await action.run(ctx, { picks: ['fork'] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fork).toBe(true);
  });

  it('picking "focus" calls focusWindow(ctx)', async () => {
    const action = getChatAction('session-actions')!;
    const ctx: SessionActionCtx = { ...baseCtx, windowId: 'w1' };
    await action.run(ctx, { picks: ['focus'] });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/adv/sessions/focus');
  });
});
