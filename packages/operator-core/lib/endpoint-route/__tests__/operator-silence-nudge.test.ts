/**
 * Tests for POST /silence-nudge — silence-nudge-reliability-2026-05-14.md Phase 1.
 * Drives via Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser } from '../../auth';
import {
  _resetCardCorrelatorForTests,
  _resetStateChannelForTests,
  subscribeWorkspace,
} from '@papercusp/agent-mcp';
import { _resetCardResponseRateLimitForTests } from '../../card-response-rate-limit';
import { registerAllRoutes } from '../register';

const ws = 'workspace-T';
const fakeUser = { id: 'u1', username: 'alice', display_name: 'Alice', has_password: true };
let app: Hono;

function post(body: unknown) {
  return app.request('/api/operator/conversations/c1/silence-nudge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /silence-nudge', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue(fakeUser);
    app = new Hono().basePath('/api');
    registerAllRoutes(app);
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post({ workspaceId: ws, voiceActive: false });
    expect(res.status).toBe(401);
  });

  it('400 when workspaceId missing', async () => {
    expect((await post({ voiceActive: true })).status).toBe(400);
  });

  it('400 when voiceActive is not a boolean', async () => {
    expect((await post({ workspaceId: ws, voiceActive: 'yes' })).status).toBe(400);
  });

  it('200 returns correlationId + runId', async () => {
    const res = await post({ workspaceId: ws, voiceActive: false });
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
      await post({ workspaceId: ws, voiceActive: true, wakeword: 'hey papercup' });
      expect(received.length).toBeGreaterThan(0);
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ correlationId: string; fallbackText?: string; presentation?: { kind: string; voiceAnswerable?: boolean } }> } };
      expect(last.snapshot.openCards.length).toBe(1);
      const card = last.snapshot.openCards[0];
      expect(card.presentation?.kind).toBe('radio');
      expect(card.presentation?.voiceAnswerable).toBe(true);
      expect(card.fallbackText).toBe("When you're ready, click Ready or say hey papercup.");
    } finally { unsub(); }
  });

  it('voice off → fallbackText is the click-only variant', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await post({ workspaceId: ws, voiceActive: false });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ fallbackText?: string }> } };
      expect(last.snapshot.openCards[0].fallbackText).toBe('Click Ready when you want to continue.');
    } finally { unsub(); }
  });

  it('voice on without wakeword → generic "say ready"', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await post({ workspaceId: ws, voiceActive: true });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ fallbackText?: string }> } };
      expect(last.snapshot.openCards[0].fallbackText).toBe("When you're ready, click Ready or say ready.");
    } finally { unsub(); }
  });

  it('Ready card has exactly one radio option with id "ready"', async () => {
    const received: unknown[] = [];
    const unsub = subscribeWorkspace(ws, (env) => { received.push(env); });
    try {
      await post({ workspaceId: ws, voiceActive: false });
      const last = received[received.length - 1] as { snapshot: { openCards: Array<{ presentation?: { kind: string; options?: Array<{ id: string; label: string }> } }> } };
      const card = last.snapshot.openCards[0];
      expect(card.presentation?.options).toEqual([{ id: 'ready', label: 'Ready' }]);
    } finally { unsub(); }
  });
});
