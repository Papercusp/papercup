/**
 * Agent Action Registry — audit log buffer.
 *
 * See /docs/agents/action-registry §6 for table schemas.
 *
 * The registry calls `audit()` and `auditQuery()` after every command.
 * The buffer is flushed by a registered callback on a 1s timer. Server-
 * side code registers the flush callback at module load (it imports PG);
 * browser-side code never registers one, so audits are silently dropped
 * in the browser. The cross-process `run-command` HTTP endpoint runs
 * server-side and writes its audits — which is the path that matters for
 * delegated / cross-tab commands.
 */

import type { AgentId } from './types';

export interface ActionRow {
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

export interface QueryRow {
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

type FlushFn = (actions: ActionRow[], queries: QueryRow[]) => Promise<void>;
let flushImpl: FlushFn | null = null;

/**
 * Server-side modules call this once at boot to register the PG inserter.
 * Browser-side code never calls this; flushes become no-ops there.
 */
export function registerAuditFlush(fn: FlushFn): void {
  flushImpl = fn;
}

export function audit(row: ActionRow): void {
  actionBuffer.push(row);
  scheduleFlush();
}

export function auditQuery(row: QueryRow): void {
  // Sampling: 1-in-20 with a per-(agent,id) burst-rate cap of 2/sec.
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
  if (!flushImpl) return; // browser side or before server-init
  try {
    await flushImpl(actions, queries);
  } catch (e: unknown) {
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
