import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import type { TurnBackend } from '@papercusp/papercusp-shared/agent';
import type { AdvSessionRow } from './adv-sessions';
import { interactiveBackendFromSpawnBackend, type InteractiveBackend, type SpawnBackendLike } from './backend-feature-capabilities';

export type NativeSessionSource = 'adv_sessions' | 'spawned_agents';

export interface ClaudeNativeSessionHandle {
  backend: 'claude';
  source: NativeSessionSource;
  ownerId: string | null;
  sessionId: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export interface CodexNativeSessionHandle {
  backend: 'codex';
  source: NativeSessionSource;
  ownerId: string | null;
  codexHome: string;
  rolloutId: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export interface OmpNativeSessionHandle {
  backend: 'omp';
  source: NativeSessionSource;
  ownerId: string | null;
  ompThreadId: string | null;
  agentHome: string | null;
  exactResumeSupported: boolean;
  missingReason: string | null;
}

export type NativeSessionHandle =
  | ClaudeNativeSessionHandle
  | CodexNativeSessionHandle
  | OmpNativeSessionHandle;

export interface NativeSessionDeps {
  codexHomeForSessionKey?: (sessionKey: string | number) => string;
  findCodexRolloutId?: (codexHome: string) => string | null;
  ompAgentHome?: () => string | null;
}

function defaultOmpAgentHome(): string | null {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');
}

export function nativeSessionHandleForAdvSession(
  row: AdvSessionRow,
  deps: NativeSessionDeps = {},
): NativeSessionHandle | null {
  const ownerId = row.coordOwnerId;
  if (row.agent === 'claude') {
    return {
      backend: 'claude',
      source: 'adv_sessions',
      ownerId,
      sessionId: row.sessionId,
      exactResumeSupported: Boolean(row.sessionId),
      missingReason: row.sessionId ? null : 'claude session_id is not recorded',
    };
  }
  if (row.agent === 'codex') {
    const home = (deps.codexHomeForSessionKey ?? codexHomeForSessionKey)(row.id);
    const rolloutId = deps.findCodexRolloutId?.(home) ?? null;
    return {
      backend: 'codex',
      source: 'adv_sessions',
      ownerId,
      codexHome: home,
      rolloutId,
      exactResumeSupported: Boolean(rolloutId),
      missingReason: rolloutId ? null : 'codex rollout id is not recorded under CODEX_HOME yet',
    };
  }
  if (row.agent === 'omp') {
    return {
      backend: 'omp',
      source: 'adv_sessions',
      ownerId,
      ompThreadId: row.ompThreadId,
      agentHome: (deps.ompAgentHome ?? defaultOmpAgentHome)(),
      exactResumeSupported: Boolean(row.ompThreadId),
      missingReason: row.ompThreadId ? null : 'omp thread id is not linked yet',
    };
  }
  return null;
}

export interface SpawnedAgentNativeSessionInput {
  spawnId: string;
  sessionOwner?: string | null;
  backend: TurnBackend | SpawnBackendLike;
  sessionId?: string | null;
  codexHome?: string | null;
  rolloutId?: string | null;
  ompThreadId?: string | null;
  agentHome?: string | null;
}

function normalizeSpawnBackend(backend: TurnBackend | SpawnBackendLike): InteractiveBackend {
  return interactiveBackendFromSpawnBackend(backend === 'anthropic-direct' ? 'anthropic-direct' : backend);
}

export function nativeSessionHandleForSpawnedAgent(
  row: SpawnedAgentNativeSessionInput,
): NativeSessionHandle {
  const ownerId = row.sessionOwner ?? row.spawnId;
  const backend = normalizeSpawnBackend(row.backend);
  if (backend === 'claude') {
    return {
      backend: 'claude',
      source: 'spawned_agents',
      ownerId,
      sessionId: row.sessionId ?? null,
      exactResumeSupported: Boolean(row.sessionId),
      missingReason: row.sessionId ? null : 'spawned Claude agent has no session_id',
    };
  }
  if (backend === 'codex') {
    const codexHome = row.codexHome ?? '';
    return {
      backend: 'codex',
      source: 'spawned_agents',
      ownerId,
      codexHome,
      rolloutId: row.rolloutId ?? null,
      exactResumeSupported: Boolean(codexHome && row.rolloutId),
      missingReason:
        codexHome && row.rolloutId
          ? null
          : 'spawned Codex agent has no durable CODEX_HOME/rollout handle recorded',
    };
  }
  return {
    backend: 'omp',
    source: 'spawned_agents',
    ownerId,
    ompThreadId: row.ompThreadId ?? null,
    agentHome: row.agentHome ?? null,
    exactResumeSupported: Boolean(row.ompThreadId),
    missingReason: row.ompThreadId ? null : 'spawned OMP agent has no thread id recorded',
  };
}
