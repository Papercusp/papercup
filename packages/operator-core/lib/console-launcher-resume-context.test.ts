// @vitest-environment node
/**
 * console-launcher resume launch-context (WI-3988/WI-3989, owner-hit 2026-07-11).
 *
 * `claude -r <id>` reported "No conversation found with session ID" and exited 1
 * because papercusp runs each claude agent in a per-session ISOLATION home
 * (~/.papercusp/session-claude/<owner>) and the move-inactive-sessions-to-PG
 * lifecycle archives+deletes the on-disk jsonl — but the resume envelope set
 * neither CLAUDE_CONFIG_DIR nor the original cwd, and never rematerialized. These
 * tests pin that a claude resume now: (1) sets CLAUDE_CONFIG_DIR to the session's
 * isolation home, (2) lands in the session's original cwd, (3) rematerializes the
 * archived transcript from PG first — and that a miss degrades to a bare -r.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve a row for the "found" session ids; [] for the "missing" one — so both
// the happy path and the graceful-fallback path are exercised from one mock.
vi.mock('./adv-sessions', () => ({
  advSessionsByTranscriptHandles: vi.fn(async ({ sessionIds }: { sessionIds?: string[] }) =>
    sessionIds?.[0] === 'ffffffff-0000-0000-0000-000000000000'
      ? []
      : [{ coordOwnerId: 'su-owner-1', cwd: process.cwd() }],
  ),
}));
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({
  sessionClaudeConfigDir: (owner: string) => `/tmp/session-claude/${owner}`,
}));
vi.mock('./session-archive', () => ({
  pgSessionArchiveStore: () => ({}),
  rematerializeSession: vi.fn(async () => ({ ok: false, reason: 'not_archived' })),
}));

import { buildConsoleEnvelope } from './console-launcher';

const BASE = { workspaceId: 'default', slug: null, operatorBaseUrl: 'http://localhost:3070', skipMcpJson: true } as const;

describe('buildConsoleEnvelope resume launch-context (WI-3988/WI-3989)', () => {
  beforeEach(() => { process.env.AGENT_CMD = 'claude'; delete process.env.AGENT_BACKEND; });
  afterEach(() => { delete process.env.AGENT_CMD; vi.clearAllMocks(); });

  it('points a claude resume at the session isolation home + original cwd so `-r` finds the conversation', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8' });
    expect(env.env.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude/su-owner-1');
    expect(env.cwd).toBe(process.cwd());
    expect(env.greetingCmd).toContain('-r 3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8');
  });

  it('rematerializes the archived session from PG before resuming', async () => {
    const { rematerializeSession } = await import('./session-archive');
    await buildConsoleEnvelope({ ...BASE, resumeSessionId: 'baa78575-0d5b-462c-864f-2aa0b64acfea' });
    expect(rematerializeSession).toHaveBeenCalledWith(
      { sourceKind: 'claude', sessionId: 'baa78575-0d5b-462c-864f-2aa0b64acfea' },
      expect.anything(),
    );
  });

  it('a fork still branches (--fork-session) AND points at the isolation home', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: '7a3f6064-4904-4c00-ab63-33a72e6c419d', fork: true });
    expect(env.env.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude/su-owner-1');
    expect(env.greetingCmd).toContain('--fork-session');
  });

  it('degrades to a bare -r (no CLAUDE_CONFIG_DIR) when the session has no adv row', async () => {
    const env = await buildConsoleEnvelope({ ...BASE, resumeSessionId: 'ffffffff-0000-0000-0000-000000000000' });
    expect(env.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.greetingCmd).toContain('-r ffffffff-0000-0000-0000-000000000000');
  });
});
