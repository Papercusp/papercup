/**
 * Per-workspace operator-scanner Claude-session id.
 *
 * Phase 3 of the scanner-role plan: every scan resumes the same
 * `claude --session-id <uuid>` session so the model has continuity
 * between scans. Without this, every scan re-derives the workspace
 * from scratch (slower, can't say "since the last scan…", redundant
 * tool calls).
 *
 * Persisted in `harness_shared.operator_scanner_session` (PG, migration
 * 021). Was previously
 * `~/.papercusp-workspaces/<ws>/.papercusp/system/operator/scanner-session.json`.
 *
 * Server-only. Gated behind `OPERATOR_SCANNER_RESUME=1` env until
 * Phase 3 stabilizes.
 */
import { randomUUID } from 'node:crypto';

import { readOperatorState, writeOperatorState } from './operator-state-pg';

interface SessionFile {
  /** UUID4 passed to claude as --session-id. */
  agentSessionId: string;
  /** ISO timestamp of the most recent scan that used this session. */
  lastUsedAt: string;
  /** Total scans the session has accumulated (informational). */
  scanCount: number;
}

/** True if Phase 3 (persistent session + state bootstrap) is enabled. */
export function isScannerResumeEnabled(): boolean {
  return process.env.OPERATOR_SCANNER_RESUME === '1';
}

/**
 * Read the workspace's scanner session id, creating one if missing.
 * Returns the id; the caller passes it to runAgentChat with
 * sessionMode:'force' (create-or-resume).
 */
export async function getOrCreateScannerSessionId(): Promise<string> {
  const raw = await readOperatorState<Partial<SessionFile>>('operator_scanner_session');
  if (raw?.agentSessionId && /^[0-9a-f-]{8,}$/i.test(raw.agentSessionId)) {
    return raw.agentSessionId;
  }
  const id = randomUUID();
  await writeOperatorState<SessionFile>('operator_scanner_session', {
    agentSessionId: id,
    lastUsedAt: new Date().toISOString(),
    scanCount: 0,
  });
  return id;
}

/** Bump the scan counter + lastUsedAt after a scan completes. */
export async function bumpScannerSession(): Promise<void> {
  const raw = await readOperatorState<Partial<SessionFile>>('operator_scanner_session');
  if (!raw?.agentSessionId) return;
  await writeOperatorState<SessionFile>('operator_scanner_session', {
    agentSessionId: raw.agentSessionId,
    lastUsedAt: new Date().toISOString(),
    scanCount: (raw.scanCount ?? 0) + 1,
  });
}

/**
 * Reset the scanner session — start fresh on the next scan. Useful
 * after a major workspace change (new harness scaffolded, big
 * directive batch dispatched) where prior context is more confusing
 * than helpful. Exposed via /api/agent-mcp/operator-scanner-reset
 * so the user can flush from /settings/operator.
 */
export async function resetScannerSession(): Promise<void> {
  await writeOperatorState<SessionFile>('operator_scanner_session', {
    agentSessionId: randomUUID(),
    lastUsedAt: new Date().toISOString(),
    scanCount: 0,
  });
}
