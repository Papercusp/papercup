/**
 * Tests for POST /api/operator/conversations/:id/silence-nudge.
 *
 * Plan: silence-nudge-reliability-2026-05-14.md Phase 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from '@/lib/auth';
import {
  _resetCardCorrelatorForTests,
  _resetStateChannelForTests,
  subscribeWorkspace,
} from '@papercusp/agent-mcp';

import { POST } from './route';
import { _resetCardResponseRateLimitForTests } from '@/lib/card-response-rate-limit';

const ws = 'workspace-T';

function makeReq(body: unknown): import('next/server').NextRequest {
  return new Request('http://localhost/api/operator/conversations/c1/silence-nudge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

const fakeUser = {
  id: 'u1',
  username: 'alice',
  display_name: 'Alice',
  has_password: true,
};

describe('POST /silence-nudge', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue(fakeUser);
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await POST(makeReq({ workspaceId: ws, voiceActive: false }), { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(401);
  });

  it('400 when workspaceId missing', async () => {
    const res = await POST(makeReq({ voiceActive: true }), { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(400);
  });

  it('400 when voiceActive is not a boolean', async () => {
    const res = await POST(makeReq({ workspaceId: ws, voiceActive: 'yes' }), { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(400);
  });

  it('200 returns correlationId + runId', async () => {
    const res = await POST(makeReq({ workspaceId: ws, voiceActive: false }), { params: Promise.resolve({ id: 'c1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(typeof body.runId).toBe('string');
    expect(body.runId.startsWith('silence-nudge-')).toBe(true);
  });

  it('card lands on the workspace state-channel', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await POST(makeReq({ workspaceId: ws, voiceActive: true, wakeword: 'hey papercup' }), { params: Promise.resolve({ id: 'c1' }) });
      // The synchronous registerCard call inside the handler republishes
      // the snapshot — subscriber should have received at least one envelope.
      expect(received.length).toBeGreaterThan(0);
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ correlationId: string; fallbackText?: string; presentation?: { kind: string; voiceAnswerable?: boolean } }> } };
      expect(last.snapshot.openCards.length).toBe(1);
      const card = last.snapshot.openCards[0];
      expect(card.presentation?.kind).toBe('radio');
      expect(card.presentation?.voiceAnswerable).toBe(true);
      expect(card.fallbackText).toBe("When you're ready, click Ready or say hey papercup.");
    } finally {
      unsub();
    }
  });

  it('voice off → fallbackText is the click-only variant', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await POST(makeReq({ workspaceId: ws, voiceActive: false }), { params: Promise.resolve({ id: 'c1' }) });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ fallbackText?: string }> } };
      expect(last.snapshot.openCards[0].fallbackText).toBe('Click Ready when you want to continue.');
    } finally {
      unsub();
    }
  });

  it('voice on without wakeword → generic "say ready"', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await POST(makeReq({ workspaceId: ws, voiceActive: true }), { params: Promise.resolve({ id: 'c1' }) });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ fallbackText?: string }> } };
      expect(last.snapshot.openCards[0].fallbackText).toBe("When you're ready, click Ready or say ready.");
    } finally {
      unsub();
    }
  });

  it('Ready card has exactly one radio option with id "ready"', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await POST(makeReq({ workspaceId: ws, voiceActive: false }), { params: Promise.resolve({ id: 'c1' }) });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ presentation?: { kind: string; options?: Array<{ id: string; label: string }> } }> } };
      const card = last.snapshot.openCards[0];
      expect(card.presentation?.options).toEqual([{ id: 'ready', label: 'Ready' }]);
    } finally {
      unsub();
    }
  });
});
