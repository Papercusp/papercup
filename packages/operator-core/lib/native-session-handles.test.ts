import { describe, expect, it } from 'vitest';
import type { AdvSessionRow } from './adv-sessions';
import {
  nativeSessionHandleForAdvSession,
  nativeSessionHandleForSpawnedAgent,
} from './native-session-handles';

const adv = (overrides: Partial<AdvSessionRow> = {}): AdvSessionRow => ({
  id: 42,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console',
  terminalBin: null,
  pid: null,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-1',
  sessionId: null,
  display: null,
  launchArgv: null,
  launchedAt: null,
  startedAt: '2026-06-22T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  ...overrides,
});

describe('nativeSessionHandleForAdvSession', () => {
  it('normalizes a Claude adv_session forced native session id', () => {
    expect(nativeSessionHandleForAdvSession(adv({ sessionId: 'claude-session' }))).toEqual({
      backend: 'claude',
      source: 'adv_sessions',
      ownerId: 'su-1',
      sessionId: 'claude-session',
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  it('normalizes a Codex adv_session to CODEX_HOME plus latest rollout id', () => {
    expect(
      nativeSessionHandleForAdvSession(
        adv({ agent: 'codex', sessionId: null }),
        {
          codexHomeForSessionKey: (key) => `/codex/session-${key}`,
          findCodexRolloutId: (home) => home === '/codex/session-42' ? 'rollout-42' : null,
        },
      ),
    ).toEqual({
      backend: 'codex',
      source: 'adv_sessions',
      ownerId: 'su-1',
      codexHome: '/codex/session-42',
      rolloutId: 'rollout-42',
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  it('normalizes an unlinked OMP adv_session with an explicit missing reason', () => {
    expect(
      nativeSessionHandleForAdvSession(
        adv({ agent: 'omp', ompThreadId: null }),
        { ompAgentHome: () => '/omp/agent' },
      ),
    ).toEqual({
      backend: 'omp',
      source: 'adv_sessions',
      ownerId: 'su-1',
      ompThreadId: null,
      agentHome: '/omp/agent',
      exactResumeSupported: false,
      missingReason: 'omp thread id is not linked yet',
    });
  });
});

describe('nativeSessionHandleForSpawnedAgent', () => {
  it('normalizes a spawned Claude session id', () => {
    expect(
      nativeSessionHandleForSpawnedAgent({
        spawnId: 's-1',
        sessionOwner: 'owner-1',
        backend: 'claude-code',
        sessionId: 'claude-spawn-session',
      }),
    ).toEqual({
      backend: 'claude',
      source: 'spawned_agents',
      ownerId: 'owner-1',
      sessionId: 'claude-spawn-session',
      exactResumeSupported: true,
      missingReason: null,
    });
  });

  it('makes missing spawned Codex durable handles explicit', () => {
    expect(
      nativeSessionHandleForSpawnedAgent({
        spawnId: 's-codex',
        backend: 'codex',
      }),
    ).toEqual({
      backend: 'codex',
      source: 'spawned_agents',
      ownerId: 's-codex',
      codexHome: '',
      rolloutId: null,
      exactResumeSupported: false,
      missingReason: 'spawned Codex agent has no durable CODEX_HOME/rollout handle recorded',
    });
  });

  it('normalizes a spawned OMP thread handle', () => {
    expect(
      nativeSessionHandleForSpawnedAgent({
        spawnId: 's-omp',
        backend: 'omp',
        ompThreadId: 'omp-thread',
        agentHome: '/omp/agent',
      }),
    ).toEqual({
      backend: 'omp',
      source: 'spawned_agents',
      ownerId: 's-omp',
      ompThreadId: 'omp-thread',
      agentHome: '/omp/agent',
      exactResumeSupported: true,
      missingReason: null,
    });
  });
});
