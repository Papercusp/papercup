/**
 * Process kill — the only place that issues `process.kill` to host pids
 * from the operator surface.
 *
 * Defense layers, top to bottom:
 *   1. Principal/capability gate (`processes:kill`, Tier 1) — enforced
 *      by the dispatcher wrapper before this code runs. Bearer-required.
 *      Agents that pass URL spawn ctx (no bearer) cannot reach here.
 *   2. Kind allowlist — only `run.sh | omp | claude`. `paperclip | next
 *      | pty | other` are protected because killing them would break
 *      the user's autopilot or the operator itself.
 *   3. Audit log row written before signaling, so we have a record even
 *      if signaling crashes the process tree somehow.
 */

import { getOrgPg } from '@papercusp/db-org';
import { listProcesses, type ProcessEntry } from './dev-data';

export type KillableKind = 'run.sh' | 'omp' | 'claude';
const KILLABLE: Set<string> = new Set(['run.sh', 'omp', 'claude']);

export interface KillProcessInput {
  pid: number;
  /** 'SIGTERM' (default) or 'SIGKILL'. */
  signal?: 'SIGTERM' | 'SIGKILL';
  /** Actor slug for the audit log row. */
  actorSlug: string;
  workspaceId: string;
}

export interface KillProcessResult {
  ok: boolean;
  pid: number;
  kind?: string;
  signal?: string;
  error?: 'pid_not_found' | 'protected_kind' | 'signal_failed';
  detail?: string;
}

async function writeAudit(
  workspaceId: string,
  actorSlug: string,
  ev: {
    action: string;
    subject: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `kill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, Date.now(), actorSlug, ev.action, ev.subject, JSON.stringify(ev.details), workspaceId],
    );
  } catch (err) {
    // Audit failures must not block the operation, but we should log
    // loudly so they're visible in dev.
     
    console.warn('[processes:kill] audit write failed:', err);
  }
}

export async function killProcess(input: KillProcessInput): Promise<KillProcessResult> {
  const signal = input.signal ?? 'SIGTERM';

  // Re-walk /proc to classify the target. We don't trust the caller's
  // claim about kind — they could send any pid number.
  const { processes } = await listProcesses({});
  const target = processes.find((p: ProcessEntry) => p.pid === input.pid);

  if (!target) {
    await writeAudit(input.workspaceId, input.actorSlug, {
      action: 'processes.kill_rejected',
      subject: String(input.pid),
      details: { reason: 'pid_not_found', signal },
    });
    return { ok: false, pid: input.pid, error: 'pid_not_found' };
  }

  if (!KILLABLE.has(target.kind)) {
    await writeAudit(input.workspaceId, input.actorSlug, {
      action: 'processes.kill_rejected',
      subject: String(input.pid),
      details: {
        reason: 'protected_kind',
        kind: target.kind,
        cmdline_prefix: target.cmdline.slice(0, 80),
      },
    });
    return {
      ok: false,
      pid: input.pid,
      kind: target.kind,
      error: 'protected_kind',
      detail: `kind '${target.kind}' is in the protected list`,
    };
  }

  // Write the audit row BEFORE signaling so we have provenance even if
  // the kill cascades into something that takes us down.
  await writeAudit(input.workspaceId, input.actorSlug, {
    action: 'processes.kill',
    subject: String(input.pid),
    details: {
      signal,
      kind: target.kind,
      cmdline_prefix: target.cmdline.slice(0, 120),
      cwd: target.cwd,
      harness_slug: target.harness_slug,
    },
  });

  try {
    process.kill(input.pid, signal);
    return { ok: true, pid: input.pid, kind: target.kind, signal };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await writeAudit(input.workspaceId, input.actorSlug, {
      action: 'processes.kill_failed',
      subject: String(input.pid),
      details: { signal, kind: target.kind, error: detail },
    });
    return { ok: false, pid: input.pid, kind: target.kind, error: 'signal_failed', detail };
  }
}
