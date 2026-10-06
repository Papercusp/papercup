/**
 * WI-5071 — per-conversation claude brain session registry.
 *
 * The registry's whole contract is lifecycle: fresh mint → resume after a
 * recorded turn → invalidate on hash drift / caps / explicit invalidation.
 * The marker lives INSIDE the session dir (storage-policy exception: it
 * describes local-disk claude session state and must die with it), so the
 * tests point HOME at a tmpdir and exercise the real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeHome: string;

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => fakeHome };
});

// Import AFTER the mock so the module's homedir() resolves to the tmp HOME.
import {
  brainSessionReuseEligible,
  getChatBrainSession,
  hashSystemPrompt,
  invalidateChatBrainSession,
  recordChatBrainTurn,
} from './converse-session';

const CONV = 'conv-abc-123';
const SYS = 'you are the operator persona v1';

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'converse-session-test-'));
});

afterEach(() => {
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// WI-10006465 — a caller under its own retention policy (phone calls, D-022's
// 30-day rule) must be able to keep its content out of the on-disk session
// store entirely: a one-off conversation's dir is never reclaimed, because a
// dir is only dropped when the SAME conversation takes another turn.
describe('brainSessionReuseEligible', () => {
  it('is eligible for a claude-code conversation when the caller does not opt out', () => {
    expect(brainSessionReuseEligible({ conversationId: CONV, backendIsClaudeCode: true })).toBe(true);
    expect(
      brainSessionReuseEligible({ conversationId: CONV, backendIsClaudeCode: true, retainSession: true }),
    ).toBe(true);
  });

  it('retainSession:false refuses reuse even on claude-code with a conversation', () => {
    expect(
      brainSessionReuseEligible({ conversationId: CONV, backendIsClaudeCode: true, retainSession: false }),
    ).toBe(false);
  });

  it('is never eligible without a conversation or off claude-code', () => {
    expect(brainSessionReuseEligible({ conversationId: null, backendIsClaudeCode: true })).toBe(false);
    expect(brainSessionReuseEligible({ conversationId: '', backendIsClaudeCode: true })).toBe(false);
    expect(brainSessionReuseEligible({ conversationId: CONV, backendIsClaudeCode: false })).toBe(false);
  });

  it('an opted-out turn leaves no session dir behind', () => {
    // The caller contract: when ineligible, getChatBrainSession is never
    // called, so nothing for this conversation exists under chat-brains.
    const phoneConv = 'phone-call:room-xyz';
    if (brainSessionReuseEligible({ conversationId: phoneConv, backendIsClaudeCode: true, retainSession: false })) {
      getChatBrainSession(phoneConv, hashSystemPrompt(SYS));
    }
    expect(existsSync(join(fakeHome, '.papercusp', 'chat-brains'))).toBe(false);
  });
});

describe('getChatBrainSession', () => {
  it('mints a fresh session (resumed:false) on first sight and persists a marker', () => {
    const s = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    expect(s.resumed).toBe(false);
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.dir.startsWith(join(fakeHome, '.papercusp', 'chat-brains'))).toBe(true);
    const marker = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
    expect(marker.sessionId).toBe(s.sessionId);
    expect(marker.turnCount).toBe(0);
  });

  it('does NOT resume until a turn was recorded (a never-completed session stays cold)', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    // No recordChatBrainTurn — the first turn never committed output.
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(false);
    // A fresh uuid: the dead session was discarded, not resurrected.
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('resumes (same uuid, same dir) after a recorded turn', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.dir).toBe(first.dir);
  });

  it('invalidates on system-prompt hash drift', () => {
    const first = getChatBrainSession(CONV, hashSystemPrompt(SYS));
    recordChatBrainTurn(CONV);
    const second = getChatBrainSession(CONV, hashSystemPrompt(SYS + ' EDITED'));
    expect(second.resumed).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('keys different conversations to different dirs/sessions', () => {
    const h = hashSystemPrompt(SYS);
    const a = getChatBrainSession('conv-a', h);
    const b = getChatBrainSession('conv-b', h);
    expect(a.dir).not.toBe(b.dir);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('invalidateChatBrainSession', () => {
  it('drops the dir so the next turn cold-starts', () => {
    const h = hashSystemPrompt(SYS);
    const first = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    invalidateChatBrainSession(CONV, 'test');
    expect(existsSync(first.dir)).toBe(false);
    const second = getChatBrainSession(CONV, h);
    expect(second.resumed).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe('recordChatBrainTurn', () => {
  it('increments turnCount on the marker', () => {
    const h = hashSystemPrompt(SYS);
    const s = getChatBrainSession(CONV, h);
    recordChatBrainTurn(CONV);
    recordChatBrainTurn(CONV);
    const marker = JSON.parse(readFileSync(join(s.dir, 'session.json'), 'utf8'));
    expect(marker.turnCount).toBe(2);
  });

  it('is a no-op with no session on record', () => {
    expect(() => recordChatBrainTurn('never-seen-conv')).not.toThrow();
  });
});
