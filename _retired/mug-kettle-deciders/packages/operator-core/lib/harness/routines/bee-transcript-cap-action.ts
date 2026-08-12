/**
 * `system:bee-transcript-cap` — the bee-context-efficiency Phase-4 backstop sweep
 * (P-013, D-007). Design + the pure decision/sweep live in
 * `../../hive/bee-transcript-cap.ts`.
 *
 * Per tick: gather live cups + their transcript metrics, flag the ones over the cap
 * (too many carried tasks / too large a per-turn carry / a ballooned on-disk
 * transcript), and — when ARMED — recycle each over-cap IDLE cup with a graceful
 * checkpoint-and-recycle nudge so its NEXT task starts fresh (the keystone P-005 fork
 * then spawns it fresh; the work-item checkpoint carries continuity, D-002). A cup
 * mid-task is never touched (D-005). The over-cap cohort is LOGGED every tick for
 * visibility, even flag-off / dry-run.
 *
 * DOUBLE-GATED (idle-session-reaper precedent): FLAGS.CUP_TRANSCRIPT_CAP default-OFF
 * AND the routine seeded INACTIVE; `dry_run` previews the cohort without nudging.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import {
  runCupTranscriptCapSweep,
  type CupTranscriptCaps,
  type CupTranscriptMetrics,
} from '../../pot/cup-transcript-cap';

/** Fail-soft on-disk transcript size: count JSONL entries in the cup's session file
 *  (`<sessionClaudeConfigDir(owner)>/projects/**\/<sessionId>.jsonl`). 0 on any miss —
 *  so an unreadable transcript can never falsely trip a recycle (D-011 read path). */
function transcriptEntryCount(ownerId: string, sessionId: string | null): number {
  if (!sessionId) return 0;
  try {
    const root = join(sessionClaudeConfigDir(ownerId), 'projects');
    if (!existsSync(root)) return 0;
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const file = join(root, proj.name, `${sessionId}.jsonl`);
      if (!existsSync(file)) continue;
      // Cheap-ish: a session JSONL is one entry per line; count newlines.
      if (statSync(file).size === 0) return 0;
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    }
  } catch {
    /* fail-soft */
  }
  return 0;
}

/** Production metric gather: live cup rows (spawned_agents) × presence (idle) × the
 *  per-session carry (cup-wake-efficiency) × the on-disk transcript size. Fail-soft. */
async function listCupsProd(workspaceId: string): Promise<CupTranscriptMetrics[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{ spawn_id: string; session_id: string | null; harness_slug: string | null }[]>`
    SELECT spawn_id, session_id, harness_slug
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = 'cup'
       AND status IN ('running', 'restarting')`;

  // Idle signal: a cup parked on an inbox-wake (awaitingEvent) is drained/between-tasks.
  const { listPresence } = await import('../../agent-tools/coordination/presence');
  const presence = await listPresence({ workspaceId }).catch(() => []);
  const idleByOwner = new Map<string, boolean>();
  for (const p of presence as { ownerId?: string; awaitingEvent?: boolean }[]) {
    if (p.ownerId) idleByOwner.set(p.ownerId, p.awaitingEvent === true);
  }

  // Per-session carry (best-effort): the warm-inject task count + peak carried tokens.
  const { cupWakeEfficiency } = await import('../../pot/cup-wake-efficiency');
  const eff = await cupWakeEfficiency(workspaceId).catch(() => null);
  const bySession = new Map<string, { tasks: number; carried: number }>();
  for (const s of eff?.perSession ?? []) {
    bySession.set(s.sessionId, { tasks: s.wakes.length, carried: s.peakCacheReadTokens });
  }

  return rows.map((r) => {
    const carry = r.session_id ? bySession.get(r.session_id) : undefined;
    return {
      ownerId: r.spawn_id,
      sessionId: r.session_id,
      harness: r.harness_slug,
      // Default to NOT idle (safe — a cup absent from presence is never recycled, D-005).
      idle: idleByOwner.get(r.spawn_id) === true,
      tasks: carry?.tasks ?? 0,
      carriedReadTokens: carry?.carried ?? 0,
      transcriptEntries: transcriptEntryCount(r.spawn_id, r.session_id),
    };
  });
}

/** Recycle = a graceful checkpoint-and-recycle nudge (inject, never wake). The cup
 *  (taught by cup.md, P-012) writes its work_items:checkpoint and ends its turn; its
 *  next warm-inject then spawns FRESH (P-005). Safe + non-destructive (D-005). */
async function nudgeRecycle(workspaceId: string, m: CupTranscriptMetrics): Promise<void> {
  const { sendMessage } = await import('../../agent-tools/coordination/messages');
  await sendMessage(
    { ownerId: 'system:bee-transcript-cap', workspaceId } as never,
    {
      to: [m.ownerId],
      summary: 'transcript over cap — checkpoint + recycle',
      body:
        'Your session transcript has grown past the bee-transcript-cap backstop (P-013). At your ' +
        'next clean boundary: write your `work_items:checkpoint`, then end your turn / stand idle. ' +
        'Your next task will spawn FRESH (no transcript carry); the checkpoint is your continuity.',
    },
  );
}

registerSystemAction('bee-transcript-cap', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const caps: Partial<CupTranscriptCaps> = {};
  if (typeof cfg.max_tasks === 'number') caps.maxTasks = cfg.max_tasks;
  if (typeof cfg.max_carried_read_tokens === 'number') caps.maxCarriedReadTokens = cfg.max_carried_read_tokens;
  if (typeof cfg.max_transcript_entries === 'number') caps.maxTranscriptEntries = cfg.max_transcript_entries;

  const report = await runCupTranscriptCapSweep({
    dryRun,
    caps,
    deps: {
      listCups: () => listCupsProd(ctx.workspaceId),
      recycle: (m) => nudgeRecycle(ctx.workspaceId, m),
    },
    log: (m) => console.log(`[bee-transcript-cap] ${m}`),
  });

  console.log(
    `[bee-transcript-cap] scanned ${report.scanned} live cup(s) → ${report.overCap} over-cap` +
      (report.targets.length
        ? ` [${report.targets.slice(0, 20).map((t) => `${t.ownerId}(${t.reason})`).join(', ')}${report.targets.length > 20 ? ',…' : ''}]`
        : '') +
      (report.enabled
        ? ` → ${report.dryRun ? 'WOULD recycle' : 'recycled'} ${report.recycled}, failed ${report.failed}`
        : ' — flag OFF (papercusp-bee-transcript-cap): cohort logged, recycled nothing'),
  );
});
