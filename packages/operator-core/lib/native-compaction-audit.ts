/**
 * native-compaction-audit — the P-022 (WI-4998) zero-invocation audit.
 *
 * Owner terminal state 2026-07-14: "remove the compact call entirely" — no
 * /compact, no omp native strategies, no provider-side compaction; papercusp
 * carry (builder + respawn/handoff + shake) is the only compaction path. The
 * completion criterion is auditable: ZERO native-summarizer invocations across
 * sessions started after the cutover.
 *
 * A Claude Code native compaction (auto OR manual /compact) writes a
 * `{"type":"system","subtype":"compact_boundary"}` row into the session
 * transcript — verified against real transcripts on this box 2026-07-18. This
 * module scans the Claude projects tree for sessions STARTED at/after a cutover
 * instant and counts those rows. A session whose start timestamp cannot be read
 * is included CONSERVATIVELY when its file was modified after the cutover — an
 * unattributable session with native boundaries must surface, never hide.
 *
 * (OMP native strategies are covered separately: the launcher forces the
 * papercusp compaction block into every relocated config — psu-launcher.mjs
 * P-022 leg — and the gateway's `maintenance.carried` vs `.requests` counters
 * expose any LLM-lane serve. This scanner is the Claude-transcript leg.)
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const COMPACT_BOUNDARY_MARKER = '"subtype":"compact_boundary"';

export interface NativeCompactionSessionFinding {
  /** Absolute transcript path. */
  file: string;
  /** Parsed start instant of the session (first row timestamp), null when unreadable. */
  sessionStartMs: number | null;
  /** Count of native compact-boundary rows found in the transcript. */
  compactBoundaries: number;
}

export interface NativeCompactionAuditReport {
  /** Transcripts in scope (session started — or conservatively, file modified — at/after sinceMs). */
  scanned: number;
  /** In-scope sessions with ≥1 native compact boundary — MUST be empty for the P-022 verdict. */
  offenders: NativeCompactionSessionFinding[];
  totalBoundaries: number;
  verdict: 'clean' | 'violations';
}

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** First transcript row's `timestamp` — the session start. Fail-soft null. */
export function firstTimestampMs(text: string): number | null {
  const nl = text.indexOf('\n');
  const first = (nl >= 0 ? text.slice(0, nl) : text).trim();
  if (!first) return null;
  try {
    const row = JSON.parse(first) as { timestamp?: unknown };
    const t = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Count native compact-boundary rows. Cheap substring prefilter, then a real
 *  parse so a quoted marker inside message CONTENT can never count as a boundary. */
export function countCompactBoundaries(text: string): number {
  if (!text.includes(COMPACT_BOUNDARY_MARKER)) return 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(COMPACT_BOUNDARY_MARKER)) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; subtype?: unknown };
      if (row.type === 'system' && row.subtype === 'compact_boundary') n++;
    } catch {
      /* not a well-formed row — never counted */
    }
  }
  return n;
}

export async function auditNativeCompactionRetirement(opts: {
  /** The cutover instant: only sessions started at/after this count. */
  sinceMs: number;
  /** Claude projects root override (tests); defaults to ~/.claude/projects. */
  root?: string;
}): Promise<NativeCompactionAuditReport> {
  const root = opts.root ?? defaultClaudeProjectsRoot();
  const report: NativeCompactionAuditReport = { scanned: 0, offenders: [], totalBoundaries: 0, verdict: 'clean' };
  let projects: string[] = [];
  try {
    projects = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return report; // no tree ⇒ nothing to audit (0 scanned is its own signal upstream)
  }
  for (const dir of projects) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
    } catch {
      continue;
    }
    for (const file of files) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      // A session untouched since before the cutover cannot be in scope.
      if (mtimeMs < opts.sinceMs) continue;
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const startMs = firstTimestampMs(text);
      // In scope: started after the cutover — or start unreadable (conservative include).
      if (startMs != null && startMs < opts.sinceMs) continue;
      report.scanned++;
      const boundaries = countCompactBoundaries(text);
      if (boundaries > 0) {
        report.offenders.push({ file, sessionStartMs: startMs, compactBoundaries: boundaries });
        report.totalBoundaries += boundaries;
      }
    }
  }
  report.verdict = report.offenders.length > 0 ? 'violations' : 'clean';
  return report;
}
