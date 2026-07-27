/**
 * journal-read — read a systemd unit's journal and return DISTILLED entries.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-023 (D-027 measurement + design
 * ruling). The agent-facing verb is `logs:read`; this module is the pure parsing
 * + argv construction plus the one exec edge, so every decision below is
 * unit-testable without mocking `child_process`.
 *
 * ── Why this exists, and why it filters SERVER-SIDE ─────────────────────────
 * D-027 measured the 7d corpus: 428 journalctl commands across 38 of 86 su
 * sessions. 413 of them (96%) pipe the journal into a CLIENT-SIDE filter
 * (`| grep` 292, `| tail` 102) and NOT ONE uses journalctl's own `--grep`. So
 * every one of them pulls a whole unit-window across the pipe and filters after
 * the fact. That is the exact defect `readBgHostJournal` (pot/soak-report.ts)
 * already had to fix once: this host's 24h user journal is ~400MB, the unfiltered
 * read blew execFile's maxBuffer, and a fail-soft catch returned zeros — so the
 * soak gate reported CLEAN while bg-host had restarted 9 times and peaked at
 * 23.8GB. Pushing the pattern down to `--grep` took that read from ~400MB to
 * ~3KB. This tool therefore pushes `grep` down as its whole reason to exist, and
 * offers NO raw-output passthrough: that would re-create the `| grep | tail`
 * pipe inside the tool and forfeit the entire saving (same argument as D-022 for
 * `testing:run`).
 *
 * ── The four journalctl semantics reused from soak-report.ts ────────────────
 * These were expensive to learn and are trivially easy to re-break:
 *  1. EXIT CODE 1 WITH EMPTY STDERR MEANS "--grep MATCHED NOTHING" — a genuinely
 *     clean window, NOT a failed read.
 *  2. ENOENT MEANS THERE IS NO JOURNAL AT ALL (no systemd: macOS, a bare
 *     container, the shipped desktop target). A platform capability, not an
 *     error — reported as `journalAvailable:false`, never as "no log lines".
 *  3. ALWAYS UNIT-SCOPE when a unit is known: measured 25.97s unscoped versus
 *     7.58s scoped on a 1.2GB journal, for a read that returned 17 bytes.
 *  4. maxBuffer must be raised well above the Node default.
 *
 * ABSENT EVIDENCE MUST NEVER READ AS EVIDENCE OF ABSENCE — the result carries
 * `journalAvailable` and `journalError` explicitly, so an unreadable journal can
 * never be projected as an empty one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default returned-row cap. The corpus's own `-n` values cluster low (median
 *  30, max 2000); 200 covers the shape without ever handing back a dump. */
export const JOURNAL_READ_DEFAULT_LIMIT = 200;
/** Hard ceiling. Above this the caller wants a file, not an agent-context read. */
export const JOURNAL_READ_MAX_LIMIT = 1000;
/** Default window when the caller names a unit but no `since`. 91% of measured
 *  commands pass `--since`, overwhelmingly a short relative window. */
export const JOURNAL_READ_DEFAULT_SINCE = '-30 min';
/** Per-message clip. A single journal line can be a whole stack trace. */
export const JOURNAL_MESSAGE_MAX_CHARS = 2000;
/** 32MB, matching readBgHostJournal — the `--grep` push-down keeps real reads
 *  orders of magnitude under this, so hitting it means the caller asked for a
 *  dump and should narrow instead. */
export const JOURNAL_MAX_BUFFER = 32 * 1024 * 1024;
/** Wall-clock budget for one journalctl invocation. The measured worst case (an
 *  UNSCOPED scan of a 1.2GB journal) was ~26s; a unit-scoped read is ~7s. */
export const JOURNAL_TIMEOUT_MS = 30_000;

/** syslog severities, most severe first — index IS the numeric priority. */
export const JOURNAL_LEVELS = [
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
] as const;
export type JournalLevel = (typeof JOURNAL_LEVELS)[number];

export interface JournalEntry {
  /** ISO-8601 UTC. Derived from `__REALTIME_TIMESTAMP` (microseconds since the
   *  epoch), NOT from a locale-formatted string — same reasoning as
   *  systemd-service-probe preferring `ps -o etimes=` over parsing systemd's
   *  locale-formatted timestamps. */
  ts: string;
  /** `_SYSTEMD_UNIT`, falling back to `SYSLOG_IDENTIFIER`. Null when the entry
   *  carries neither (kernel/audit records). */
  unit: string | null;
  level: JournalLevel | null;
  message: string;
  /** How many CONSECUTIVE identical (unit, message) lines this row stands for.
   *  1 ⇒ not collapsed. */
  repeat: number;
  /** Timestamp of the LAST line in a collapsed run; present only when repeat>1. */
  lastTs?: string;
  /** True when `message` was clipped at JOURNAL_MESSAGE_MAX_CHARS. */
  clipped?: true;
}

export interface JournalReadResult {
  entries: JournalEntry[];
  /**
   * Journal lines journalctl actually emitted, BEFORE dedup and the row cap.
   *
   * BOUNDED BY `limit + 1`, because the row cap is pushed down to journalctl's
   * own `-n` (which bounds the SCAN, not just the output — strictly cheaper than
   * slicing afterwards). So when `truncated` is true this is a FLOOR on the true
   * match count, never the total. Narrow `grep`/`since` to learn the real number;
   * do not report `matched` as "there were N matches" on a truncated read.
   */
  matched: number;
  /** Lines removed by consecutive-identical collapsing. */
  collapsed: number;
  /** True when older rows were dropped to honour `limit` (newest are kept). */
  truncated: boolean;
  window: { since: string; until: string | null };
  units: string[];
  /** False ⇒ this host has NO journal (no systemd). Not the same as "no lines". */
  journalAvailable: boolean;
  /** Non-null ⇒ the read FAILED and `entries` is meaningless, not empty. */
  journalError: string | null;
  /**
   * Requested units systemd does not know about — the read returned nothing
   * because the UNIT NAME IS WRONG, not because the window was clean.
   *
   * journalctl exits 0 with zero entries for a unit that has never existed, so
   * a typo is otherwise INDISTINGUISHABLE from a healthy silent service. That is
   * the same absent-evidence-reads-as-evidence-of-absence trap this whole module
   * is built against, so it is checked (only on the empty path, so the common
   * case pays nothing) rather than left for the caller to notice.
   */
  unitsUnknown: string[];
  /** The exact argv used, so a result is reproducible by hand. */
  command: string;
}

export interface JournalReadOptions {
  /** Unit names; bare names are `.service`-suffixed by the caller. */
  units?: string[];
  /** `-t` syslog identifier. */
  identifier?: string;
  since?: string;
  until?: string;
  /** Pushed down to `journalctl --grep` (a PCRE, case-insensitive). */
  grep?: string;
  /** `-p`: this severity AND MORE SEVERE, matching journalctl's own semantics. */
  level?: JournalLevel;
  limit?: number;
  /** Read the SYSTEM journal instead of `--user`. 5% of measured commands. */
  system?: boolean;
}

/** Fields we ask journalctl for. Restricting them is what keeps `-o json`
 *  affordable: without it, JSON output is ~10x the wire size of `short-iso` for
 *  the same lines. We take JSON anyway because parsing `short-iso` means
 *  splitting on spaces across arbitrary hostnames and identifiers — a silent
 *  mis-parse that drops the unit or truncates the message, which is precisely
 *  the class of quiet wrongness this tool exists to remove. */
export const JOURNAL_OUTPUT_FIELDS = [
  '__REALTIME_TIMESTAMP',
  // `_SYSTEMD_USER_UNIT` MUST come with `_SYSTEMD_UNIT`, and must WIN. For a
  // `--user` unit the systemd-level `_SYSTEMD_UNIT` is the SESSION CONTAINER
  // (`user@1000.service`) and the real unit is only in `_SYSTEMD_USER_UNIT` —
  // caught in live verification, where every bg-host line came back attributed
  // to `user@1000.service`. A system read simply has no user-unit field, so
  // preferring it is correct in both modes.
  '_SYSTEMD_USER_UNIT',
  '_SYSTEMD_UNIT',
  'SYSLOG_IDENTIFIER',
  'PRIORITY',
  'MESSAGE',
] as const;

/**
 * PURE — build the journalctl argv.
 *
 * `--no-pager` is unconditional (a pager on a pipe would hang the read), and
 * `--case-sensitive=false` matches what the corpus's hand-written `grep -i`
 * calls already do.
 */
export function buildJournalctlArgs(opts: JournalReadOptions): string[] {
  const args: string[] = [opts.system ? '--system' : '--user', '--no-pager', '-o', 'json'];
  args.push(`--output-fields=${JOURNAL_OUTPUT_FIELDS.join(',')}`);
  for (const unit of opts.units ?? []) args.push('-u', unit);
  if (opts.identifier) args.push('-t', opts.identifier);
  args.push('--since', opts.since ?? JOURNAL_READ_DEFAULT_SINCE);
  if (opts.until) args.push('--until', opts.until);
  if (opts.level) args.push('-p', opts.level);
  if (opts.grep) {
    args.push('--grep', opts.grep, '--case-sensitive=false');
  }
  // `-n` is journalctl's own TAIL cap: it bounds the SCAN, not just the output,
  // so pushing the row cap down here is strictly cheaper than slicing after the
  // fact. We ask for one more than we intend to return so `truncated` can be
  // reported honestly rather than guessed.
  const limit = clampLimit(opts.limit);
  args.push('-n', String(limit + 1));
  return args;
}

/** PURE — clamp a caller's row cap into the supported range. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return JOURNAL_READ_DEFAULT_LIMIT;
  return Math.max(1, Math.min(JOURNAL_READ_MAX_LIMIT, Math.floor(limit)));
}

/** One decoded journal record, before dedup. */
export interface RawJournalRecord {
  ts: string;
  unit: string | null;
  level: JournalLevel | null;
  message: string;
  clipped: boolean;
}

/**
 * PURE — decode journalctl `-o json` (one JSON object per line).
 *
 * Malformed lines are SKIPPED rather than thrown on: journalctl interleaves
 * informational lines (`-- No entries --`, rotation notices) into the stream,
 * and one of those must not fail a read that otherwise succeeded.
 */
export function parseJournalJson(stdout: string): RawJournalRecord[] {
  const out: RawJournalRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = decodeMessage(rec.MESSAGE);
    if (raw === null) continue;
    const clipped = raw.length > JOURNAL_MESSAGE_MAX_CHARS;
    out.push({
      ts: decodeRealtime(rec.__REALTIME_TIMESTAMP),
      unit: decodeUnit(rec),
      level: decodePriority(rec.PRIORITY),
      message: clipped ? `${raw.slice(0, JOURNAL_MESSAGE_MAX_CHARS)}…` : raw,
      clipped,
    });
  }
  return out;
}

/** PURE — `__REALTIME_TIMESTAMP` is microseconds-since-epoch AS A STRING. */
export function decodeRealtime(value: unknown): string {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return '';
  return new Date(Math.floor(micros / 1000)).toISOString();
}

/**
 * PURE — journald stores MESSAGE as an ARRAY OF BYTE VALUES whenever the payload
 * is not valid UTF-8 (an ANSI-coloured build log is the common case here). A
 * naive `String(rec.MESSAGE)` renders that as "72,101,108,…", which looks like
 * data and is not — so decode it properly.
 */
export function decodeMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const bytes = value.filter((b): b is number => typeof b === 'number');
    if (!bytes.length) return null;
    return Buffer.from(bytes).toString('utf8');
  }
  return null;
}

/**
 * PURE — resolve the unit an entry belongs to.
 *
 * `_SYSTEMD_USER_UNIT` FIRST: for a `--user` unit, `_SYSTEMD_UNIT` is the user
 * session container (`user@1000.service`), not the service. Reading the wrong
 * one attributes every line of every user unit to the same container, which is
 * exactly what live verification showed before this fix.
 */
export function decodeUnit(rec: Record<string, unknown>): string | null {
  for (const key of ['_SYSTEMD_USER_UNIT', '_SYSTEMD_UNIT', 'SYSLOG_IDENTIFIER'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** PURE — PRIORITY arrives as a numeric STRING ("0".."7"). */
export function decodePriority(value: unknown): JournalLevel | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= JOURNAL_LEVELS.length) return null;
  return JOURNAL_LEVELS[n];
}

/**
 * PURE — collapse runs of CONSECUTIVE identical (unit, message) lines.
 *
 * Consecutive-only, deliberately. Grouping globally would compress a noisy unit
 * far harder, but it destroys chronology — and the measured intent is "the
 * matching lines, in order, from window W" (70% grep for a content needle, 25%
 * then `tail` it). A restart storm or a retry loop is exactly the consecutive
 * shape, so this collapses the volume that actually exists without reordering
 * the evidence anyone is reading.
 */
export function collapseConsecutive(records: RawJournalRecord[]): {
  entries: JournalEntry[];
  collapsed: number;
} {
  const entries: JournalEntry[] = [];
  let collapsed = 0;
  for (const rec of records) {
    const prev = entries[entries.length - 1];
    if (prev && prev.unit === rec.unit && prev.message === rec.message) {
      prev.repeat += 1;
      prev.lastTs = rec.ts;
      collapsed += 1;
      continue;
    }
    entries.push({
      ts: rec.ts,
      unit: rec.unit,
      level: rec.level,
      message: rec.message,
      repeat: 1,
      ...(rec.clipped ? { clipped: true as const } : {}),
    });
  }
  return { entries, collapsed };
}

export type JournalFailureKind = 'no-match' | 'no-systemd' | 'error';

/**
 * PURE — classify a journalctl rejection.
 *
 * The `no-match` case is the one that bites: journalctl exits 1 when `--grep`
 * matched nothing, which is a CLEAN WINDOW, not a failure. Treating it as an
 * error makes the tool report a read failure for the most common good outcome;
 * treating a real failure as no-match makes it report an empty log for a journal
 * it could not read. Both are wrong in opposite, equally quiet directions.
 */
export function classifyJournalctlFailure(err: unknown): { kind: JournalFailureKind; message: string } {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  const stderr = String(e?.stderr ?? '').trim();
  if (e?.code === 'ENOENT') return { kind: 'no-systemd', message: 'no journalctl binary on this host' };
  if (e?.code === 1 && !stderr) return { kind: 'no-match', message: '' };
  return { kind: 'error', message: (stderr || String(e?.message ?? 'journalctl read failed')).slice(0, 300) };
}

/** Shape of the exec seam, so tests drive it without a real journal. */
export type JournalExec = (args: string[]) => Promise<{ stdout: string }>;

const defaultExec: JournalExec = (args) =>
  execFileAsync('journalctl', args, { timeout: JOURNAL_TIMEOUT_MS, maxBuffer: JOURNAL_MAX_BUFFER });

/** Resolves each requested unit to whether systemd knows it. */
export type UnitLoadProbe = (units: string[], system: boolean) => Promise<string[]>;

/**
 * Which of these units does systemd NOT know? `LoadState=not-found` is the
 * determinate answer; anything else (including a probe failure) reports nothing,
 * because a FALSE "that unit does not exist" is worse than saying nothing at all.
 */
export const defaultUnitLoadProbe: UnitLoadProbe = async (units, system) => {
  const unknown: string[] = [];
  await Promise.all(
    units.map(async (unit) => {
      try {
        const { stdout } = await execFileAsync(
          'systemctl',
          [system ? '--system' : '--user', 'show', '-p', 'LoadState', unit],
          { timeout: 3000 },
        );
        if (/^LoadState=not-found$/m.test(stdout.trim())) unknown.push(unit);
      } catch {
        // Cannot tell ⇒ say nothing.
      }
    }),
  );
  return unknown;
};

/**
 * Read the journal and return distilled entries.
 *
 * Never throws for an expected condition: a clean window, an absent journal and
 * a failed read are all reported in the RESULT, distinguishably.
 */
export async function readJournal(
  opts: JournalReadOptions,
  exec: JournalExec = defaultExec,
  probeUnits: UnitLoadProbe = defaultUnitLoadProbe,
): Promise<JournalReadResult> {
  const limit = clampLimit(opts.limit);
  const args = buildJournalctlArgs({ ...opts, limit });
  const units = opts.units ?? [];
  const base = {
    matched: 0,
    collapsed: 0,
    truncated: false,
    window: { since: opts.since ?? JOURNAL_READ_DEFAULT_SINCE, until: opts.until ?? null },
    units,
    unitsUnknown: [] as string[],
    command: `journalctl ${args.join(' ')}`,
  };

  /** Zero lines from a named unit is ambiguous — resolve it before returning. */
  const withUnknownUnits = async (result: JournalReadResult): Promise<JournalReadResult> => {
    if (result.entries.length || !units.length || !result.journalAvailable) return result;
    return { ...result, unitsUnknown: await probeUnits(units, opts.system === true) };
  };

  let stdout: string;
  try {
    ({ stdout } = await exec(args));
  } catch (err) {
    const { kind, message } = classifyJournalctlFailure(err);
    if (kind === 'no-match') {
      return withUnknownUnits({ ...base, entries: [], journalAvailable: true, journalError: null });
    }
    return {
      ...base,
      entries: [],
      journalAvailable: kind !== 'no-systemd',
      journalError: kind === 'no-systemd' ? null : message,
    };
  }

  const records = parseJournalJson(stdout);
  // `-n` gives us the NEWEST lines; we asked for limit+1 so an over-cap read is
  // detectable rather than assumed. Drop from the OLD end — a tail is what every
  // measured `| tail -N` was reaching for.
  const truncated = records.length > limit;
  const kept = truncated ? records.slice(records.length - limit) : records;
  const { entries, collapsed } = collapseConsecutive(kept);
  return withUnknownUnits({
    ...base,
    entries,
    matched: records.length,
    collapsed,
    truncated,
    journalAvailable: true,
    journalError: null,
  });
}
