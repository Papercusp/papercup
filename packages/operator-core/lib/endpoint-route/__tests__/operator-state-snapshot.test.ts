/**
 * Tests for the /state-snapshot SSE route. Drains the SSE wire stream
 * and asserts initial-dump + live-update shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(),
  // backup seam (pulled in transitively) reads workspacesRoot at import.
  workspacesRoot: vi.fn(() => '/tmp/papercusp-test-ws'),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser } from '../../auth';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  _resetStateChannelForTests,
  openRun,
  setOpenCards,
} from '@papercusp/agent-mcp';
import type { OpenCardSnapshot } from '@papercusp/agent-mcp';
import { registerAllRoutes } from '../register';

const ws = 'ws-test';

function card(id: string): OpenCardSnapshot {
  return {
    correlationId: id,
    prompt: `q-${id}`,
    dataSchemaJson: { type: 'object' },
    createdAt: Date.now(),
  };
}

let app: Hono;

function openSseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  async function next(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = buf.indexOf('\n\n');
      if (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.includes('event: snapshot')) return block;
        continue;
      }
      const readPromise = reader.read();
      const timed = await Promise.race([
        readPromise,
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (!timed) return null;
      if (timed.done) return null;
      buf += decoder.decode(timed.value, { stream: true });
    }
    return null;
  }

  async function close() { await reader.cancel().catch(() => {}); }
  return { next, close };
}

describe('GET /api/operator/state-snapshot', () => {
  beforeEach(() => {
    _resetStateChannelForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(activeWorkspaceId).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1',
      username: 'alice',
      display_name: 'Alice',
      has_password: true,
    });
    vi.mocked(activeWorkspaceId).mockReturnValue(ws);
    app = new Hono().basePath('/api');
    registerAllRoutes(app);
  });
  afterEach(() => _resetStateChannelForTests());

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await app.request('/api/operator/state-snapshot');
    expect(res.status).toBe(401);
  });

  it('initial dump: streams every currently-open run snapshot on connect', async () => {
    openRun({ workspaceId: ws, runId: 'rA' });
    openRun({ workspaceId: ws, runId: 'rB' });
    setOpenCards('rA', [card('a1')]);
    setOpenCards('rB', [card('b1'), card('b2')]);
    openRun({ workspaceId: 'other-ws', runId: 'rOther' });
    setOpenCards('rOther', [card('o1')]);

    const res = await app.request('/api/operator/state-snapshot');
    const r = openSseReader(res);
    const a = await r.next(1000);
    const b = await r.next(1000);
    await r.close();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const runIds = [a!, b!].map((e) => JSON.parse(e.split('data: ')[1]).runId);
    expect(new Set(runIds)).toEqual(new Set(['rA', 'rB']));
  });

  it('live updates: a setOpenCards after connect produces a snapshot event', async () => {
    openRun({ workspaceId: ws, runId: 'rLive' });
    setOpenCards('rLive', [card('first')]);

    const res = await app.request('/api/operator/state-snapshot');
    const r = openSseReader(res);
    const initial = await r.next(1000);
    expect(initial).not.toBeNull();

    setOpenCards('rLive', [card('first'), card('second')]);
    const live = await r.next(1000);
    await r.close();
    expect(live).not.toBeNull();
    const payload = JSON.parse(live!.split('data: ')[1]);
    expect(payload.snapshot.openCards.length).toBe(2);
    expect(payload.version).toBeGreaterThan(1);
  });
});
