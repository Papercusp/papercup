/**
 * Coverage for console-launcher.shellSafeId — the allowlist guard for session
 * ids embedded in a shell greeting. Accepts only the randomUUID alphabet
 * [0-9a-f-]; throws (rather than escaping) on anything else.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { shellSafeId, buildSuperuserMcpUrl, buildConsoleEnvelope } from './console-launcher';

describe('shellSafeId', () => {
  it('accepts a UUID-shaped id', () => {
    const id = '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8';
    expect(shellSafeId(id)).toBe(id);
  });

  it('accepts the hex+dash alphabet case-insensitively', () => {
    expect(shellSafeId('ABCDEF-012345')).toBe('ABCDEF-012345');
  });

  it.each([
    ['has a space', 'abc def'],
    ['shell metachars', 'abc; rm -rf /'],
    ['command substitution', '$(whoami)'],
    ['out-of-alphabet letter', 'deadbeefz'],
    ['empty', ''],
  ])('throws on %s', (_label, bad) => {
    expect(() => shellSafeId(bad)).toThrow(/unsafe session id/);
  });
});

describe('buildSuperuserMcpUrl (scoped-superuser-workspace-clamp D-004)', () => {
  it('scoped-by-default: bakes the concrete workspace so the dispatch clamp confines the session', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test'));
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('workspace')).toBe('generic-test');
  });

  it('allWorkspaces: bakes the UNSCOPED wildcard (the only door past the clamp)', () => {
    const url = new URL(buildSuperuserMcpUrl('http://localhost:3070', 'generic-test', true));
    expect(url.searchParams.get('workspace')).toBe('*');
  });
});

describe('buildConsoleEnvelope resume greeting permission posture (owner-hit 2026-07-07)', () => {
  const ORIGINAL_AGENT_CMD = process.env.AGENT_CMD;
  const ORIGINAL_CLAUDE_CMD = process.env.CLAUDE_CMD;
  const ORIGINAL_BACKEND = process.env.AGENT_BACKEND;
  afterEach(() => {
    if (ORIGINAL_AGENT_CMD === undefined) delete process.env.AGENT_CMD;
    else process.env.AGENT_CMD = ORIGINAL_AGENT_CMD;
    if (ORIGINAL_CLAUDE_CMD === undefined) delete process.env.CLAUDE_CMD;
    else process.env.CLAUDE_CMD = ORIGINAL_CLAUDE_CMD;
    if (ORIGINAL_BACKEND === undefined) delete process.env.AGENT_BACKEND;
    else process.env.AGENT_BACKEND = ORIGINAL_BACKEND;
  });

  it('claude resume routes through psu — psu carries the auth-correct bypass posture (WI-4159, owner-hit 2026-07-11)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    // A bare `claude -r` under the session's isolated CLAUDE_CONFIG_DIR prompts
    // /login (the isolation dir has the credential symlink but not ~/.claude.json
    // account state) — psu's own resume path does the credential relocation that
    // makes it authenticated, so the greeting routes through psu instead.
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
    );
  });

  it('omp resume carries --approval-mode yolo', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: 'abc-123',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain('exec omp --approval-mode yolo -r abc-123');
  });

  // WI-3882: forking a LIVE session must branch into a fresh session id rather
  // than resume in place (a second CLI on the same transcript collides with the
  // still-running original). Since WI-4159 the claude path routes through psu,
  // which takes `--fork` (not claude's own `--fork-session`) to branch.
  it('claude fork appends --fork via psu and says "forking"', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      fork: true,
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).toContain(
      'exec psu --resume=3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8 --fork',
    );
    expect(envelope.greetingCmd).toContain('forking plan-run');
  });

  it('claude resume WITHOUT fork never emits --fork-session (guard against a stray branch)', async () => {
    process.env.AGENT_CMD = 'claude';
    delete process.env.AGENT_BACKEND;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      resumeSessionId: '3f2a1b6c-9d8e-4f0a-b1c2-d3e4f5a6b7c8',
      skipMcpJson: true,
    });
    expect(envelope.greetingCmd).not.toContain('--fork-session');
    expect(envelope.greetingCmd).toContain('resuming plan-run');
  });

  it('omp fork is refused (no native branch command) instead of colliding via a plain resume', async () => {
    process.env.AGENT_CMD = 'omp';
    delete process.env.AGENT_BACKEND;
    await expect(
      buildConsoleEnvelope({
        workspaceId: 'default',
        slug: null,
        operatorBaseUrl: 'http://localhost:3070',
        resumeSessionId: 'abc-123',
        fork: true,
        skipMcpJson: true,
      }),
    ).rejects.toThrow(/only claude sessions support --fork-session/);
  });
});

describe('buildConsoleEnvelope PAPERCUSP_OPERATOR_URL (WI-1773 follow-up)', () => {
  const ORIGINAL = process.env.PAPERCUSP_MCP_PROXY_BASE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    else process.env.PAPERCUSP_MCP_PROXY_BASE = ORIGINAL;
  });

  it('bakes the raw operator base into the child env when no proxy is configured', async () => {
    delete process.env.PAPERCUSP_MCP_PROXY_BASE;
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3070');
  });

  it('routes the child env through the resilient proxy when PAPERCUSP_MCP_PROXY_BASE is set — a console/fleet/capability:terminal launch must NOT permanently pin :3070 past a spawned session (the exact WI-1773 regression: an inherited PAPERCUSP_OPERATOR_URL override silently disables psu-launcher\'s proxy-first default)', async () => {
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    const envelope = await buildConsoleEnvelope({
      workspaceId: 'default',
      slug: null,
      operatorBaseUrl: 'http://localhost:3070',
      runCommand: 'true',
      skipMcpJson: true,
    });
    expect(envelope.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9071');
  });
});
