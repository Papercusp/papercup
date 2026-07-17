import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import type { TurnBackend } from '@papercusp/papercusp-shared/agent';
import type { AdvSessionRow } from './adv-sessions';
import { interactiveBackendFromSpawnBackend, type InteractiveBackend, type SpawnBackendLike } from './backend-feature-capabilities';

export type NativeSessionSource = 'adv_sessions' | 'spawned_agents';

export interface ClaudeNativeSessionHandle {
  backend: 'claude';
  source: NativeSessionSource;
  ownerId: string | null;
  sessionId: string | null;
  /** The per-session CLAUDE_CONFIG_DIR the transcript lives under
   *  (`~/.papercusp/session-claude/<ownerId>`). A bare `claude --resume
   *  <sessionId>` looks in the DEFAULT config dir and finds nothing — every
   *  attach (dock bee pane, hive tab) must run with CLAUDE_CONFIG_DIR set to
   *  THIS dir, mirroring what the codex handle's `codexHome` already carries.
   *  Null when the owner id (the dir key) is unknown. */
  configDir: string | null;
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
      configDir: ownerId ? sessionClaudeConfigDir(ownerId) : null,
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
      configDir: sessionClaudeConfigDir(ownerId),
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

/**
 * EI-308 gap 2 / WI-5226: an ENDED claude session's transcript is deleted by the
 * archive-at-death hook within ~15s of turn end (independent of session-dir-gc's
 * later whole-dir sweep) — so by the time a human opens the dossier and copies the
 * `claude --resume` command it hands back, the file the command needs is almost
 * always already gone, and the command ENOENTs despite the dossier claiming "exact
 * resume: supported". The async caller (adv-agent-detail.ts) checks the real disk
 * state and best-effort rematerializes from the archive BEFORE trusting the handle;
 * this is the PURE outcome-decision half of that (no I/O), kept separate so it is
 * unit-tested without a real fs/PG.
 *
 * Returns `handle` unchanged when the transcript is present on disk (either it
 * always was, or the rematerialize attempt just restored it); otherwise downgrades
 * `exactResumeSupported` so the UI never hands out a command that will ENOENT.
 */
export function claudeHandleAfterRematerializeAttempt(
  handle: ClaudeNativeSessionHandle,
  opts: { presentOnDisk: boolean; rematerialized: boolean; rematReason?: string },
): ClaudeNativeSessionHandle {
  if (opts.presentOnDisk || opts.rematerialized) return handle;
  return {
    ...handle,
    exactResumeSupported: false,
    missingReason:
      'session transcript was cleaned up and could not be restored' +
      (opts.rematReason ? ` (${opts.rematReason})` : ''),
  };
}
