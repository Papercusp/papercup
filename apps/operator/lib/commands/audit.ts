/**
 * Agent Action Registry — audit log.
 *
 * See /docs/agents/action-registry §6 for table schemas.
 *
 * Two tables:
 *   - harness_shared.agent_actions  — every command, full args/status/error
 *   - harness_shared.agent_queries  — queries, sampled per-def policy
 *
 * Both writes are batched (1s flush) to avoid hammering PG on bursty
 * agent activity. Failures to insert are logged but never propagate —
 * audit must not break the action.
 */

import type { AgentId } from './types';

interface ActionRow {
  id: string;
  agent: AgentId;
  workspace: string;
  sessionId?: string;
  requestId: string;
  args: unknown;
  status: 'ok' | 'err';
  errorCode?: string;
  durationMs: number;
}

interface QueryRow {
  id: string;
  agent: AgentId;
  workspace: string;
  requestId: string;
  args?: unknown;
  sample: boolean;
}

const actionBuffer: ActionRow[] = [];
const queryBuffer: QueryRow[] = [];

let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 1000;

export function audit(row: ActionRow): void {
  actionBuffer.push(row);
  scheduleFlush();
}

export function auditQuery(row: QueryRow): void {
  // Sampling: 1-in-20 with a per-(agent,id) burst-rate cap of 2/sec.
  // Implemented coarsely — anything that hits the burst cap is dropped.
  if (row.sample) {
    if (Math.random() > 0.05) return;
    const key = `${row.agent}:${row.id}`;
    if (!burstAllow(key)) return;
  }
  queryBuffer.push(row);
  scheduleFlush();
}

const burstWindow = new Map<string, number[]>();
function burstAllow(key: string): boolean {
  const now = Date.now();
  const window = burstWindow.get(key) ?? [];
  // Drop entries older than 1s
  while (window.length && now - window[0] > 1000) window.shift();
  if (window.length >= 2) return false;
  window.push(now);
  burstWindow.set(key, window);
  return true;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush(): Promise<void> {
  const actions = actionBuffer.splice(0, actionBuffer.length);
  const queries = queryBuffer.splice(0, queryBuffer.length);
  if (!actions.length && !queries.length) return;
  try {
    const { writeAuditRows } = await import('./audit-writer');
    await writeAuditRows(actions, queries);
  } catch (e: unknown) {
    // Don't crash the action layer over a logging failure.
    console.warn('[agent-audit] flush failed:', e);
  }
}

/** Test-only: drain the buffers synchronously. */
export function __drainAuditForTests(): { actions: ActionRow[]; queries: QueryRow[] } {
  return {
    actions: actionBuffer.splice(0, actionBuffer.length),
    queries: queryBuffer.splice(0, queryBuffer.length),
  };
}
