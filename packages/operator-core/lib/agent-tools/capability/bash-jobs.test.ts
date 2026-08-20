/**
 * Unit tests for the bash capability core (P-010, B-05). Exercises the real
 * shell (no PG, no mocks): foreground run + output streaming, output-spill to a
 * log, wall-clock timeout, abort, and the background job lifecycle
 * (start → incremental read → completion / kill).
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_SANDBOX_TMPDIR,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  INLINE_OUTPUT_CAP,
  JOB_LOG_END_MARKER_PREFIX,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PC_HEAVY_SLOT_ACQUIRED_MARKER,
  __resetBashJobs,
  createStreamingSecretRedactor,
  detectBufferingLastStage,
  detectMissingCommandDiagnostic,
  formatBufferingPipelineAdvice,
  formatJobLogEndMarker,
  getJob,
  killJob,
  readJobOutput,
  runForeground,
  startBackground,
} from './bash-jobs';

const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-'));
const never = new AbortController().signal;

afterEach(() => __resetBashJobs());

async function waitForStatus(id: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const j = getJob(id);
    if (j && j.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runForeground', () => {
  it('captures stdout + exit code and streams chunks', async () => {
    const chunks: string[] = [];
    const r = await runForeground(
      { command: 'echo hello-world', cwd: STATE, stateDir: STATE, onChunk: (c) => chunks.push(c) },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello-world');
    expect(chunks.join('')).toContain('hello-world');
  });

  it('captures stderr and a non-zero exit', async () => {
    const r = await runForeground({ command: 'echo oops >&2; exit 3', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe('failed');
    expect(r.output).toContain('oops');
  });

  it("a failing command piped through a truncating filter (tail) reports the PIPELINE exit code, not the filter's (EI-13414)", async () => {
    // Without `-o pipefail`, bash reports the LAST command's exit status for a
    // pipe — `exit 1 | tail -60` would report 0 (tail always succeeds), silently
    // masking the real failure. This is the exact near-miss that filed EI-13414:
    // `npm run test:affected 2>&1 | tail -60` reported exit 0 while the runner
    // had actually failed.
    const r = await runForeground(
      { command: 'echo "1 non-quarantined task(s) failed" >&2; exit 1 | tail -60', cwd: STATE, stateDir: STATE },
      never,
      10_000,
    );
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe('failed');
  });

  it('a successful pipeline still reports exit 0 (pipefail does not false-positive on a clean pipe)', async () => {
    const r = await runForeground({ command: 'echo hello | tail -1', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe('completed');
  });

  it('fails loudly when a missing command is hidden inside a successful outer pipeline', async () => {
    // `pipefail` cannot see a command-substitution failure when the command
    // consuming its output exits 0. The raw shell diagnostic is still decisive:
    // do not let a missing tool become a false-green capability result.
    const r = await runForeground(
      {
        command: `printf '%s\\n' "$(papercusp-command-that-is-not-installed)" | head -1`,
        cwd: STATE,
        stateDir: STATE,
      },
      never,
      10_000,
    );
    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('papercusp-command-that-is-not-installed: command not found');
  });

  it('recognizes Bash and POSIX missing-command diagnostics without assuming a host path', () => {
    expect(detectMissingCommandDiagnostic('/bin/bash: line 1: rg: command not found\n')).toEqual({
      command: 'rg',
      line: '/bin/bash: line 1: rg: command not found',
    });
    expect(detectMissingCommandDiagnostic('sh: rg: not found\n')).toEqual({
      command: 'rg',
      line: 'sh: rg: not found',
    });
    expect(detectMissingCommandDiagnostic('command completed\n')).toBeNull();
  });

  it('spills large output to a log file and trims the inline result', async () => {
    const r = await runForeground(
      {
        command: 'for i in $(seq 1 4000); do echo "line-$i padding padding padding padding"; done',
        cwd: STATE,
        stateDir: STATE,
      },
      never,
      20_000,
    );
    expect(r.status).toBe('completed');
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(INLINE_OUTPUT_CAP + 200);
    expect(existsSync(r.logPath)).toBe(true);
    const full = readFileSync(r.logPath, 'utf8');
    expect(full.length).toBeGreaterThan(INLINE_OUTPUT_CAP);
    expect(full).toContain('line-4000');
  });

  it('enforces the wall-clock timeout', async () => {
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, never, 300);
    expect(r.status).toBe('timed_out');
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
    expect(r.status).toBe('killed');
  });
});

describe('integration credential output redaction (EI-20478240377353884)', () => {
  const secret = 'integration-test-secret-0123456789';

  it('redacts a secret split across arbitrary child-process chunks', () => {
    const redactor = createStreamingSecretRedactor([secret])!;
    const safe = [
      redactor.push(`before:${secret.slice(0, 7)}`),
      redactor.push(secret.slice(7, 21)),
      redactor.push(`${secret.slice(21)}:after`),
      redactor.flush(),
    ].join('');

    expect(safe).toBe('before:[REDACTED integration credential]:after');
    expect(safe).not.toContain(secret);
    expect(safe).not.toContain(secret.slice(0, 21));
  });

  it('chooses a replacement marker that cannot reproduce a short saved secret', () => {
    const collidingSecret = 'REDACTED';
    const redactor = createStreamingSecretRedactor([collidingSecret])!;
    const safe = redactor.push(`before:${collidingSecret}:after`) + redactor.flush();

    expect(safe).toMatch(/^before:.+:after$/);
    expect(safe).not.toContain(collidingSecret);
  });

  it('redacts foreground result, stream events, and the spill log through one shared boundary', async () => {
    const streamed: string[] = [];
    const r = await runForeground(
      {
        command: 'printf "prefix:%s:suffix" "$EI_INTEGRATION_SECRET"',
        cwd: STATE,
        stateDir: STATE,
        env: { EI_INTEGRATION_SECRET: secret },
        redactValues: [secret],
        onChunk: (chunk) => streamed.push(chunk),
      },
      never,
      10_000,
    );
    const spill = readFileSync(r.logPath, 'utf8');

    expect(r.output).toContain('prefix:[REDACTED integration credential]:suffix');
    expect(streamed.join('')).toContain('prefix:[REDACTED integration credential]:suffix');
    expect(spill).toContain('prefix:[REDACTED integration credential]:suffix');
    for (const surface of [r.output, streamed.join(''), spill]) {
      expect(surface).not.toContain(secret);
    }
  });

  it('redacts background retained output and the durable spill log', async () => {
    const job = startBackground(
      {
        command: 'printf "%s" "$EI_INTEGRATION_SECRET"',
        cwd: STATE,
        stateDir: STATE,
        env: { EI_INTEGRATION_SECRET: secret },
        redactValues: [secret],
      },
      10_000,
    );
    await waitForStatus(job.id);
    const output = readJobOutput(getJob(job.id)!);
    const spill = readFileSync(job.logPath, 'utf8');

    expect(output).toContain('[REDACTED integration credential]');
    expect(spill).toContain('[REDACTED integration credential]');
    expect(output).not.toContain(secret);
    expect(spill).not.toContain(secret);
  });
});

describe('background jobs', () => {
  it('runs, exposes incremental output, and reaches a terminal status', async () => {
    const job = startBackground({ command: 'echo first; sleep 0.2; echo second', cwd: STATE, stateDir: STATE }, 10_000);
    expect(job.status).toBe('running');
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    const out = readJobOutput(final);
    expect(out).toContain('first');
    expect(out).toContain('second');
    // Cursor advanced — a second read returns nothing new.
    expect(readJobOutput(final)).toBe('');
  });

  it('kills a running job', async () => {
    const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
    expect(job.status).toBe('running');
    const r = killJob(job);
    expect(r.alreadyDone).toBe(false);
    expect(job.status).toBe('killed');
  });

  it('reports unknown ids as undefined', () => {
    expect(getJob('does-not-exist')).toBeUndefined();
  });
});

// EI-18764990059061608: a background job's log FILE must be self-describing about
// completion, because a caller can (and, per the filed bug, did) `cat`/Read it
// directly instead of calling capability:bash_output — where an empty file mid-run
// is byte-identical to a completed job that genuinely produced nothing.
describe('terminal log marker (EI-18764990059061608)', () => {
  it('formatJobLogEndMarker names status, exit code, and timestamp, and starts with the shared prefix', () => {
    const line = formatJobLogEndMarker('completed', 0, Date.UTC(2026, 0, 1));
    expect(line).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(line).toContain('status=completed');
    expect(line).toContain('exit=0');
    expect(line).toContain('2026-01-01');
  });

  it('formats a null exit code (spawn error / not yet observed) as the literal "null"', () => {
    expect(formatJobLogEndMarker('failed', null, Date.now())).toContain('exit=null');
  });

  it('a background job that produces NO output still leaves the marker in its log file', async () => {
    const job = startBackground({ command: 'true', cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    const logContent = readFileSync(final.logPath, 'utf8');
    // Without the marker this file would be EMPTY — indistinguishable from a job
    // that has not finished writing anything yet. This is the exact ambiguity the
    // filed bug hit.
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=completed');
    expect(logContent).toContain('exit=0');
  });

  it('a RUNNING background job has NOT written the marker yet', async () => {
    const job = startBackground({ command: 'sleep 5', cwd: STATE, stateDir: STATE }, 10_000);
    expect(job.status).toBe('running');
    // createWriteStream opens the fd asynchronously — the file may not exist on
    // disk yet at this exact instant. Absence-of-file is itself "no marker yet",
    // same as an existing-but-empty (or not-yet-marker-bearing) file.
    const logContent = existsSync(job.logPath) ? readFileSync(job.logPath, 'utf8') : '';
    expect(logContent).not.toContain(JOB_LOG_END_MARKER_PREFIX);
    killJob(job);
  });

  it('a failed background job (spawn error) still gets the marker via the error path', async () => {
    const job = startBackground({ command: 'exit 7', cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('failed');
    const logContent = readFileSync(final.logPath, 'utf8');
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=failed');
    expect(logContent).toContain('exit=7');
  });

  it('a foreground run writes the marker to the log FILE but NOT into the returned `output`', async () => {
    const r = await runForeground({ command: 'true', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.status).toBe('completed');
    // Exact-equality callers elsewhere (e.g. the EI-1617 secrets test) depend on
    // `output` carrying ONLY the command's own stdout/stderr — the marker must
    // never leak into it.
    expect(r.output).not.toContain(JOB_LOG_END_MARKER_PREFIX);
    const logContent = readFileSync(r.logPath, 'utf8');
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=completed');
  });
});

describe('detectBufferingLastStage (EI-19915289191989412)', () => {
  it('detects tail as the last pipeline stage', () => {
    expect(detectBufferingLastStage('npx vitest run 2>&1 | tail -45')).toBe('tail');
  });

  it('detects head, sort, uniq, wc as the last stage', () => {
    expect(detectBufferingLastStage('cmd | head -20')).toBe('head');
    expect(detectBufferingLastStage('cmd | sort')).toBe('sort');
    expect(detectBufferingLastStage('cmd | uniq -c')).toBe('uniq');
    expect(detectBufferingLastStage('cmd | wc -l')).toBe('wc');
  });

  it('returns null for a command with no pipe at all', () => {
    expect(detectBufferingLastStage('npm run build')).toBeNull();
  });

  it('returns null when the last stage is a streaming filter, not a buffering one', () => {
    // grep/cat/sed stream line-by-line; only the LAST stage matters for whether
    // the pipeline as a whole withholds output until exit.
    expect(detectBufferingLastStage('cmd | tail -45 | grep ERROR')).toBeNull();
    expect(detectBufferingLastStage('cmd 2>&1 | grep -i fail')).toBeNull();
  });

  it('looks only at the LAST stage — an early tail followed by a streaming stage is not flagged', () => {
    expect(detectBufferingLastStage('cmd | tail -f | cat')).toBeNull();
  });

  it('resolves a full path to its basename', () => {
    expect(detectBufferingLastStage('cmd | /usr/bin/tail -n 20')).toBe('tail');
  });

  it('skips a leading inline env assignment on the last stage', () => {
    expect(detectBufferingLastStage('cmd | LC_ALL=C sort')).toBe('sort');
  });

  it('does not split on `||` (logical OR), only real pipes', () => {
    expect(detectBufferingLastStage('cmd1 || cmd2')).toBeNull();
  });

  it('ignores a `|` inside a quoted argument', () => {
    expect(detectBufferingLastStage("echo 'a|b' | grep a")).toBeNull();
  });
});

describe('formatBufferingPipelineAdvice (EI-20039247609786797)', () => {
  it('launch advice names file redirection when tracking could be lost', () => {
    const advice = formatBufferingPipelineAdvice('tail', 'launch');
    expect(advice).toContain('If tracking is lost');
    expect(advice).toContain('JOB END marker may never be written');
    expect(advice).toContain('redirect output to a file you own');
    expect(advice).toContain('cmd > /tmp/job.log 2>&1');
  });

  it('tracking-loss advice does not tell callers to keep polling buffered output', () => {
    const advice = formatBufferingPipelineAdvice('tail', 'tracking-lost');
    expect(advice).toContain('do not keep polling for growing output');
    expect(advice).toContain('Read `log_path` directly');
    expect(advice).toContain('redirect output to a file you own');
    expect(advice).not.toContain('Keep polling capability:bash_output');
  });
});

describe('TMPDIR is normalized to a sandbox-writable dir (EI-5912)', () => {
  it('overrides an inherited ephemeral TMPDIR so the child gets an existing temp dir', async () => {
    const prev = process.env.TMPDIR;
    // The ephemeral pattern the Claude harness sets — absent inside the fresh sandbox /tmp.
    process.env.TMPDIR = '/tmp/claude/nonexistent-run-xyz';
    try {
      const r = await runForeground(
        { command: 'printf "T=%s|X=%s|E=%s" "$TMPDIR" "$TMP" "$TEMP"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.output).toContain(`T=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`X=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`E=${CAPABILITY_SANDBOX_TMPDIR}`);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });

  it('a caller-supplied env.TMPDIR still wins (explicit override)', async () => {
    const r = await runForeground(
      { command: 'printf "%s" "$TMPDIR"', cwd: STATE, stateDir: STATE, env: { TMPDIR: STATE } },
      never,
      10_000,
    );
    expect(r.output).toContain(STATE);
  });
});

describe('operator secrets are NOT inherited by a spawned command (EI-1617)', () => {
  it('a fake operator secret in process.env never reaches the child shell', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user:pw@host/db-should-not-leak';
    try {
      const r = await runForeground(
        { command: 'printf "[%s]"  "${DATABASE_URL:-unset}"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toBe('[unset]');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('a plain allowlisted var (PATH) still reaches the child', async () => {
    const r = await runForeground(
      { command: 'test -n "$PATH" && echo has-path', cwd: STATE, stateDir: STATE },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.output).toContain('has-path');
  });
});

describe('PAPERCUSP_OPERATOR_URL inheritance', () => {
  it('rewrites an inherited direct operator URL through the resilient proxy when configured', async () => {
    const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    try {
      const r = await runForeground(
        { command: 'printf "%s" "$PAPERCUSP_OPERATOR_URL"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toContain('http://127.0.0.1:9071/api/mcp');
    } finally {
      if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
      else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
    }
  });

  it('leaves explicit per-call env overrides intact', async () => {
    const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    try {
      const r = await runForeground(
        {
          command: 'printf "%s" "$PAPERCUSP_OPERATOR_URL"',
          cwd: STATE,
          stateDir: STATE,
          env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9999/api/mcp' },
        },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toContain('http://127.0.0.1:9999/api/mcp');
    } finally {
      if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
      else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
    }
  });
});

describe('process-group kill — no orphaned descendants (capability-bash-orphan-kill-2026-06-21)', () => {
  // A timed-out / aborted / killed command MUST take its descendants with it.
  // Before the detached-process-group fix, the kill hit only the `bash -c` parent;
  // its children (e.g. a runaway ugrep) orphaned to init and kept running at full
  // CPU — the 58-min search that starved the operator event loop → :3070 wedge.
  // Proof: a GRANDCHILD that would `touch` a marker AFTER the kill deadline must
  // never get the chance to create it.
  let markerSeq = 0;
  // `( sleep 3; touch <marker> ) &` is a subshell grandchild of the operator; the
  // outer `wait` keeps bash alive until the kill. With the group fix the grandchild
  // dies with the group; without it, it orphans, sleeps, and creates the marker.
  const grandchildCmd = (marker: string): string => `( sleep 3; touch ${marker} ) & echo started; wait`;
  // EI-10982: this used to sample the marker exactly ONCE at a fixed 3500ms
  // offset — well past the grandchild's 3s delay under an idle box, but a real
  // race against host load: on a shared box running many concurrent vitest
  // workers, the kill's actual effect (signal delivery/scheduling, and for
  // killJob specifically the SIGTERM->SIGKILL grace-period escalation) can be
  // pushed out far enough that a genuinely-about-to-be-killed process still
  // wins the race against a single fixed-offset sample. Poll for the marker
  // instead of sampling once, over a bound generous enough to absorb that
  // load-induced skew (comfortably past the grandchild's 3s delay plus
  // killJob's 2s escalation grace period plus OS reap latency) — a real orphan
  // still fails fast (the loop breaks the moment the marker appears), and a
  // correctly-killed process is given real headroom to prove it stays dead
  // rather than being raced against the clock.
  async function expectNoOrphanMarker(run: (marker: string) => Promise<unknown>): Promise<void> {
    const marker = join(STATE, `orphan-${markerSeq++}.marker`);
    await run(marker);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(existsSync(marker)).toBe(false);
  }

  it('foreground timeout kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, never, 300);
      expect(r.status).toBe('timed_out');
    });
  }, 15_000);

  it('foreground abort kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
      expect(r.status).toBe('killed');
    });
  }, 15_000);

  it('killJob kills the background grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const job = startBackground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, 60_000);
      expect(job.status).toBe('running');
      killJob(job);
    });
  }, 15_000);
});

/**
 * WI-6677 — a BACKGROUND job's deadline is its own, and reaching it is survivable
 * enough for the job's cleanup to run.
 *
 * The bug these guard: `run_in_background` inherited the FOREGROUND default (120s)
 * and ceiling (600s), so the tool SIGKILLed precisely the long jobs it exists to
 * host — the exact duration CLAUDE.md tells agents to background at. The SIGKILL
 * then skipped every `trap`/`finally`, leaking whatever the job was mid-way through
 * building (a 489MB checkout in one case, a 4.9GB deb extract in another).
 */
describe('background job deadlines (WI-6677)', () => {
  async function waitForEnd(id: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (getJob(id)?.endedAt != null) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('a background job is NOT bound by the foreground pair — its default outlives a foreground call and its ceiling can host a real suite', () => {
    // Stated as an invariant rather than a literal so re-tuning the durations stays
    // free, while re-pointing background back at the foreground constants (the
    // regression) fails here instead of silently in production hours later.
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(MAX_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(MAX_TIMEOUT_MS);
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBeLessThanOrEqual(MAX_BACKGROUND_TIMEOUT_MS);
    // The green-checkpoint suite in this repo runs ~55 min; a ceiling under that
    // cannot host the longest job anyone would legitimately background.
    expect(MAX_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(60 * 60 * 1_000);
  });

  it('records the effective deadline on the job so the caller can be told it up front', () => {
    const job = startBackground({ command: 'sleep 60', cwd: STATE, stateDir: STATE }, 45_000);
    expect(job.timeoutMs).toBe(45_000);
    expect(job.deadlineAt).toBeGreaterThanOrEqual(job.startedAt + 45_000 - 50);
    killJob(job);
  });

  it('clamps to the BACKGROUND ceiling, not the foreground one', () => {
    const job = startBackground({ command: 'sleep 60', cwd: STATE, stateDir: STATE }, MAX_BACKGROUND_TIMEOUT_MS * 10);
    expect(job.timeoutMs).toBe(MAX_BACKGROUND_TIMEOUT_MS);
    killJob(job);
  });

  it("⭐ hitting the deadline SIGTERMs first, so the job's own cleanup trap still runs (it used to SIGKILL and leak)", async () => {
    const marker = join(STATE, `cleanup-ran-${Date.now()}`);
    const job = startBackground(
      {
        command: `trap 'echo cleaned > ${marker}; exit 143' TERM; echo working; sleep 30`,
        cwd: STATE,
        stateDir: STATE,
      },
      400,
    );
    await waitForEnd(job.id);
    expect(job.status).toBe('timed_out');
    // The whole point: a SIGKILLed job cannot leave this behind.
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('cleaned');
  }, 30_000);

  it("⭐ says WHY it died, in the job output — a silent death reads as an OOM or a peer's pkill", async () => {
    const job = startBackground({ command: 'echo working; sleep 30', cwd: STATE, stateDir: STATE }, 400);
    await waitForEnd(job.id);
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(out).toContain('400ms');
    // The explanation is on disk too, so it survives loss of the in-memory registry.
    expect(readFileSync(job.logPath, 'utf8')).toContain('deadline reached');
  }, 30_000);

  /**
   * EI-19315037905600226 — "deadline reached" alone conflates two very different
   * deaths: killed mid-execution vs. killed while still QUEUED behind pc-heavy's
   * semaphore (a job's own wall-clock deadline is not exempt from that wait). The
   * deadline handler greps the job's own output for pc-heavy's slot-acquired
   * landmark to tell them apart whenever the answer is knowable.
   */
  it('⭐ says the job likely died QUEUED (never acquired a pc-heavy slot) when its output never showed the marker', async () => {
    // No pc-heavy involved at all here — just proves the hint fires whenever the
    // marker is absent, which is the honest, best-effort signal (the hint itself
    // is worded conditionally: "if it runs through scripts/pc-heavy.sh").
    const job = startBackground({ command: 'echo working; sleep 30', cwd: STATE, stateDir: STATE }, 400);
    await waitForEnd(job.id);
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(out).toContain('never showed pc-heavy\'s "slot acquired" marker');
    expect(out).toContain('most likely died QUEUED');
  }, 30_000);

  it("⭐ omits the queued hint once the job's output shows the pc-heavy slot-acquired marker — it really was mid-execution", async () => {
    const job = startBackground(
      { command: `echo '${PC_HEAVY_SLOT_ACQUIRED_MARKER}'; sleep 30`, cwd: STATE, stateDir: STATE },
      400,
    );
    await waitForEnd(job.id);
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(out).not.toContain('most likely died QUEUED');
  }, 30_000);
});
