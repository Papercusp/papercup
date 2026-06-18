/**
 * bee-transcript-cap — the bee-context-efficiency Phase-4 BACKSTOP (P-013, D-007).
 *
 * The keystone (P-005 fresh-context warm-inject) already drops the cross-task carry:
 * each NEW task a drained bee is warm-injected starts from a fresh session (no prior
 * transcript). This is the GUARDRAIL behind it: a cadence sweep that recycles a bee
 * whose session has nonetheless grown past a cap — too many carried tasks (e.g. the
 * P-005 flag is off, or a long chain) or too large a per-turn token-span (the
 * ~138K/turn carry, D-011) or a raw on-disk transcript that has ballooned. Recycling =
 * force a FRESH spawn for the bee's next task (the work-item CHECKPOINT carries
 * continuity, D-002 — so "checkpoint first" is satisfied by the bee's task-boundary
 * checkpoint, P-012).
 *
 * D-005 SAFETY: only ever recycles an IDLE / drained bee (between tasks). A bee mid-task
 * is its live working state — never touched. The sweep also LOGS the over-cap cohort
 * regardless of the flag (visibility), and recycles only when armed.
 *
 * DOUBLE-GATED (like idle-session-reaper): FLAGS.BEE_TRANSCRIPT_CAP default-OFF AND the
 * routine is seeded INACTIVE; a `dry_run` knob previews the cohort without recycling.
 * Pure decision + injectable IO ⇒ unit-tests with no DB / no flag store.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

export interface BeeTranscriptCaps {
  /** Max warm-inject TASKS carried on one bee session before a forced recycle. */
  maxTasks: number;
  /** Max single-turn carried-context tokens — the ~138K/turn carry signal (D-011). */
  maxCarriedReadTokens: number;
  /** Max on-disk transcript ENTRIES (JSONL lines) — the raw transcript-size backstop
   *  (D-011: a 177-assistant-turn bee ≈ several hundred entries). */
  maxTranscriptEntries: number;
}

/** Conservative defaults — a pathological session, not a normal one (D-011 peak was
 *  ~165K carried/turn over 177 turns). Editable via the routine trigger_config. */
export const DEFAULT_BEE_TRANSCRIPT_CAPS: BeeTranscriptCaps = {
  maxTasks: 8,
  maxCarriedReadTokens: 250_000,
  maxTranscriptEntries: 600,
};

export interface BeeTranscriptMetrics {
  ownerId: string;
  sessionId: string | null;
  harness: string | null;
  /** true ⇒ the bee is idle/drained between tasks (safe to recycle); false ⇒ mid-task
   *  (D-005 — never recycle live working state). */
  idle: boolean;
  /** Warm-inject wakes carried on this session (proxy: tasks before a fresh spawn). */
  tasks: number;
  /** The carried-context token signal (peak/last single-turn cache_read). */
  carriedReadTokens: number;
  /** On-disk transcript entry (JSONL line) count — 0 when unreadable (fail-soft). */
  transcriptEntries: number;
}

export interface RecycleDecision {
  recycle: boolean;
  /** Null when not recycling; else the cap that tripped (for the audit log). */
  reason: string | null;
}

/**
 * PURE: decide whether an idle bee's session is over a transcript cap. Mid-task bees
 * are NEVER recycled (D-005). Any one cap tripping is sufficient.
 */
export function shouldRecycleBeeTranscript(
  m: BeeTranscriptMetrics,
  caps: BeeTranscriptCaps = DEFAULT_BEE_TRANSCRIPT_CAPS,
): RecycleDecision {
  if (!m.idle) return { recycle: false, reason: null }; // D-005: never mid-task
  if (m.tasks >= caps.maxTasks) return { recycle: true, reason: `tasks ${m.tasks} ≥ ${caps.maxTasks}` };
  if (m.carriedReadTokens >= caps.maxCarriedReadTokens)
    return { recycle: true, reason: `carriedReadTokens ${m.carriedReadTokens} ≥ ${caps.maxCarriedReadTokens}` };
  if (m.transcriptEntries >= caps.maxTranscriptEntries)
    return { recycle: true, reason: `transcriptEntries ${m.transcriptEntries} ≥ ${caps.maxTranscriptEntries}` };
  return { recycle: false, reason: null };
}

/** The IO the sweep orchestrates — injected so the sweep unit-tests with no DB. */
export interface BeeTranscriptCapDeps {
  /** Live bee sessions with their transcript metrics (idle flag included). */
  listBees: () => Promise<BeeTranscriptMetrics[]>;
  /** Recycle an over-cap idle bee: end its drained session so its NEXT placement is a
   *  fresh spawn (the work-item checkpoint carries continuity). */
  recycle: (m: BeeTranscriptMetrics) => Promise<void>;
}

export interface BeeTranscriptCapReport {
  /** FLAGS.BEE_TRANSCRIPT_CAP resolved — false ⇒ a no-op (cohort logged, nothing recycled). */
  enabled: boolean;
  dryRun: boolean;
  scanned: number;
  overCap: number;
  recycled: number;
  failed: number;
  /** The over-cap cohort (always populated, even flag-off / dry-run — visibility). */
  targets: { ownerId: string; sessionId: string | null; reason: string }[];
}

/**
 * One sweep pass: gather live bees, decide per-bee, recycle the over-cap idle ones
 * (only when armed + not dry-run). Fail-soft per bee (one recycle failure never aborts
 * the sweep). Flag-OFF ⇒ the over-cap cohort is still computed + reported, recycled 0.
 */
export async function runBeeTranscriptCapSweep(opts: {
  dryRun?: boolean;
  caps?: Partial<BeeTranscriptCaps>;
  deps: BeeTranscriptCapDeps;
  log?: (m: string) => void;
}): Promise<BeeTranscriptCapReport> {
  const log = opts.log ?? (() => {});
  const enabled = await getFlag(FLAGS.BEE_TRANSCRIPT_CAP, 'system').catch(() => false);
  const caps = { ...DEFAULT_BEE_TRANSCRIPT_CAPS, ...opts.caps };
  const dryRun = opts.dryRun === true;

  const bees = await opts.deps.listBees().catch((e) => {
    log(`bee-transcript-cap: listBees failed (degraded to empty): ${e instanceof Error ? e.message : String(e)}`);
    return [] as BeeTranscriptMetrics[];
  });

  const report: BeeTranscriptCapReport = {
    enabled,
    dryRun,
    scanned: bees.length,
    overCap: 0,
    recycled: 0,
    failed: 0,
    targets: [],
  };

  for (const b of bees) {
    const d = shouldRecycleBeeTranscript(b, caps);
    if (!d.recycle) continue;
    report.overCap += 1;
    report.targets.push({ ownerId: b.ownerId, sessionId: b.sessionId, reason: d.reason ?? '' });
    if (!enabled || dryRun) continue; // double-gated: log the cohort, recycle nothing
    try {
      await opts.deps.recycle(b);
      report.recycled += 1;
    } catch (e) {
      report.failed += 1;
      log(`bee-transcript-cap: recycle ${b.ownerId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
