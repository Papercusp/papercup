/**
 * capability:bash_output — read incremental output from a background shell job
 * started by `capability:bash` (run_in_background). Mirrors the native
 * BashOutput tool: each call returns the output produced SINCE the last read
 * (use `peek` to read without advancing the cursor) plus the job's status.
 * Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { z } from 'zod';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getJob, readJobOutput, scratchDir } from './bash-jobs';

/** Tail this many bytes of a stranded job's log when the in-memory registry
 *  missed but the file survived on disk (EI-8855). */
export const STRANDED_LOG_TAIL_BYTES = 8_000;

/**
 * EI-8855: the in-memory job registry (bash-jobs.ts) assumes "the operator is one
 * long-lived process" — false on a shared dev box where a DIFFERENT agent's
 * routine `systemctl --user restart papercup-*-api.service` (a common, documented
 * workflow — see repo-conventions § two-port model) kills the WHOLE service cgroup,
 * wiping every in-flight capability:bash background job's registry entry AND the
 * job's own child process in one shot. The caller then sees a bare "unknown_bash_id"
 * indistinguishable from a typo'd id or a truly-vanished job. Since the log path is
 * DETERMINISTIC from `stateDir` + `bash_id` (no registry needed), we can check
 * whether that file exists on disk even after the in-memory entry is gone, and
 * report the REAL diagnosis (stranded by a restart, not "wrong id") plus the
 * output the job DID produce before it died — instead of a dead end.
 *
 * EI-18666279107998059: also returns the log file's `birthtimeMs` (creation time,
 * a proxy for the job's own start time) so the caller can tell a genuine operator
 * restart apart from the job's OWN process dying independently — see
 * `diagnoseStrandedCause`. */
export function strandedJobLookup(
  bashId: string,
  stateDir: string | undefined,
): { logPath: string; sizeBytes: number; tail: string; birthtimeMs: number } | null {
  const logPath = join(scratchDir(stateDir), `bash-${bashId}.log`);
  try {
    const st = statSync(logPath);
    if (!st.isFile()) return null;
    const fd = readFileSync(logPath, 'utf8');
    const tail = fd.length > STRANDED_LOG_TAIL_BYTES ? fd.slice(-STRANDED_LOG_TAIL_BYTES) : fd;
    return { logPath, sizeBytes: st.size, tail, birthtimeMs: st.birthtimeMs };
  } catch {
    return null;
  }
}

/**
 * EI-18666279107998059: decide WHICH of the two known causes actually explains a
 * stranded job, instead of asserting the more dramatic one ("the operator
 * restarted") as fact with no evidence check (the EI-16635 bug this superseded —
 * confirmed live: a job's tracking went stranded while `dev:service_health` showed
 * zero restarts, so the true cause was the job's OWN process dying independently).
 *
 * The check is simple and needs no extra I/O: THIS operator process's own
 * `process.uptime()` tells us exactly when it started. If it started AFTER the
 * job's log file was created, the operator must have restarted at some point
 * after the job began running — a restart is CONFIRMED. If this process has been
 * running continuously since before the job started, a restart is IMPOSSIBLE
 * (this very process would not exist to answer the call), so the job's own
 * process must have died independently.
 */
export function diagnoseStrandedCause(opts: {
  jobBirthtimeMs: number;
  /** Defaults to the real `process.uptime()` — injectable for deterministic tests. */
  processUptimeMs?: number;
  /** Defaults to `Date.now()` — injectable for deterministic tests. */
  now?: number;
}): 'stranded_by_operator_restart' | 'job_process_gone' {
  const now = opts.now ?? Date.now();
  const processUptimeMs = opts.processUptimeMs ?? process.uptime() * 1000;
  const processStartedAtMs = now - processUptimeMs;
  return processStartedAtMs > opts.jobBirthtimeMs ? 'stranded_by_operator_restart' : 'job_process_gone';
}

/** Max length of an agent-supplied `filter` regex (ReDoS surface bound). */
const MAX_FILTER_LEN = 200;

/**
 * Heuristic for a catastrophic-backtracking (ReDoS) pattern: a quantified GROUP
 * whose body itself contains a quantifier — `(a+)+`, `(.*)*`, `(a{2,})+`, `(.+){8}`.
 * This is the classic nested-quantifier signature; it runs in the shared OPERATOR
 * process, where a hang would block every concurrent agent's MCP calls, so we
 * reject rather than risk it. Approximate (not a full safe-regex analysis) but it
 * covers the common exponential-blowup classes.
 */
function isLikelyCatastrophicRegex(re: string): boolean {
  return /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(re);
}

/**
 * Apply the native-BashOutput `filter` regex to an output chunk: keep only the
 * LINES matching `filter` (the caller advances the cursor over the full chunk
 * regardless, so non-matching lines aren't re-shown). Never throws or hangs: an
 * invalid OR ReDoS-prone OR over-long regex returns the unfiltered chunk plus an
 * `error` note (the filter runs in the shared operator process, so an
 * agent-supplied pattern must not be able to wedge it). Exported pure for
 * deterministic unit testing (no subprocess).
 */
export function filterOutputLines(chunk: string, filter: string | undefined): { output: string; error?: string } {
  if (!filter) return { output: chunk };
  if (filter.length > MAX_FILTER_LEN) {
    return { output: chunk, error: `filter regex too long (>${MAX_FILTER_LEN} chars) — returning unfiltered output` };
  }
  if (isLikelyCatastrophicRegex(filter)) {
    return { output: chunk, error: 'filter regex rejected (ReDoS-prone nested quantifier) — returning unfiltered output' };
  }
  try {
    const re = new RegExp(filter);
    return { output: chunk.split('\n').filter((line) => re.test(line)).join('\n') };
  } catch (err) {
    return { output: chunk, error: `invalid filter regex (${err instanceof Error ? err.message : String(err)}) — returning unfiltered output` };
  }
}

export default defineTool({
  name: 'capability:bash_output',
  description:
    'Read new output from a background shell job (started by capability:bash run_in_background:true). Returns output since the last read plus status (running/completed/failed/…) and exit code.',
  guidance: {
    when: 'Poll a background job started by capability:bash. Call repeatedly to drain output as it runs; the final call after status leaves "running" gives the tail + exit code.',
    notWhen:
      'For a foreground command — its output is in the capability:bash result directly. Note: a miss reporting `reason: "stranded_by_operator_restart"` or `"job_process_gone"` (with a log tail) means the job\'s in-memory tracking is gone while its log survived; the tool already checked this operator process\'s own uptime against the job\'s age to tell the two causes apart (EI-18666279107998059), so the reason IS the confirmed cause, not a guess — it is not a wrong id, just re-run capability:bash rather than treating it as a tool bug.',
    chaining: 'capability:bash { run_in_background:true } → capability:bash_output { bash_id } (repeat) → capability:bash_kill to stop early.',
    seeAlso: [
      'capability:bash (start the command)',
      'capability:bash_kill (kill the backgrounded run)',
    ],
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    bash_id: z.string().min(1).describe('The id returned by capability:bash (run_in_background).'),
    filter: z
      .string()
      .optional()
      .describe(
        'Regex; only output LINES matching it are returned (the read cursor still advances past ALL output, matching or not). Mirrors the native BashOutput filter.',
      ),
    peek: z.boolean().optional().describe('Read without advancing the read cursor (default false).'),
  }),
  async handler(args, ctx) {
    const job = getJob(args.bash_id);
    if (!job) {
      const stranded = strandedJobLookup(args.bash_id, ctx.stateDir);
      if (stranded) {
        // EI-18666279107998059: EI-16635 stopped ASSERTING the restart cause as fact
        // but still couldn't tell the two causes apart, so every stranded job read
        // "here are two possible causes, go check yourself" even when this very
        // process's own uptime already proves which one it was (see
        // diagnoseStrandedCause). Do that check now and report the CONFIRMED cause.
        const cause = diagnoseStrandedCause({ jobBirthtimeMs: stranded.birthtimeMs });
        const advice =
          cause === 'stranded_by_operator_restart'
            ? 'This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process\'s own uptime is SHORTER than the job\'s age — CONFIRMED: the operator process that ran it restarted or was killed mid-job. A routine, common event on a shared dev box: any agent restarting :3070/:3170 kills every OTHER agent\'s in-flight background jobs too (repo-conventions § two-port model). It is NOT a wrong bash_id and not a bug in your command. Re-run capability:bash if you still need the result; check output_tail below for how far it got before dying.'
            : 'This job STARTED (its log file exists on disk) but its in-memory tracking is gone, and this operator process has been running continuously since BEFORE the job started (its uptime exceeds the job\'s age) — so an operator restart is IMPOSSIBLE and CONFIRMED NOT the cause. The job\'s OWN process died independently (e.g. an OS-sandbox lifetime constraint — EI-16635). It is NOT a wrong bash_id and not necessarily a bug in your command. Re-run capability:bash if you still need the result; check output_tail below for how far it got before dying.';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: cause,
                advice,
                log_path: stranded.logPath,
                total_bytes_written: stranded.sizeBytes,
                output_tail: stranded.tail,
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: 'unknown_bash_id',
              advice: 'No such background job (it may have been pruned, or the id is wrong). Re-run with capability:bash.',
            }),
          },
        ],
        isError: true,
      };
    }
    // Cursor advances over the FULL chunk (matching native BashOutput); the filter
    // only narrows what's RETURNED, so non-matching lines aren't re-shown next read.
    const fullChunk = readJobOutput(job, args.peek ?? false);
    const { output, error: filterError } = filterOutputLines(fullChunk, args.filter);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            status: job.status,
            exit_code: job.exitCode,
            running: job.status === 'running',
            total_bytes: job.totalBytes,
            log_path: job.logPath,
            ...(filterError ? { filter_error: filterError } : {}),
            output,
          }),
        },
      ],
    };
  },
});
