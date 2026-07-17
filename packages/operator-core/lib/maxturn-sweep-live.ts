/**
 * maxturn-sweep-live — P-024's LIVE cell driver + the pure transcript→metrics
 * extractor (deterministic-context-carry-2026-07-14, WI-5002).
 *
 * Split exactly like residual-carry-pass-live / cold-boot-drill-live: the PURE
 * halves (metrics extraction from a successor transcript, the benchmark kickoff
 * builder) live and unit-test here; the LIVE seams (spawn a real headless psu
 * session, bind/clear the per-session doors override, read the owner transcript)
 * are injectable with real defaults, and NOTHING runs unless runMaxTurnSweep is
 * explicitly `armed` with this driver (D-001 — a sweep that binds overrides on
 * live sessions and spends is opt-in, never a default).
 *
 * HOW A CELL RUNS (makeHeadlessPsuCellDriver):
 *   1. mint a fresh ownerId for the cell repeat (`su-sweep-…`) — PAPERCUSP_SID
 *      lets the spawner pre-pin it, so step 2 can bind BEFORE the first API call;
 *   2. bind the cell's DoorConstantsPatch as that owner's SESSION override
 *      (writeSessionDoorsOverride — the exact store config:doors-set-session
 *      writes, so the live door sites enforce the cell's constants);
 *   3. spawn a HEADLESS psu Claude session with the benchmark kickoff
 *      (psu-launcher --headless --yes --kickoff=…), bounded by taskTimeoutMs;
 *   4. read the owner's native transcript and extract CellRunMetrics from it —
 *      stop_reason=max_tokens rate, spill-chase, hops, cache-read vs fresh input,
 *      compact_boundary count, wall clock, done-marker success;
 *   5. ALWAYS clear the override (finally) — a sweep must never leave a stray
 *      session override behind.
 *
 * The metrics come ENTIRELY from the transcript (verified live 2026-07-16 on a
 * real session: assistant lines carry message.usage + stop_reason; compactions
 * land as type:'system' subtype:'compact_boundary'; result-door spills name their
 * scratch path inline) — no second telemetry join needed for v1.
 *
 * ⚠ CANARY HELD (WI-5075): the carry-respawn kill-loop (adv_sessions never
 * re-anchored after recycleChild) can kill any session the compaction watchdog
 * estimates over-limit — a small-maxTurn sweep cell compacts often and is
 * exactly in the blast radius. Do not run the live canary until WI-5075's fix
 * deploys (blocks-link on the ledger).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  emptyCellMetrics,
  type BenchmarkTask,
  type CellConfig,
  type CellDriver,
  type CellRunMetrics,
  type SweepCell,
} from './maxturn-sweep';
import { writeSessionDoorsOverride, type DoorConstantsPatch } from './context-doors-config';
import { newestTranscriptUnderOwner } from './claude-sessions';

/** The terminal marker the benchmark kickoff instructs the session to print as its
 *  FINAL line when the task is fully complete — the task-success signal the
 *  extractor looks for in ASSISTANT output (never user/kickoff lines). */
export const SWEEP_TASK_DONE_MARKER = '⟦maxturn-sweep:task-done⟧';

/** Per-repeat wall-clock cap. A cell that cannot finish its benchmark inside this
 *  is captured with whatever transcript it produced (metrics still extract). */
export const DEFAULT_SWEEP_TASK_TIMEOUT_MS = 10 * 60_000;

/** Where benchmark sessions do their file work — NEVER the shared repo tree. */
export function sweepWorkDir(cellId: string, base: string = join(homedir(), '.papercusp', 'sweep-bench')): string {
  return join(base, cellId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure half 1 — transcript JSONL → CellRunMetrics
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic reports an output-door stop as stop_reason 'max_tokens'; OpenAI-style
 *  ports use 'length'. Both count as a length-stop. */
const LENGTH_STOP_REASONS = new Set(['max_tokens', 'length']);

/** Matches a result-door spill pointer and captures its scratch path. Kept loose:
 *  the pointer text has evolved; the PATH is the stable join key. */
const SPILL_POINTER_RE = /result-door[^]*?((?:\/[\w.-]+)+\.md)/;

interface AssistantAgg {
  usage: { input: number; cacheRead: number; output: number };
  stopReason: string | null;
  sawDoneMarker: boolean;
}

/**
 * Extract per-cell metrics from a session's native transcript JSONL. PURE.
 * One API call = one hop: assistant lines are deduped by message.id with
 * max-merged usage (a message streams as multiple lines repeating its usage)
 * and last-non-null stop_reason. All-null metrics come back for an empty/
 * unparseable transcript (never fabricated zeros).
 */
export function extractCellMetricsFromJsonl(
  jsonl: string,
  opts: { taskDoneMarker?: string } = {},
): CellRunMetrics {
  const marker = opts.taskDoneMarker ?? SWEEP_TASK_DONE_MARKER;
  const byMsg = new Map<string, AssistantAgg>();
  let anonSeq = 0;
  let compactionCount = 0;
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  // Spill-chase: path → number of DISTINCT lines mentioning it. The pointer line
  // itself is the first; any later mention (the agent paging it back) is a chase.
  const spillLineCounts = new Map<string, number>();

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn line — contributes nothing
    }
    const evt = j as {
      type?: string;
      subtype?: string;
      timestamp?: string;
      message?: { id?: string; model?: string; stop_reason?: string | null; usage?: Record<string, number>; content?: unknown };
    };

    const tsMs = evt.timestamp ? Date.parse(evt.timestamp) : NaN;
    if (Number.isFinite(tsMs)) {
      if (firstTsMs == null || tsMs < firstTsMs) firstTsMs = tsMs;
      if (lastTsMs == null || tsMs > lastTsMs) lastTsMs = tsMs;
    }

    if (evt.type === 'system' && evt.subtype === 'compact_boundary') compactionCount += 1;

    const spill = SPILL_POINTER_RE.exec(line);
    if (spill?.[1]) spillLineCounts.set(spill[1], (spillLineCounts.get(spill[1]) ?? 0) + 1);
    else {
      // A later read of a known spill path (a Read tool call names the path
      // without the 'result-door' text) — count it against every known path it
      // mentions. Bounded: only paths already seen as pointers.
      for (const path of spillLineCounts.keys()) {
        if (line.includes(path)) spillLineCounts.set(path, (spillLineCounts.get(path) ?? 0) + 1);
      }
    }

    if (evt.type !== 'assistant') continue;
    const model = evt.message?.model;
    if (!model || model.startsWith('<')) continue; // synthetic placeholder, not an API call
    const key = evt.message?.id ?? `anon-${anonSeq++}`;
    const agg =
      byMsg.get(key) ?? ({ usage: { input: 0, cacheRead: 0, output: 0 }, stopReason: null, sawDoneMarker: false } satisfies AssistantAgg);
    const u = evt.message?.usage ?? {};
    agg.usage.input = Math.max(agg.usage.input, u.input_tokens ?? 0);
    agg.usage.cacheRead = Math.max(agg.usage.cacheRead, u.cache_read_input_tokens ?? 0);
    agg.usage.output = Math.max(agg.usage.output, u.output_tokens ?? 0);
    if (evt.message?.stop_reason != null) agg.stopReason = evt.message.stop_reason;
    // Task-success marker: assistant CONTENT only (the kickoff/user turn quotes the
    // marker by instruction — scanning it would always false-positive).
    if (JSON.stringify(evt.message?.content ?? '').includes(marker)) agg.sawDoneMarker = true;
    byMsg.set(key, agg);
  }

  const hops = byMsg.size;
  if (hops === 0) return emptyCellMetrics();

  let lengthStops = 0;
  let cacheRead = 0;
  let freshInput = 0;
  let done = false;
  for (const agg of byMsg.values()) {
    if (agg.stopReason && LENGTH_STOP_REASONS.has(agg.stopReason)) lengthStops += 1;
    cacheRead += agg.usage.cacheRead;
    freshInput += agg.usage.input;
    if (agg.sawDoneMarker) done = true;
  }

  const spills = spillLineCounts.size;
  const chased = [...spillLineCounts.values()].filter((n) => n >= 2).length;

  return {
    stopReasonLengthRate: lengthStops / hops,
    spillChaseSuccessRate: spills > 0 ? chased / spills : null,
    hopsPerTask: hops,
    cacheReadInputTokens: cacheRead,
    freshInputTokens: freshInput,
    compactionCount,
    wallClockMs: firstTsMs != null && lastTsMs != null && lastTsMs > firstTsMs ? lastTsMs - firstTsMs : null,
    taskSuccessRate: done ? 1 : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure half 2 — the benchmark kickoff per task kind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The concrete workload text a cell's session is kicked off with. Deliberately
 * FILESYSTEM-ONLY in a per-cell scratch dir — a benchmark session must never
 * touch the shared repo tree, the work-item ledger, or coord. Each kind
 * exercises the door the axis targets (many short hops / big output / big tool
 * results), and every kickoff closes with the done-marker discipline the
 * extractor's taskSuccessRate reads.
 */
export function buildBenchmarkKickoff(task: BenchmarkTask, cell: SweepCell, workDir: string): string {
  const header = [
    `⟦maxturn-sweep:cell:${cell.cellId}⟧ You are running a fixed benchmark workload (a config sweep cell).`,
    `Work ONLY inside ${workDir} — never edit any other directory, never create work items, never message anyone.`,
    '',
  ];
  const footer = [
    '',
    `When the task is FULLY complete, print exactly ${SWEEP_TASK_DONE_MARKER} as your final line and stop.`,
  ];
  const body: string[] = [];
  switch (task.kind) {
    case 'drain-style':
      body.push(
        `There are 12 small independent units. For unit N (1..12): create ${workDir}/unit-N.md containing a`,
        'numbered 10-step checklist for a distinct everyday engineering chore (each unit a different chore),',
        'then verify the file exists by reading it back before moving to the next unit. Do the units one at a',
        'time, in order — many short self-contained steps.',
      );
      break;
    case 'file-heavy-writes':
      body.push(
        `Author 8 substantial files ${workDir}/doc-1.md … doc-8.md. Each must be a coherent ~400-line technical`,
        'design document on a distinct invented subsystem (architecture, data model, failure modes, test plan).',
        'Write each file in full — large outputs are the point of this workload.',
      );
      break;
    case 'long-log-analysis':
      body.push(
        `Read ${workDir}/fixture.log (a long service log). Produce ${workDir}/analysis.md with: the distinct`,
        'error classes and their counts, the time window of the worst error burst, the three noisiest components,',
        'and a root-cause hypothesis per error class citing line numbers. Page through the whole log — large tool',
        'results are the point of this workload.',
      );
      break;
    default:
      body.push(task.summary);
  }
  return [...header, ...body, ...footer].join('\n');
}

/** Generate the long-log fixture the 'long-log-analysis' task reads (~lines lines,
 *  a few recurring error classes with one burst window). Deterministic. */
export function buildLogFixture(lines = 4_000): string {
  const components = ['sync-gateway', 'pg-pool', 'wake-executor', 'vite-dev', 'embedder'];
  const errors = ['ETIMEDOUT upstream', 'pool exhausted', 'schema drift detected', 'socket hang up'];
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const t = new Date(1_784_200_000_000 + i * 1_000).toISOString();
    const comp = components[i % components.length];
    const burst = i >= lines * 0.6 && i < lines * 0.65;
    const isErr = burst ? i % 2 === 0 : i % 37 === 0;
    out.push(
      isErr
        ? `${t} ERROR [${comp}] ${errors[i % errors.length]} (req=${i})`
        : `${t} INFO  [${comp}] tick ok latency=${(i % 90) + 5}ms`,
    );
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE driver (injectable seams; defaults are the real bindings)
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepSpawnInput {
  ownerId: string;
  kickoff: string;
  workDir: string;
  cellId: string;
  timeoutMs: number;
}

export interface HeadlessCellDriverDeps {
  /** Mint the repeat's fresh ownerId (default `su-sweep-<cell>-<nonce>`). */
  mintOwnerId?: (cell: SweepCell, repeat: number) => string;
  /** Bind the cell patch as the owner's session doors override (default: the real
   *  writeSessionDoorsOverride — the exact store the door sites resolve). */
  bindOverride?: (ownerId: string, patch: DoorConstantsPatch, cellId: string) => Promise<void>;
  /** ALWAYS called (finally) — drop the owner's override. */
  clearOverride?: (ownerId: string) => Promise<void>;
  /** Prepare the cell's scratch dir (default: mkdir -p + the long-log fixture for
   *  the long-log-analysis kind). */
  prepareWorkDir?: (workDir: string, cell: SweepCell) => Promise<void>;
  /** Run the session to completion (resolve when it exits / times out). Default:
   *  `node apps/operator/scripts/psu-launcher.mjs --agent=claude --headless --yes --kickoff=…`
   *  with PAPERCUSP_SID=<ownerId>, killed at timeoutMs. */
  spawnSession?: (input: SweepSpawnInput) => Promise<void>;
  /** Read the owner's native transcript JSONL (default: newestTranscriptUnderOwner + read). */
  readTranscript?: (ownerId: string) => Promise<string | null>;
  /** Per-repeat wall-clock cap (default DEFAULT_SWEEP_TASK_TIMEOUT_MS). */
  taskTimeoutMs?: number;
  /** Repo root for the default spawner (default: process.cwd()). */
  repoRoot?: string;
}

function defaultMintOwnerId(cell: SweepCell, repeat: number): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `su-sweep-${cell.cellId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}-r${repeat}-${nonce}`;
}

async function defaultBindOverride(ownerId: string, patch: DoorConstantsPatch, cellId: string): Promise<void> {
  await writeSessionDoorsOverride(ownerId, {
    overrides: patch,
    setBy: 'maxturn-sweep-live',
    provenance: `P-024 sweep cell ${cellId}`,
  });
}

async function defaultClearOverride(ownerId: string): Promise<void> {
  await writeSessionDoorsOverride(ownerId, null);
}

async function defaultPrepareWorkDir(workDir: string, cell: SweepCell): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  if (cell.taskKind === 'long-log-analysis') {
    await fs.writeFile(join(workDir, 'fixture.log'), buildLogFixture(), 'utf8');
  }
}

/** The real headless spawn. Resolves on exit; kills the child at timeoutMs (the
 *  transcript written so far still extracts). Never rejects on a non-zero exit —
 *  the transcript is the verdict, not the exit code. */
async function defaultSpawnSession(input: SweepSpawnInput, repoRoot: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = nodeSpawn(
      'node',
      [
        join(repoRoot, 'apps/operator/scripts/psu-launcher.mjs'),
        // --agent is REQUIRED by psu-launcher (it exits immediately with a usage error
        // otherwise) — caught by the WI-5002 live canary: the cell died in 262ms with
        // "no transcript" because this arg was missing and stdio:'ignore' hid the message.
        '--agent=claude',
        '--headless',
        '--yes',
        `--kickoff=${input.kickoff}`,
      ],
      {
        cwd: input.workDir,
        env: { ...process.env, PAPERCUSP_SID: input.ownerId },
        stdio: 'ignore',
        detached: false,
      },
    );
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, input.timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function defaultReadTranscript(ownerId: string): Promise<string | null> {
  const path = newestTranscriptUnderOwner(ownerId);
  if (!path) return null;
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function meanOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

/** Aggregate per-repeat extracts into the cell's CellRunMetrics (mean per metric,
 *  nulls excluded per-metric — one failed repeat never nulls the cell). */
export function aggregateRepeatMetrics(repeats: CellRunMetrics[]): CellRunMetrics {
  if (repeats.length === 0) return emptyCellMetrics();
  return {
    stopReasonLengthRate: meanOrNull(repeats.map((r) => r.stopReasonLengthRate)),
    spillChaseSuccessRate: meanOrNull(repeats.map((r) => r.spillChaseSuccessRate)),
    hopsPerTask: meanOrNull(repeats.map((r) => r.hopsPerTask)),
    cacheReadInputTokens: meanOrNull(repeats.map((r) => r.cacheReadInputTokens)),
    freshInputTokens: meanOrNull(repeats.map((r) => r.freshInputTokens)),
    compactionCount: meanOrNull(repeats.map((r) => r.compactionCount)),
    wallClockMs: meanOrNull(repeats.map((r) => r.wallClockMs)),
    taskSuccessRate: meanOrNull(repeats.map((r) => r.taskSuccessRate)),
  };
}

/**
 * Build the P-024 CellDriver over headless psu sessions. Every seam injectable;
 * the returned driver binds→spawns→extracts→clears per repeat and aggregates.
 * A repeat whose transcript is unreadable throws (runMaxTurnSweep captures it as
 * that cell's status:'error' and moves on — its fail-soft contract).
 */
export function makeHeadlessPsuCellDriver(deps: HeadlessCellDriverDeps = {}): CellDriver {
  const mint = deps.mintOwnerId ?? defaultMintOwnerId;
  const bind = deps.bindOverride ?? defaultBindOverride;
  const clear = deps.clearOverride ?? defaultClearOverride;
  const prepare = deps.prepareWorkDir ?? defaultPrepareWorkDir;
  const readTranscript = deps.readTranscript ?? defaultReadTranscript;
  const timeoutMs = deps.taskTimeoutMs ?? DEFAULT_SWEEP_TASK_TIMEOUT_MS;
  const repoRoot = deps.repoRoot ?? process.cwd();
  const spawnSession = deps.spawnSession ?? ((input: SweepSpawnInput) => defaultSpawnSession(input, repoRoot));

  return async (cell: SweepCell, config: CellConfig, opts: { repeats: number }) => {
    const task: BenchmarkTask = { id: cell.taskId, kind: cell.taskKind, summary: '' };
    const perRepeat: CellRunMetrics[] = [];
    for (let repeat = 1; repeat <= Math.max(1, opts.repeats); repeat += 1) {
      const ownerId = mint(cell, repeat);
      const workDir = sweepWorkDir(`${cell.cellId}-r${repeat}`);
      await bind(ownerId, config.patch, cell.cellId);
      try {
        await prepare(workDir, cell);
        const kickoff = buildBenchmarkKickoff(task, cell, workDir);
        await spawnSession({ ownerId, kickoff, workDir, cellId: cell.cellId, timeoutMs });
        const jsonl = await readTranscript(ownerId);
        if (jsonl == null) throw new Error(`sweep repeat ${repeat}: no transcript under ${ownerId}`);
        perRepeat.push(extractCellMetricsFromJsonl(jsonl));
      } finally {
        await clear(ownerId).catch(() => {
          /* best-effort — never mask the run error, but never leave silently either */
          console.warn(`[maxturn-sweep-live] failed to clear session doors override for ${ownerId}`);
        });
      }
    }
    return aggregateRepeatMetrics(perRepeat);
  };
}
