/**
 * Tests for the /state-snapshot SSE route.
 *
 * The route emits an SSE ReadableStream; we drain the stream with a
 * reader and assert the wire shape. Tests run in node env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/lib/workspace-registry', () => ({ activeWorkspaceId: vi.fn() }));

import { getSessionUser } from '@/lib/auth';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  _resetStateChannelForTests,
  openRun,
  setOpenCards,
} from '@papercusp/agent-mcp';
import type { OpenCardSnapshot } from '@papercusp/agent-mcp';

import { GET } from './route';

const ws = 'ws-test';

function card(id: string): OpenCardSnapshot {
  return {
    correlationId: id,
    prompt: `q-${id}`,
    dataSchemaJson: { type: 'object' },
    createdAt: Date.now(),
  };
}

function makeReq(): Request {
  return new Request('http://localhost/api/operator/state-snapshot', {
    method: 'GET',
  });
}

/**
 * Open a streaming reader that yields snapshot events as they arrive.
 * The caller controls reading + cleanup; this lets tests interleave
 * reads with state-channel mutations.
 */
function openSseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  async function next(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Drain whatever's already in buf first.
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

  async function close() {
    await reader.cancel().catch(() => {});
  }

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
  });
  afterEach(() => _resetStateChannelForTests());

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('initial dump: streams every currently-open run snapshot on connect', async () => {
    openRun({ workspaceId: ws, runId: 'rA' });
    openRun({ workspaceId: ws, runId: 'rB' });
    setOpenCards('rA', [card('a1')]);
    setOpenCards('rB', [card('b1'), card('b2')]);
    openRun({ workspaceId: 'other-ws', runId: 'rOther' });
    setOpenCards('rOther', [card('o1')]);

    const res = await GET(makeReq());
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

    const res = await GET(makeReq());
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
