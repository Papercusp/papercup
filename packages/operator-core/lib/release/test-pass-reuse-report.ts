/**
 * P-013 (plan gate-file-level-test-reuse-2026-09-27): the gate-side reader of the per-file
 * pass-reuse lines `scripts/affected-tests.mjs` prints. The line formats are defined in
 * `scripts/lib/test-pass-reuse.mjs` (`formatTestReuseLine`, `formatTestReuseTotalLine`,
 * `formatReuseAlarmLine`) plus the two `applied=false` lines in `armTestPassReuse`.
 *
 * Pure over captured suite output, so the gate can record one structured summary per round
 * (`gate_health.testPassReuse`) and /admin/git can show "what did reuse do" without anyone
 * re-grepping a run log. Lives in operator-core so both the writer (the green-checkpoint
 * runner) and the reader (`git-pipeline-stats.ts`) share one definition.
 *
 * One affected-tests invocation prints, in order:
 *   - either ONE whole-run `TEST_PASS_REUSE applied=false reason=<r>` line (reuse off), or
 *   - one `TEST_PASS_REUSE ws=<name> …` line per armed task (counts, or
 *     `applied=false reason=<r>` for that task only), then one `TEST_PASS_REUSE_TOTAL …` line;
 *   - later, after the tasks ran, zero or more `TEST_PASS_REUSE_ALARM ws=… file=… proof=…`
 *     lines (a file reuse WOULD have skipped failed on a fresh run).
 * A gate round can concatenate several invocations (selective phase, full phase), so the
 * parser returns one entry per invocation, in output order.
 */

export interface TestPassReuseTotal {
  tasks: number;
  candidates: number;
  reused: number;
  audited: number;
  expiredClean: number;
  /**
   * Lower bound on the test time the reused files would have cost: the sum of each reused
   * file's last CI pass duration. `null` = the durations could not be read for some task.
   */
  minSavedTestMs: number | null;
  /** Reused files with no recorded duration, so not counted in `minSavedTestMs`. */
  unmeasured: number;
}

export interface TestPassReuseWorkspace {
  ws: string;
  /** False when reuse was not applied to this task (`reason` says why). */
  applied: boolean;
  reason: string | null;
  /** Every numeric `key=value` field on the line (candidates, reused, noProof, expired, …). */
  counts: Record<string, number>;
  minSavedTestMs: number | null;
  /** Whether the task ran a narrowed (related-files) selection; null when the line omits it. */
  narrowed: boolean | null;
}

export interface TestPassReuseAlarm {
  ws: string;
  file: string;
  /** Why the file ran instead of being reused (the proof state, e.g. `expired`). */
  proof: string;
}

export interface TestPassReuseRun {
  /** False when the whole invocation printed `TEST_PASS_REUSE applied=false`. */
  applied: boolean;
  offReason: string | null;
  workspaces: TestPassReuseWorkspace[];
  total: TestPassReuseTotal | null;
  alarms: TestPassReuseAlarm[];
}

const LINE_RE = /^(?:\[[^\]]*\]\s*)?(TEST_PASS_REUSE(?:_TOTAL|_ALARM)?) (.*)$/;
const FIELD_RE = /(?:^|\s)([A-Za-z]+)=(\S+)/g;

function fields(rest: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rest.matchAll(FIELD_RE)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

function int(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** `applied=false reason=<r>` keeps everything after `reason=`, since a reason may carry spaces. */
function reasonOf(rest: string): string | null {
  const i = rest.indexOf('reason=');
  return i < 0 ? null : rest.slice(i + 'reason='.length).trim() || null;
}

export function parseTestPassReuse(output: string): TestPassReuseRun[] {
  const runs: TestPassReuseRun[] = [];
  let current: TestPassReuseRun | null = null;
  const openRun = (): TestPassReuseRun => {
    if (current && current.applied && current.total === null) return current;
    current = { applied: true, offReason: null, workspaces: [], total: null, alarms: [] };
    runs.push(current);
    return current;
  };

  for (const raw of output.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trimStart());
    if (!m) continue;
    const kind = m[1]!;
    const rest = m[2]!;
    const f = fields(rest);

    if (kind === 'TEST_PASS_REUSE_TOTAL') {
      const run = openRun();
      run.total = {
        tasks: int(f.get('tasks')) ?? 0,
        candidates: int(f.get('candidates')) ?? 0,
        reused: int(f.get('reused')) ?? 0,
        audited: int(f.get('audited')) ?? 0,
        expiredClean: int(f.get('expiredClean')) ?? 0,
        minSavedTestMs: int(f.get('minSavedTestMs')),
        unmeasured: int(f.get('unmeasured')) ?? 0,
      };
      continue;
    }

    if (kind === 'TEST_PASS_REUSE_ALARM') {
      const ws = f.get('ws');
      const file = f.get('file');
      if (!ws || !file) continue;
      const run = current ?? openRun();
      run.alarms.push({ ws, file, proof: f.get('proof') ?? 'unknown' });
      continue;
    }

    // TEST_PASS_REUSE
    const ws = f.get('ws');
    if (!ws) {
      if (f.get('applied') === 'false') {
        current = {
          applied: false,
          offReason: reasonOf(rest),
          workspaces: [],
          total: null,
          alarms: [],
        };
        runs.push(current);
      }
      continue;
    }
    const run = openRun();
    if (f.get('applied') === 'false') {
      run.workspaces.push({
        ws,
        applied: false,
        reason: reasonOf(rest),
        counts: {},
        minSavedTestMs: null,
        narrowed: null,
      });
      continue;
    }
    const counts: Record<string, number> = {};
    for (const [k, v] of f) {
      if (k === 'ws' || k === 'minSavedTestMs' || k === 'narrowed') continue;
      const n = int(v);
      if (n !== null) counts[k] = n;
    }
    const narrowed = f.get('narrowed');
    run.workspaces.push({
      ws,
      applied: true,
      reason: null,
      counts,
      minSavedTestMs: int(f.get('minSavedTestMs')),
      narrowed: narrowed === 'true' ? true : narrowed === 'false' ? false : null,
    });
  }
  return runs;
}

export interface TestPassReuseRoundSummary {
  /** Invocations seen (0 = the round printed no reuse line at all, e.g. an older runner). */
  invocations: number;
  candidates: number;
  reused: number;
  /** Summed lower bound; null when any invocation's savings were unknown. */
  minSavedTestMs: number | null;
  unmeasured: number;
  alarms: TestPassReuseAlarm[];
  /** Distinct reasons reuse was off, whole-run or per task. */
  offReasons: string[];
  headline: string;
}

export function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** One gate round's reuse effect, summed over its invocations, with a one-line headline. */
export function summarizeTestPassReuse(runs: TestPassReuseRun[]): TestPassReuseRoundSummary {
  let candidates = 0;
  let reused = 0;
  let unmeasured = 0;
  let minSavedTestMs: number | null = 0;
  const alarms: TestPassReuseAlarm[] = [];
  const offReasons = new Set<string>();
  for (const run of runs) {
    alarms.push(...run.alarms);
    if (!run.applied) {
      offReasons.add(run.offReason ?? 'unknown');
      continue;
    }
    for (const w of run.workspaces) {
      if (!w.applied) offReasons.add(w.reason ?? 'unknown');
    }
    if (run.total) {
      candidates += run.total.candidates;
      reused += run.total.reused;
      unmeasured += run.total.unmeasured;
      if (run.total.minSavedTestMs === null) minSavedTestMs = null;
      else if (minSavedTestMs !== null) minSavedTestMs += run.total.minSavedTestMs;
    }
  }
  const reasons = [...offReasons];
  let headline: string;
  if (runs.length === 0) {
    headline = 'per-file reuse: not reported by this round';
  } else if (runs.every((r) => !r.applied)) {
    headline = `per-file reuse off: ${reasons.join(', ')}`;
  } else {
    const saved =
      minSavedTestMs === null
        ? 'test time saved unknown'
        : `at least ${formatDurationMs(minSavedTestMs)} test time saved` +
          (unmeasured > 0 ? ` (${unmeasured} file(s) unmeasured)` : '');
    headline =
      `per-file reuse: ${reused} of ${candidates} candidate file(s) reused, ${saved}` +
      (alarms.length > 0 ? `, ${alarms.length} ALARM(s)` : ', no alarms') +
      (reasons.length > 0 ? `; off for some tasks: ${reasons.join(', ')}` : '');
  }
  return {
    invocations: runs.length,
    candidates,
    reused,
    minSavedTestMs,
    unmeasured,
    alarms,
    offReasons: reasons,
    headline,
  };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Read-side shape check for `gate_health.testPassReuse` (the persisted
 * `TestPassReuseRoundSummary` plus the sha it describes). Never a cast: a blob predating the
 * field, or written by a version that shaped it differently, reads as `null` ("not measured")
 * rather than as a half-populated summary a panel would render as fact.
 */
export interface TestPassReuseHealth extends TestPassReuseRoundSummary {
  /** The sha the round judged. */
  judgedSha: string;
  recordedAtMs: number;
}

export function parseTestPassReuseHealth(value: unknown): TestPassReuseHealth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.judgedSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(v.judgedSha)) return null;
  if (!isCount(v.recordedAtMs)) return null;
  if (!isCount(v.invocations) || !isCount(v.candidates) || !isCount(v.reused) || !isCount(v.unmeasured)) {
    return null;
  }
  if (v.minSavedTestMs !== null && !isCount(v.minSavedTestMs)) return null;
  if (typeof v.headline !== 'string' || v.headline.length === 0) return null;
  if (!Array.isArray(v.offReasons) || !v.offReasons.every((r) => typeof r === 'string')) return null;
  if (!Array.isArray(v.alarms)) return null;
  const alarms: TestPassReuseAlarm[] = [];
  for (const a of v.alarms) {
    if (!a || typeof a !== 'object') return null;
    const { ws, file, proof } = a as Record<string, unknown>;
    if (typeof ws !== 'string' || typeof file !== 'string' || typeof proof !== 'string') return null;
    alarms.push({ ws, file, proof });
  }
  return {
    judgedSha: v.judgedSha,
    recordedAtMs: v.recordedAtMs,
    invocations: v.invocations,
    candidates: v.candidates,
    reused: v.reused,
    minSavedTestMs: v.minSavedTestMs as number | null,
    unmeasured: v.unmeasured,
    alarms,
    offReasons: v.offReasons as string[],
    headline: v.headline,
  };
}
