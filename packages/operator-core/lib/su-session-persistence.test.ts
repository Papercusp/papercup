import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifySuSessionRuntime,
  isPersistedSuSessionDescriptor,
  suppressDuplicateSuLaunch,
  type DurableSuSessionRecord,
} from './su-session-persistence';

const MIGRATION = readFileSync(
  new URL('../../../libs/papercusp/libs/db/sql/1017-su-session-persistence.sql', import.meta.url),
  'utf8',
);

function record(over: Partial<DurableSuSessionRecord> = {}): DurableSuSessionRecord {
  return {
    advSessionId: 41,
    workspaceId: 'papercusp-workspace',
    agentChatId: 'chat-1',
    backend: 'codex',
    nativeSessionId: 'rollout-1',
    ownerId: 'su-owner',
    harnessSlug: 'papercusp',
    lifecycle: 'ready',
    runtimeGeneration: 1,
    pid: 9001,
    endedAt: null,
    descriptor: null,
    ...over,
  };
}

describe('P-004 durable SU-session persistence', () => {
  it('adds binding, descriptor, lifecycle and generation state to adv_sessions with a unique chat index', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_agent_chat_id text');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_session_descriptor jsonb');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS su_runtime_generation integer');
    expect(MIGRATION).toContain('CREATE UNIQUE INDEX IF NOT EXISTS adv_sessions_su_agent_chat_idx');
  });

  it('accepts only a complete typed descriptor snapshot', () => {
    const valid = {
      identity: {
        agentChatId: 'chat-1', advSessionId: 41, backend: 'codex', nativeSessionId: 'rollout-1',
        ownerId: 'su-owner', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
      },
      lifecycle: 'ready', runtimeGeneration: 1, role: 'su', backendExtension: { backend: 'codex' },
    };
    expect(isPersistedSuSessionDescriptor(valid)).toBe(true);
    expect(isPersistedSuSessionDescriptor({ ...valid, role: 'worker' })).toBe(false);
    expect(isPersistedSuSessionDescriptor({ ...valid, identity: { ...valid.identity, advSessionId: 0 } })).toBe(false);
  });

  it('reattaches a native session even when its recorded pid is stale', () => {
    expect(classifySuSessionRuntime(record(), () => false)).toEqual({
      action: 'reattach', reason: 'runtime_replacement', stalePid: true,
    });
  });

  it('relaunches only when stale pid and native identity are both absent', () => {
    expect(classifySuSessionRuntime(record({ nativeSessionId: null, pid: 9001 }), () => false)).toEqual({
      action: 'relaunch', reason: 'stale_pid_without_native_identity', stalePid: true,
    });
    expect(classifySuSessionRuntime(record({ nativeSessionId: null, pid: null }), () => false)).toEqual({
      action: 'wait', reason: 'pid_unknown', stalePid: false,
    });
  });

  it('uses archive/rematerialize for ended sessions before any relaunch decision', () => {
    expect(classifySuSessionRuntime(record({ endedAt: '2026-08-28T01:00:00Z' }), () => false)).toEqual({
      action: 'rematerialize', reason: 'ended_archived', stalePid: true,
    });
  });

  it('suppresses duplicate active launches by chat or adv identity, but permits ended rows', () => {
    expect(suppressDuplicateSuLaunch(record(), { agentChatId: 'chat-1' })).toBe(true);
    expect(suppressDuplicateSuLaunch(record(), { advSessionId: 41 })).toBe(true);
    expect(suppressDuplicateSuLaunch(record({ endedAt: '2026-08-28T01:00:00Z' }), { agentChatId: 'chat-1' })).toBe(false);
    expect(suppressDuplicateSuLaunch(record({ lifecycle: 'failed' }), { advSessionId: 41 })).toBe(false);
  });
});
