/**
 * The curation loop — the heart of the curator-operator
 * (plan `curator-operator-2026-06-04`, P0).
 *
 * One tick: gather the fleet's STRUCTURED status → classify each signal with the
 * salience policy → surface the always-surface items as one calm operator
 * message (urgent-first) → fold routine progress + fleet-internal completions
 * into ONE batch digest (rate-limited) → record what was surfaced so it isn't
 * re-nagged. Reuses the existing surface (operator chat), dedup memory
 * (`operator_curation_log`), and coord/work_item readers — almost every piece
 * already existed; this is the orchestration + the salience filter.
 *
 * `runCurationTick` does NO scheduling I/O — it takes injected `deps` (the
 * `autoloop.ts` test convention) so it's unit-testable without PG. The DBOS
 * workflow (`dbos/curation-workflow.ts`) owns the cadence + state; the urgent
 * wake (`urgent-wake.ts`) calls this with `canEmitDigest:false` for an
 * immediate escalation/blocker surface.
 */
import {
  classifyAll,
  partition,
  SALIENCE_POLICY_VERSION,
  type ClassifiedSignal,
} from './salience-policy';
import { gatherFleetSignals, type FleetReaders } from './fleet-signals';
import type { SurfacedEntry } from './curation-log';

// ── Cadence / backoff constants (the "faster when busy, slower when quiet" rule)
/** The adaptive interval floor — how often a busy workspace re-curates. */
export const BASE_INTERVAL_SECONDS = 120;
/** The adaptive interval cap — how slow a quiet workspace backs off to. */
export const MAX_INTERVAL_SECONDS = 900;
/** Don't emit a routine batch digest more often than this (calm cadence). */
export const DIGEST_MIN_GAP_SECONDS = 300;
/** …unless the batch has grown past this many items (surface a digest sooner). */
export const DIGEST_BURST_THRESHOLD = 8;

export interface CurationDeps {
  readers: FleetReaders;
  /** "Already surfaced" ids (the idempotency overlay). */
  loadSurfaced: (windowMs?: number) => Promise<Set<string>>;
  /** Persist what we surfaced/batched this tick. */
  recordSurfaced: (entries: readonly SurfacedEntry[], policyVersion: string) => Promise<void>;
  /** Emit one curated message into the operator's single voice. */
  surface: (text: string) => Promise<unknown>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Dedup window passed to loadSurfaced. */
  windowMs?: number;
}

export interface RunTickOptions {
  /** Whether routine batched items may be digested this tick (the workflow
   *  rate-limits digests; the urgent wake passes false → urgent-only).
   *  A function receives the pending batch size so the workflow can apply the
   *  burst threshold (digest sooner when a lot has piled up). Defaults true. */
  canEmitDigest?: boolean | ((pendingBatchSize: number) => boolean);
}

export interface CurationTickResult {
  /** Always-surface items emitted this tick. */
  surfacedCount: number;
  /** Routine items folded into the digest (0 if no digest emitted). */
  batchedCount: number;
  /** Routine items deferred (batch present but digest rate-limited this tick). */
  deferredBatchCount: number;
  digestEmitted: boolean;
  hasUrgent: boolean;
  /** The curated messages emitted (for tests / audit). */
  messages: string[];
}

const KIND_MARKER: Record<string, string> = {
  escalation: '⚠',
  blocker: '🚧',
  decision: '❓',
  completion: '✓',
  progress: '·',
};

const KIND_LABEL: Record<string, string> = {
  escalation: 'Escalation',
  blocker: 'Blocked',
  decision: 'Decision needed',
  completion: 'Done',
  progress: 'Progress',
};

/** Format ONE always-surface signal into a calm line, with the drill-in ref
 *  (D-005 — curation never hides; the raw item is always reachable). */
export function formatSignalLine(c: ClassifiedSignal): string {
  const { signal } = c;
  const marker = KIND_MARKER[signal.kind] ?? '•';
  const label = KIND_LABEL[signal.kind] ?? signal.kind;
  const where = signal.harness ? ` [${signal.harness}]` : '';
  const requested = signal.kind === 'completion' && signal.userRequested ? ' (you asked for this)' : '';
  let line = `${marker} **${label}**${where}${requested} — ${signal.title}`;
  if (signal.detail) line += ` · ${signal.detail}`;
  if (signal.ref) line += ` · drill in: \`${signal.ref}\``;
  return line;
}

/** Compose the single always-surface message (urgent-first). */
export function formatSurfaceMessage(surfaceNow: readonly ClassifiedSignal[]): string {
  return surfaceNow.map(formatSignalLine).join('\n');
}

/** Compose ONE calm batch digest from routine items: a count-by-kind header
 *  plus up to a few titles. Never per-signal nagging. */
export function formatBatchDigest(batch: readonly ClassifiedSignal[]): string {
  const counts = new Map<string, number>();
  for (const c of batch) counts.set(c.signal.kind, (counts.get(c.signal.kind) ?? 0) + 1);
  const parts: string[] = [];
  const progressed = counts.get('progress') ?? 0;
  const completed = counts.get('completion') ?? 0;
  if (progressed) parts.push(`${progressed} item${progressed === 1 ? '' : 's'} progressed`);
  if (completed) parts.push(`${completed} completed`);
  // Any other kinds that slipped into the batch bucket.
  for (const [k, n] of counts) {
    if (k === 'progress' || k === 'completion') continue;
    parts.push(`${n} ${k}`);
  }
  const header = `📋 Fleet update — ${parts.join(' · ') || `${batch.length} updates`}`;
  const sample = batch.slice(0, 3).map((c) => `· ${c.signal.title}`);
  return [header, ...sample].join('\n');
}

/**
 * Run one curation tick. Pure over `deps` — no scheduling/state I/O.
 */
export async function runCurationTick(
  deps: CurationDeps,
  opts: RunTickOptions = {},
): Promise<CurationTickResult> {
  const signals = await gatherFleetSignals(deps.readers);
  const alreadySurfaced = await deps.loadSurfaced(deps.windowMs);
  const verdicts = classifyAll(signals, { alreadySurfaced });
  const { surfaceNow, batch, hasUrgent } = partition(signals, verdicts);
  const canEmitDigest =
    typeof opts.canEmitDigest === 'function'
      ? opts.canEmitDigest(batch.length)
      : opts.canEmitDigest ?? true;

  const messages: string[] = [];
  const recorded: SurfacedEntry[] = [];

  // 1) Always-surface items → one calm operator message (urgent leads).
  if (surfaceNow.length > 0) {
    const text = formatSurfaceMessage(surfaceNow);
    await deps.surface(text);
    messages.push(text);
    for (const c of surfaceNow) recorded.push({ id: c.signal.id, kind: c.signal.kind });
  }

  // 2) Routine batch → ONE digest, only when the workflow allows it this tick.
  //    Deferred items are NOT recorded, so they re-accumulate until digested.
  let digestEmitted = false;
  let batchedCount = 0;
  let deferredBatchCount = 0;
  if (batch.length > 0) {
    if (canEmitDigest) {
      const text = formatBatchDigest(batch);
      await deps.surface(text);
      messages.push(text);
      digestEmitted = true;
      batchedCount = batch.length;
      for (const c of batch) recorded.push({ id: c.signal.id, kind: c.signal.kind });
    } else {
      deferredBatchCount = batch.length;
    }
  }

  if (recorded.length > 0) {
    await deps.recordSurfaced(recorded, SALIENCE_POLICY_VERSION);
  }

  return {
    surfacedCount: surfaceNow.length,
    batchedCount,
    deferredBatchCount,
    digestEmitted,
    hasUrgent,
    messages,
  };
}

// ── Pure scheduling/backoff helpers (the workflow + wake use these) ───────────

/** Next adaptive interval: reset to BASE when something surfaced this tick
 *  (busy → re-curate soon), else grow geometrically toward MAX (quiet → back off). */
export function nextInterval(prevSeconds: number, surfacedThisTick: boolean): number {
  if (surfacedThisTick) return BASE_INTERVAL_SECONDS;
  const grown = Math.round((prevSeconds || BASE_INTERVAL_SECONDS) * 1.5);
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(BASE_INTERVAL_SECONDS, grown));
}

/** Whether a cadence tick should actually run the (relatively heavy) curation,
 *  honoring the adaptive interval since the last run. */
export function shouldRunTick(
  lastRunAtMs: number | null,
  currentIntervalSeconds: number,
  nowMs: number,
): boolean {
  if (lastRunAtMs == null) return true;
  return nowMs - lastRunAtMs >= Math.max(1, currentIntervalSeconds) * 1000;
}

/** Whether a routine batch digest may be emitted now (rate-limited by
 *  DIGEST_MIN_GAP, or forced when the pending batch is large). */
export function canEmitDigestNow(
  lastDigestAtMs: number | null,
  pendingBatchSize: number,
  nowMs: number,
): boolean {
  if (pendingBatchSize <= 0) return false;
  if (pendingBatchSize >= DIGEST_BURST_THRESHOLD) return true;
  if (lastDigestAtMs == null) return true;
  return nowMs - lastDigestAtMs >= DIGEST_MIN_GAP_SECONDS * 1000;
}
