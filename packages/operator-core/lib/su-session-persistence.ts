/**
 * Durable SU-session binding and runtime reconciliation (P-004).
 *
 * `adv_sessions` is the existing lifecycle ledger and remains the only
 * durable identity store.  This module adds the PUI agent-chat binding and a
 * restart-safe descriptor snapshot to that row.  All decisions are kept pure
 * where possible so stale-pid and duplicate-launch behaviour can be tested
 * without a process or a database.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SuSessionBackend, SuSessionDescriptor, SuSessionLifecycleState } from '@papercusp/chat-protocol';
import { activeWorkspaceId } from './workspace-registry';

export const SU_SESSION_LIFECYCLE_STATES: readonly SuSessionLifecycleState[] = [
  'starting', 'ready', 'running', 'waiting-for-owner', 'resuming',
  'compacting', 'interrupted', 'ended', 'failed',
] as const;

export interface DurableSuSessionRecord {
  advSessionId: number;
  workspaceId: string;
  agentChatId: string | null;
  backend: SuSessionBackend | null;
  nativeSessionId: string | null;
  ownerId: string | null;
  harnessSlug: string | null;
  lifecycle: SuSessionLifecycleState | null;
  runtimeGeneration: number;
  pid: number | null;
  endedAt: string | Date | null;
  descriptor: SuSessionDescriptor | null;
}

export type SuSessionBindingResult =
  | { status: 'bound'; record: DurableSuSessionRecord }
  | { status: 'already_bound'; record: DurableSuSessionRecord }
  | { status: 'not_found' }
  | { status: 'conflict'; reason: 'chat_bound_elsewhere' | 'identity_mismatch' };

export type RuntimeReconciliation =
  | { action: 'reattach'; reason: 'live_pid' | 'native_identity' | 'runtime_replacement'; stalePid: boolean }
  | { action: 'rematerialize'; reason: 'ended_archived'; stalePid: boolean }
  | { action: 'relaunch'; reason: 'stale_pid_without_native_identity'; stalePid: true }
  | { action: 'wait'; reason: 'pid_unknown'; stalePid: false };

function isLifecycle(value: unknown): value is SuSessionLifecycleState {
  return typeof value === 'string' && (SU_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function isBackend(value: unknown): value is SuSessionBackend {
  return value === 'claude' || value === 'codex' || value === 'omp';
}

function safeGeneration(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Strict descriptor validation before a persisted JSON snapshot is trusted. */
export function isPersistedSuSessionDescriptor(value: unknown): value is SuSessionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Partial<SuSessionDescriptor>;
  const identity = descriptor.identity;
  return Boolean(
    identity && typeof identity === 'object' && !Array.isArray(identity) &&
      typeof identity.agentChatId === 'string' && identity.agentChatId.length > 0 &&
      Number.isSafeInteger(identity.advSessionId) && identity.advSessionId > 0 &&
      isBackend(identity.backend) && typeof identity.nativeSessionId === 'string' &&
      typeof identity.ownerId === 'string' && identity.ownerId.length > 0 &&
      typeof identity.workspaceId === 'string' && identity.workspaceId.length > 0 &&
      descriptor.role === 'su' && isLifecycle(descriptor.lifecycle) &&
      typeof descriptor.runtimeGeneration === 'number' &&
      Number.isSafeInteger(descriptor.runtimeGeneration) && descriptor.runtimeGeneration >= 0 &&
      descriptor.backendExtension && typeof descriptor.backendExtension === 'object',
  );
}

function mapRow(row: Record<string, unknown>): DurableSuSessionRecord {
  const descriptor = isPersistedSuSessionDescriptor(row.su_session_descriptor)
    ? row.su_session_descriptor
    : null;
  const identity = descriptor?.identity;
  return {
    advSessionId: Number(row.id),
    workspaceId: String(row.workspace_id ?? ''),
    agentChatId: typeof row.su_agent_chat_id === 'string' ? row.su_agent_chat_id : identity?.agentChatId ?? null,
    backend: isBackend(row.agent) ? row.agent : identity?.backend ?? null,
    nativeSessionId: typeof row.session_id === 'string' ? row.session_id : identity?.nativeSessionId ?? null,
    ownerId: typeof row.coord_owner_id === 'string' ? row.coord_owner_id : identity?.ownerId ?? null,
    harnessSlug: typeof row.harness_slug === 'string' ? row.harness_slug : identity?.harnessSlug ?? null,
    lifecycle: isLifecycle(row.su_session_state) ? row.su_session_state : descriptor?.lifecycle ?? null,
    runtimeGeneration: safeGeneration(row.su_runtime_generation ?? descriptor?.runtimeGeneration),
    pid: typeof row.pid === 'number' ? row.pid : row.pid == null ? null : Number(row.pid),
    endedAt: (row.ended_at as string | Date | null | undefined) ?? null,
    descriptor,
  };
}

const RECORD_COLUMNS = `
  id, workspace_id, agent, session_id, coord_owner_id,
  to_jsonb(a)->>'harness_slug' AS harness_slug,
  pid, ended_at, su_agent_chat_id, su_session_descriptor,
  su_session_state, su_runtime_generation`;

/** Read one binding by its stable adv-session id or agent-chat id. */
export async function readDurableSuSession(input: {
  advSessionId?: number;
  agentChatId?: string;
  workspaceId?: string;
}): Promise<DurableSuSessionRecord | null> {
  if (input.advSessionId == null && !input.agentChatId) return null;
  try {
    const { sql } = getOrgPg();
    const workspaceId = input.workspaceId ?? activeWorkspaceId();
    const rows = await sql<Record<string, unknown>[]>`
      SELECT ${sql.unsafe(RECORD_COLUMNS)}
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${workspaceId}
         AND (
           (${input.advSessionId ?? null}::bigint IS NOT NULL AND id = ${input.advSessionId ?? null})
           OR (${input.agentChatId ?? null}::text IS NOT NULL AND su_agent_chat_id = ${input.agentChatId ?? null})
         )
       ORDER BY started_at DESC
       LIMIT 1`;
    return rows[0] ? mapRow(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Read a descriptor snapshot by chat id, used to rehydrate a host after PUI restart. */
export async function readPersistedSuSessionDescriptor(agentChatId: string, workspaceId = activeWorkspaceId()): Promise<SuSessionDescriptor | null> {
  const record = await readDurableSuSession({ agentChatId, workspaceId });
  return record?.descriptor ?? null;
}

/**
 * Bind one chat to one adv row. The UPDATE predicate and unique index make
 * concurrent duplicate launches converge on one winner; a different chat or
 * row is reported as a conflict rather than silently stealing identity.
 */
export async function bindSuSessionToAdvSession(input: {
  advSessionId: number;
  agentChatId: string;
  descriptor?: SuSessionDescriptor | null;
  workspaceId?: string;
}): Promise<SuSessionBindingResult> {
  if (!Number.isSafeInteger(input.advSessionId) || input.advSessionId <= 0 || !input.agentChatId.trim()) {
    return { status: 'not_found' };
  }
  if (input.descriptor && !isPersistedSuSessionDescriptor(input.descriptor)) {
    return { status: 'conflict', reason: 'identity_mismatch' };
  }
  try {
    const { sql } = getOrgPg();
    const workspaceId = input.workspaceId ?? activeWorkspaceId();
    const descriptorJson = input.descriptor ? JSON.stringify(input.descriptor) : null;
    const rows = await sql<Record<string, unknown>[]>`
      UPDATE harness_shared.adv_sessions
         SET su_agent_chat_id = ${input.agentChatId.trim()},
             su_session_descriptor = COALESCE(${descriptorJson}::jsonb, su_session_descriptor),
             su_session_state = COALESCE(${input.descriptor?.lifecycle ?? null}, su_session_state),
             su_runtime_generation = COALESCE(${input.descriptor?.runtimeGeneration ?? null}, su_runtime_generation),
             su_session_updated_at = now()
       WHERE id = ${input.advSessionId}
         AND workspace_id = ${workspaceId}
         AND (su_agent_chat_id IS NULL OR su_agent_chat_id = ${input.agentChatId.trim()})
       RETURNING ${sql.unsafe(RECORD_COLUMNS)}`;
    if (rows[0]) {
      const record = mapRow(rows[0]);
      return {
        status: record.agentChatId === input.agentChatId.trim() && record.descriptor ? 'already_bound' : 'bound',
        record,
      };
    }
    const existing = await readDurableSuSession({ advSessionId: input.advSessionId, workspaceId });
    if (!existing) return { status: 'not_found' };
    return { status: 'conflict', reason: existing.agentChatId ? 'identity_mismatch' : 'chat_bound_elsewhere' };
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      return { status: 'conflict', reason: 'chat_bound_elsewhere' };
    }
    return { status: 'not_found' };
  }
}

/** Persist the latest descriptor and monotonic runtime generation. */
export async function persistSuSessionDescriptor(
  advSessionId: number,
  descriptor: SuSessionDescriptor,
  workspaceId = activeWorkspaceId(),
): Promise<boolean> {
  if (!isPersistedSuSessionDescriptor(descriptor)) return false;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET su_agent_chat_id = ${descriptor.identity.agentChatId},
             su_session_descriptor = ${JSON.stringify(descriptor)}::jsonb,
             su_session_state = ${descriptor.lifecycle},
             su_runtime_generation = GREATEST(su_runtime_generation, ${descriptor.runtimeGeneration}),
             su_session_updated_at = now()
       WHERE id = ${advSessionId} AND workspace_id = ${workspaceId}
       RETURNING id`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Persist a runtime replacement without changing the durable chat/adv id. */
export async function reconcileSuSessionRuntime(input: {
  advSessionId: number;
  descriptor: SuSessionDescriptor;
  nativeSessionId: string;
  workspaceId?: string;
}): Promise<boolean> {
  if (!input.nativeSessionId || !isPersistedSuSessionDescriptor(input.descriptor)) return false;
  const descriptor = {
    ...input.descriptor,
    runtimeGeneration: input.descriptor.runtimeGeneration + 1,
    identity: { ...input.descriptor.identity, nativeSessionId: input.nativeSessionId },
    lifecycle: 'ready' as const,
  } as SuSessionDescriptor;
  return persistSuSessionDescriptor(input.advSessionId, descriptor, input.workspaceId ?? activeWorkspaceId());
}

/** Pure stale-pid / native-identity decision used by startup reconciliation. */
export function classifySuSessionRuntime(
  record: Pick<DurableSuSessionRecord, 'pid' | 'nativeSessionId' | 'endedAt' | 'lifecycle'>,
  pidAlive: (pid: number) => boolean,
): RuntimeReconciliation {
  const stalePid = record.pid != null && !pidAlive(record.pid);
  if (record.endedAt != null || record.lifecycle === 'ended' || record.lifecycle === 'failed') {
    return { action: 'rematerialize', reason: 'ended_archived', stalePid };
  }
  if (stalePid && !record.nativeSessionId) {
    return { action: 'relaunch', reason: 'stale_pid_without_native_identity', stalePid: true };
  }
  if (record.nativeSessionId) {
    return {
      action: 'reattach',
      reason: stalePid ? 'runtime_replacement' : record.pid != null ? 'live_pid' : 'native_identity',
      stalePid,
    };
  }
  return { action: 'wait', reason: 'pid_unknown', stalePid: false };
}

/** Pure duplicate-launch guard: one active row may own a chat at a time. */
export function suppressDuplicateSuLaunch(
  existing: Pick<DurableSuSessionRecord, 'agentChatId' | 'advSessionId' | 'endedAt' | 'lifecycle'> | null,
  requested: { agentChatId?: string | null; advSessionId?: number | null },
): boolean {
  if (!existing || existing.endedAt != null || existing.lifecycle === 'ended' || existing.lifecycle === 'failed') return false;
  if (requested.agentChatId && existing.agentChatId === requested.agentChatId) return true;
  return requested.advSessionId != null && existing.advSessionId === requested.advSessionId;
}
