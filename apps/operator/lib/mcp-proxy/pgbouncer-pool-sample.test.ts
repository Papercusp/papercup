import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Types come from pgbouncer-pool-sample.d.mts — without it this import is an implicit `any`
// (TS7016) and every assertion below silently stops type-checking (see watchdog.test.ts for
// the identical rationale — this module is plain .mjs on purpose, imported by a bare-`node`
// systemd entrypoint, so it cannot become TypeScript).
type PoolSample = typeof import('./pgbouncer-pool-sample.mjs');
let buildShowPoolsArgs: PoolSample['buildShowPoolsArgs'];
let buildPgActivityArgs: PoolSample['buildPgActivityArgs'];
let samplePgBouncerPools: PoolSample['samplePgBouncerPools'];
let _resetSampleDebounceForTests: PoolSample['_resetSampleDebounceForTests'];
let SAMPLE_LOG_FILE: PoolSample['SAMPLE_LOG_FILE'];
let MIN_SAMPLE_INTERVAL_MS: PoolSample['MIN_SAMPLE_INTERVAL_MS'];

let tmpHome: string;

function writePsqlOutput(args: string[], output: string) {
  const path = args[args.indexOf('--output') + 1];
  expect(path).toBeTruthy();
  writeFileSync(path, output);
}

function activityOutput(groups: Array<Record<string, unknown>>) {
  const sessions = (kind?: string) => groups.reduce((n, g) =>
    n + (!kind || g.backend_type === kind ? Number(g.sessions ?? 1) : 0), 0);
  return [JSON.stringify({ kind: 'census', totalGroups: groups.length, totalSessions: sessions(),
    clientBackends: sessions('client backend'), parallelWorkers: sessions('parallel worker') }),
  ...groups.map((g) => JSON.stringify(g))].join('\n') + '\n';
}

beforeAll(async () => {
  // Redirect the sampler's log file into a scratch dir BEFORE importing the module, since the
  // log path is resolved once at module load from PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG.
  tmpHome = mkdtempSync(join(tmpdir(), 'pgbouncer-pool-sample-test-'));
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG = join(tmpHome, 'samples.log');
  ({ buildShowPoolsArgs, buildPgActivityArgs, samplePgBouncerPools, _resetSampleDebounceForTests, SAMPLE_LOG_FILE, MIN_SAMPLE_INTERVAL_MS } =
    await import('./pgbouncer-pool-sample.mjs'));
});

beforeEach(() => {
  _resetSampleDebounceForTests();
});

afterEach(() => {
  try {
    rmSync(SAMPLE_LOG_FILE, { force: true });
    rmSync(`${SAMPLE_LOG_FILE}.1`, { force: true });
    rmSync(`${SAMPLE_LOG_FILE}.captures`, { recursive: true, force: true });
  } catch {
    /* fine if it was never written this test */
  }
});

afterAll(() => rmSync(tmpHome, { recursive: true, force: true }));

describe('pgbouncer pool sampler — buildShowPoolsArgs (EI-19384024494946006)', () => {
  it('queries SHOW POOLS + SHOW STATS against the admin virtual database, as the admin user', () => {
    const args = buildShowPoolsArgs({ host: '127.0.0.1', port: 6432, user: 'harness_admin' });
    expect(args).toEqual(['-h', '127.0.0.1', '-p', '6432', '-U', 'harness_admin', '-d', 'pgbouncer', '-At', '-c', 'SHOW POOLS;', '-c', 'SHOW STATS;']);
  });

  it('defaults to the box-standard admin console coordinates when no override is given', () => {
    const args = buildShowPoolsArgs();
    // -d pgbouncer (never an app database — the admin console is a separate virtual DB)
    expect(args).toContain('pgbouncer');
    expect(args).toContain('SHOW POOLS;');
    expect(args).toContain('SHOW STATS;');
  });
});

describe('pgbouncer pool sampler — samplePgBouncerPools (EI-19384024494946006)', () => {
  it('builds a bounded direct activity query and skips a URL that points at PgBouncer', () => {
    const direct = buildPgActivityArgs({ connectionString: 'postgresql://harness_admin:secret@127.0.0.1:5432/papercusp' });
    expect(direct.unavailable).toBeUndefined();
    if (!direct.args) throw new Error(`expected direct activity args, got unavailable=${direct.unavailable}`);
    expect(direct.args.join(' ')).toContain('pg_stat_activity');
    expect(direct.args.join(' ')).not.toMatch(/\bLIMIT\b/i);
    expect(direct.args.join(' ')).toContain('backend_type');
    expect(direct.args.join(' ')).toContain('leader_pid');
    expect(direct.args.join(' ')).not.toMatch(/\bquery\b/i);
    expect(direct.env).toMatchObject({
      PGPASSWORD: 'secret',
      PGAPPNAME: 'papercusp-native-session-diagnostic',
      PGOPTIONS: expect.stringContaining('statement_timeout=750'),
    });

    expect(buildPgActivityArgs({
      connectionString: 'postgresql://harness_admin:secret@127.0.0.1:6432/papercusp',
      pgbouncerPort: 6432,
    })).toMatchObject({ unavailable: 'admin-database-endpoint-is-pgbouncer' });
  });

  it('starts bounded PgBouncer and activity captures, records aligned timings, and redacts connection credentials', async () => {
    const calls: unknown[] = [];
    let clock = 1_000_000;
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ cmd, args, options });
      writePsqlOutput(args, args.includes('pgbouncer')
        ? 'pool output here'
        : activityOutput([{ application_name: 'papercusp:api', wait_event_type: 'Lock', sessions: 1,
          backend_type: 'client backend', leader_pid: null }]));
      cb(null, '', '');
    };

    const result = await samplePgBouncerPools('test-reason', {
      execFileImpl,
      now: () => (clock += 100),
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
      requestFingerprint: '0123456789abcdef',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('pool output here');
    expect(result.pgActivity).toMatchObject({ ok: true, output: expect.stringContaining('wait_event_type') });
    expect(calls).toHaveLength(2);
    const poolCall = calls[0] as { cmd: string; args: string[]; options: Record<string, unknown> };
    const activityCall = calls[1] as { cmd: string; args: string[]; options: Record<string, unknown> };
    expect(poolCall.cmd).toBe('psql');
    expect(poolCall.args.slice(2)).toEqual(buildShowPoolsArgs());
    expect(poolCall.options.env).toMatchObject({ PGPASSWORD: expect.any(String) });
    expect(poolCall.options.timeout).toBeGreaterThan(0);
    expect(poolCall.options.killSignal).toBe('SIGKILL');
    expect(activityCall.cmd).toBe('psql');
    expect(activityCall.args.join(' ')).toContain('pg_stat_activity');
    expect(activityCall.options.env).toMatchObject({ PGPASSWORD: 'test-secret' });
    expect(activityCall.options.timeout).toBeLessThanOrEqual(1_500);
    expect(activityCall.options.maxBuffer).toBeLessThanOrEqual(32 * 1024);
    expect(activityCall.options.killSignal).toBe('SIGKILL');

    const logged = readFileSync(SAMPLE_LOG_FILE, 'utf8');
    expect(logged).toContain('reason=test-reason');
    expect(logged).toContain('pid=');
    expect(logged).toContain('requestFingerprint=0123456789abcdef');
    expect(logged).toContain('startedAt=1970-01-01T00:16:40.200Z');
    expect(logged).toContain('completedAt=1970-01-01T00:16:40.300Z');
    expect(logged).toMatch(/durationMs=\d+/);
    expect(logged).toContain('pool output here');
    expect(logged).toContain('pgActivityStartedAt=1970-01-01T00:16:40.400Z');
    expect(logged).toContain('pgActivityCompletedAt=1970-01-01T00:16:40.500Z');
    expect(logged).toContain('wait_event_type');
    expect(logged).not.toContain('test-secret');
  });

  it('never throws when psql errors — logs the error and reports ok:false', async () => {
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      cb(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6432'), { message: 'connect ECONNREFUSED 127.0.0.1:6432' }), '', 'connection refused');
    };

    const result = await samplePgBouncerPools('test-error', {
      execFileImpl,
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    const logged = readFileSync(SAMPLE_LOG_FILE, 'utf8');
    expect(logged).toContain('reason=test-error');
    expect(logged).toContain('ERROR:');
  });

  it('never throws when execFileImpl itself throws synchronously', async () => {
    const execFileImpl = () => {
      throw new Error('boom — broken test double / spawn failure');
    };
    await expect(samplePgBouncerPools('test-sync-throw', {
      execFileImpl,
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
    })).resolves.toMatchObject({ ok: false });
  });

  it('debounces repeat calls within MIN_SAMPLE_INTERVAL_MS — a burst of onsets samples once', async () => {
    let calls = 0;
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      calls += 1;
      writePsqlOutput(args, args.includes('pgbouncer') ? 'output' : activityOutput([]));
      cb(null, '', '');
    };
    let clock = 1_000_000;
    const now = () => clock;

    const opts = { execFileImpl, now, activityConnectionString: 'postgresql://harness_admin:secret@127.0.0.1:5432/papercusp' };
    const first = await samplePgBouncerPools('onset-a', opts);
    expect(first.skipped).toBeUndefined();
    expect(calls).toBe(2);

    clock += 1_000; // well inside the debounce window
    const second = await samplePgBouncerPools('onset-b', opts);
    expect(second.skipped).toBe('debounced');
    expect(calls).toBe(2); // the debounced call spawns neither snapshot

    clock += MIN_SAMPLE_INTERVAL_MS + 1; // past the debounce window
    const third = await samplePgBouncerPools('onset-c', opts);
    expect(third.skipped).toBeUndefined();
    expect(calls).toBe(4);
  });

  it('keeps PgBouncer capture working when a direct activity endpoint is unavailable', async () => {
    const calls: unknown[] = [];
    const execFileImpl = (
      cmd: string,
      args: string[],
      _options: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ cmd, args });
      writePsqlOutput(args, 'pool output here');
      cb(null, '', '');
    };
    const result = await samplePgBouncerPools('pool-only', { execFileImpl, activityConnectionString: null });

    expect(result.ok).toBe(true);
    expect(result.pgActivity).toMatchObject({ ok: false, skipped: 'no-admin-database-endpoint' });
    expect(calls).toHaveLength(1);
    expect(readFileSync(SAMPLE_LOG_FILE, 'utf8')).toContain('SKIPPED: no-admin-database-endpoint');
  });

  it.each([23, 24, 25])('retains all %i groups, including the final group, through the consumer recovery path', async (count) => {
    const groups = Array.from({ length: count }, (_, i) => ({ application_name: `app-${i}`,
      sessions: 1, backend_type: i === count - 1 ? 'parallel worker' : 'client backend',
      leader_pid: i === count - 1 ? 12345 : null }));
    const execFileImpl: NonNullable<Parameters<typeof samplePgBouncerPools>[1]>['execFileImpl'] = (_cmd, args, _opts, cb) => {
      writePsqlOutput(args, args.includes('pgbouncer') ? 'pool\n' : activityOutput(groups));
      cb(null, '', '');
    };
    const result = await samplePgBouncerPools('boundary', { execFileImpl,
      activityConnectionString: 'postgresql://test@127.0.0.1:5432/test' });
    expect(result.pgActivity).toMatchObject({ ok: true, shownGroups: count, omittedGroups: 0,
      census: { totalGroups: count, clientBackends: count - 1, parallelWorkers: 1 } });
    const source = result.pgActivity!.outputSource!;
    expect(source.complete).toBe(true);
    const recovered = readFileSync(source.path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(recovered.slice(1)).toEqual(groups);
    expect(recovered.at(-1)).toMatchObject({ leader_pid: 12345, backend_type: 'parallel worker' });
  });

  it.each([16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1])('never cuts a record at the %i-byte preview boundary', async (bytes) => {
    const full = 'x'.repeat(bytes - 1) + '\n';
    const execFileImpl: NonNullable<Parameters<typeof samplePgBouncerPools>[1]>['execFileImpl'] = (_cmd, args, _opts, cb) => {
      writePsqlOutput(args, full);
      cb(null, '', '');
    };
    const result = await samplePgBouncerPools('bytes', { execFileImpl, activityConnectionString: null });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(bytes <= 16 * 1024 ? full : '');
    expect(result.outputOmittedBytes).toBe(bytes <= 16 * 1024 ? 0 : bytes);
    expect(result.outputSource).toMatchObject({ bytes, complete: true });
    expect(readFileSync(result.outputSource!.path, 'utf8')).toBe(full);
  });

  it('recovers every group beyond both output bounds from the log reference, across samples, permutations and restarts', async () => {
    const base = Array.from({ length: 500 }, (_, i) => ({ application_name: `app-${i}-λ`, sessions: 1,
      backend_type: 'client backend', leader_pid: null }));
    const sources: string[] = [];
    const summaries: string[] = [];
    for (let batch = 0; batch < 6; batch += 1) {
      _resetSampleDebounceForTests(); // fresh process-local state must not overwrite prior sources
      const groups = [...base.slice(batch), ...base.slice(0, batch)];
      const full = activityOutput(groups);
      expect(Buffer.byteLength(full)).toBeGreaterThan(32 * 1024);
      const execFileImpl: NonNullable<Parameters<typeof samplePgBouncerPools>[1]>['execFileImpl'] = (_cmd, args, opts, cb) => {
        expect(opts.maxBuffer).toBe(32 * 1024); // output bypasses this pipe bound via psql --output
        writePsqlOutput(args, args.includes('pgbouncer') ? 'pool\n' : full);
        cb(null, '', '');
      };
      // Force repeated summary rotations; full captures remain recoverable.
      writeFileSync(SAMPLE_LOG_FILE, 'x'.repeat(4 * 1024 * 1024));
      const result = await samplePgBouncerPools('overflow', { execFileImpl,
        activityConnectionString: 'postgresql://test@127.0.0.1:5432/test' });
      expect(result.pgActivity!.ok).toBe(true);
      expect(result.pgActivity!.omittedGroups).toBeGreaterThan(0);
      expect(result.pgActivity!.shownGroups! + result.pgActivity!.omittedGroups!).toBe(500);
      expect(result.pgActivity!.output).toMatch(/\n$/);
      result.pgActivity!.output!.trimEnd().split('\n').forEach((line) => expect(() => JSON.parse(line)).not.toThrow());
      const log = readFileSync(SAMPLE_LOG_FILE, 'utf8');
      const match = /PG_STAT_ACTIVITY:\nSOURCE: (\{[^\n]+\}) omittedPreviewBytes=/.exec(log);
      expect(match).not.toBeNull();
      const ref = JSON.parse(match![1]);
      expect(ref.complete).toBe(true);
      expect(readFileSync(ref.path, 'utf8')).toBe(full);
      expect(JSON.parse(readFileSync(ref.path, 'utf8').trimEnd().split('\n').at(-1)!)).toEqual(groups.at(-1));
      sources.push(ref.path);
      summaries.push(result.captureRef!);
    }
    expect(new Set(sources).size).toBe(6);
    for (const path of sources) expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(501);
    for (const path of summaries) expect(readFileSync(path, 'utf8')).toContain('CENSUS:');
  });

  it('marks timed-out captures incomplete and preserves stderr beyond its display preview', async () => {
    const stderr = 'failure detail '.repeat(500);
    const execFileImpl: NonNullable<Parameters<typeof samplePgBouncerPools>[1]>['execFileImpl'] = (_cmd, args, _opts, cb) => {
      writePsqlOutput(args, activityOutput([]));
      cb(new Error('psql timed out'), '', stderr);
    };
    const result = await samplePgBouncerPools('timeout', { execFileImpl,
      activityConnectionString: 'postgresql://test@127.0.0.1:5432/test' });
    expect(result.pgActivity).toMatchObject({ ok: false, outputSource: { complete: false },
      census: null, omittedGroups: null, stderrOmittedChars: stderr.length - 4000 });
    expect(readFileSync(result.pgActivity!.stderrSource!.path, 'utf8')).toBe(stderr);
    expect(readFileSync(result.captureRef!, 'utf8')).toContain('"complete":false');
  });

  const retainedSources = (text: string): Array<{ path: string; bytes: number; complete: boolean }> =>
    [...text.matchAll(/^RETAINED_SUMMARY_SOURCE: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  const legacyFrame = (marker: string, bytes: number) => {
    const frame = `\n[pgbouncer-sample 2026-11-15T21:14:48.707Z] reason=${marker} pid=2434077\nPGBOUNCER:\nλ decisive final row\n\n`;
    return 'x'.repeat(bytes - Buffer.byteLength(frame)) + frame;
  };
  const poolOnly: NonNullable<Parameters<typeof samplePgBouncerPools>[1]>['execFileImpl'] = (_cmd, args, _opts, cb) => {
    writePsqlOutput(args, 'pool\n');
    cb(null, '', '');
  };

  it.each([-1, 0, 1])('preserves legacy sources at the log rotation boundary N%+i', async (delta) => {
    const opts = { execFileImpl: poolOnly, activityConnectionString: null, now: () => 1_000_000 };
    const baseline = await samplePgBouncerPools('legacy-boundary', opts);
    const lineBytes = statSync(baseline.captureRef!).size;
    const old = legacyFrame('legacy-current', 4 * 1024 * 1024 - lineBytes + delta);
    const previous = legacyFrame('legacy-previous', 256);
    writeFileSync(SAMPLE_LOG_FILE, old);
    writeFileSync(`${SAMPLE_LOG_FILE}.1`, previous);
    _resetSampleDebounceForTests();
    const result = await samplePgBouncerPools('legacy-boundary', opts);
    expect(result.ok).toBe(true);
    const refs = retainedSources(readFileSync(result.captureRef!, 'utf8'));
    expect(refs).toHaveLength(delta > 0 ? 2 : 0);
    if (delta > 0) {
      expect(refs.map((ref) => readFileSync(ref.path, 'utf8'))).toEqual([previous, old]);
      for (const ref of refs) expect(ref).toMatchObject({ complete: true, bytes: statSync(ref.path).size });
      expect(existsSync(`${SAMPLE_LOG_FILE}.1`)).toBe(false);
      expect(retainedSources(readFileSync(SAMPLE_LOG_FILE, 'utf8'))).toEqual(refs);
    } else {
      expect(readFileSync(`${SAMPLE_LOG_FILE}.1`, 'utf8')).toBe(previous);
      expect(readFileSync(SAMPLE_LOG_FILE, 'utf8').startsWith(old)).toBe(true);
      expect(statSync(SAMPLE_LOG_FILE).size).toBe(4 * 1024 * 1024 + delta);
    }
  });

  it.each([false, true])('recovers mixed legacy and modern frames after repeated rotations and restarts (reverse=%s)', async (reverse) => {
    const originals = new Map<string, string>();
    const markers = Array.from({ length: 8 }, (_, i) => `legacy-batch-${i}`);
    if (reverse) markers.reverse();
    const previous = legacyFrame('first-previous', 256);
    writeFileSync(`${SAMPLE_LOG_FILE}.1`, previous);
    let priorSummary = '';
    for (const marker of markers) {
      // Reset process-local state just as a restarted watchdog would. Carry the
      // last recovery chain into a mixed-format source, with the decisive legacy
      // frame after the rotation boundary.
      _resetSampleDebounceForTests();
      const old = priorSummary + legacyFrame(marker, 4 * 1024 * 1024 + 1);
      writeFileSync(SAMPLE_LOG_FILE, old);
      const result = await samplePgBouncerPools(marker, { execFileImpl: poolOnly, activityConnectionString: null });
      expect(result.ok).toBe(true);
      const summary = readFileSync(result.captureRef!, 'utf8');
      const refs = retainedSources(summary);
      expect(refs).toHaveLength(priorSummary ? 1 : 2);
      for (const ref of refs) originals.set(ref.path, ref.path.endsWith('retained-previous.log') ? previous : old);
      priorSummary = summary;
    }
    // Consumer follows the references from the current view, rather than relying
    // on a directory scan or assuming old frames have modern SOURCE fields.
    const recovered = new Map<string, string>();
    const follow = (text: string) => {
      for (const ref of retainedSources(text)) {
        if (recovered.has(ref.path)) continue;
        const source = readFileSync(ref.path, 'utf8');
        expect(Buffer.byteLength(source)).toBe(ref.bytes);
        expect(ref.complete).toBe(true);
        recovered.set(ref.path, source);
        follow(source);
      }
    };
    follow(readFileSync(SAMPLE_LOG_FILE, 'utf8'));
    expect(recovered).toEqual(originals);
    for (const marker of markers) expect([...recovered.values()].some((text) => text.includes(`reason=${marker} pid=2434077`))).toBe(true);
    expect([...recovered.values()]).toContain(previous);
  });

  it.each(['retained-previous.log', 'retained-current.log'])('keeps original sources when preserving %s fails, then recovers on the next sample', async (blockedName) => {
    const old = legacyFrame('unmoved-current', 4 * 1024 * 1024 + 1);
    const previous = legacyFrame('unmoved-previous', 256);
    writeFileSync(SAMPLE_LOG_FILE, old);
    writeFileSync(`${SAMPLE_LOG_FILE}.1`, previous);
    const result = await samplePgBouncerPools('preservation-failure', {
      execFileImpl: (_cmd, args, _opts, cb) => {
        // A destination collision reproduces a real filesystem rename failure.
        mkdirSync(join(dirname(args[args.indexOf('--output') + 1]), blockedName));
        writePsqlOutput(args, 'pool\n');
        cb(null, '', '');
      },
      activityConnectionString: null,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('sample log retention failed:') });
    if (blockedName === 'retained-previous.log') expect(readFileSync(`${SAMPLE_LOG_FILE}.1`, 'utf8')).toBe(previous);
    else {
      const preserved = retainedSources(readFileSync(result.captureRef!, 'utf8'));
      expect(preserved).toHaveLength(1);
      expect(readFileSync(preserved[0].path, 'utf8')).toBe(previous);
    }
    expect(readFileSync(SAMPLE_LOG_FILE, 'utf8').startsWith(old)).toBe(true);
    expect(readFileSync(result.captureRef!, 'utf8')).toContain('reason=preservation-failure');
    expect(readFileSync(result.captureRef!, 'utf8')).toContain('RETENTION_ERROR:');
    _resetSampleDebounceForTests();
    const retry = await samplePgBouncerPools('preservation-recovery', { execFileImpl: poolOnly, activityConnectionString: null });
    expect(retry.ok).toBe(true);
    const refs = retainedSources(readFileSync(retry.captureRef!, 'utf8'));
    expect(refs).toHaveLength(blockedName === 'retained-previous.log' ? 2 : 1);
    if (blockedName === 'retained-previous.log') expect(readFileSync(refs[0].path, 'utf8')).toBe(previous);
    const recoveredCurrent = readFileSync(refs.at(-1)!.path, 'utf8');
    expect(recoveredCurrent.startsWith(old)).toBe(true);
    if (blockedName === 'retained-current.log') {
      const preserved = retainedSources(recoveredCurrent);
      expect(preserved).toHaveLength(1);
      expect(readFileSync(preserved[0].path, 'utf8')).toBe(previous);
    }
  });
});
