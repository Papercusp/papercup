/** P-011: matched resources and decoded-query evidence in the maintained private API route.
 * This measures one request-only host, not the production six-worker/background cohort.
 * Allocation samples and completed query bytes do not prove a retained-state owner.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_MALLOC_ARENA_MAX } from '../../../apps/operator/bin/malloc-arena-reexec';

const root = resolve(__dirname, '../../..');

// Buffer complete startup lines: stderr chunks can split an endpoint, and an
// in-place exec keeps the PID while replacing its ephemeral inspector listener.
function inspectorEndpoints(output: string): string[] {
  return [...output.matchAll(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/gm)]
    .map(match => match[1]);
}

function readCohortReport(path: string, result: {
  status: number | null; signal: string | null; stdout: string; stderr: string; error?: Error;
}) {
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
    incomplete: true, phase: 'runner-before-report', samples: [], windows: [], error: 'Private report was not written',
  };
  report.runner = { status: result.status, signal: result.signal, error: result.error?.message,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') };
  return report;
}

describe.skipIf(process.platform !== 'linux')('P-011 private request-host memory cohort', () => {
  it('preserves the complete report when subprocess stdout exceeds its bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-report-preflight-'));
    const path = join(dir, 'report.json');
    try {
      const result = spawnSync(process.execPath, ['-e',
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ incomplete: false, phase: 'samples-complete', samples: [1] })); process.stdout.write('x'.repeat(1024 * 1024));", path],
      { encoding: 'utf8', maxBuffer: 1024, timeout: 5000 });
      const report = readCohortReport(path, result);
      expect(report.runner.errorCode).toBe('ENOBUFS');
      expect(report.runner.stdoutBytes).toBeGreaterThan(0);
      expect(report).toMatchObject({ incomplete: false, phase: 'samples-complete', samples: [1] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds the replacement inspector after allocator re-exec, even across split startup chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-inspector-preflight-'));
    const entry = join(dir, 'serve.mjs');
    const env = { ...process.env };
    delete env.MALLOC_ARENA_MAX;
    delete env.GLIBC_TUNABLES;
    writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(resolve(root, 'apps/operator/bin/boot-malloc-arena.ts')).href)};\n` +
      'console.log(JSON.stringify({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX }));\n' +
      'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--import', 'tsx', entry], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startup = '', stdout = '', client: any;
    child.stderr.on('data', chunk => { startup += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes('\n') && Date.now() < deadline && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const identity = JSON.parse(stdout.trim());
      expect(identity, startup).toEqual({ pid: child.pid, cap: HOST_MALLOC_ARENA_MAX });
      const endpoints = inspectorEndpoints(startup);
      expect(endpoints, startup).toHaveLength(2);
      expect(endpoints[0]).not.toBe(endpoints[1]);
      expect(inspectorEndpoints(startup.slice(0, startup.indexOf(endpoints[0]) + 12))).toEqual([]);
      const { createCdpClient } = await import('../../../scripts/cdp-inspector.mjs');
      const stale = createCdpClient(endpoints[0]);
      try { await expect(stale.connect()).rejects.toThrow(); } finally { stale.close(); }
      client = createCdpClient(endpoints.at(-1));
      await client.connect();
      const measured = await client.evaluate('({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX })', { returnByValue: true });
      expect(measured.result.value).toEqual(identity);
      console.log('P011_INSPECTOR_PREFLIGHT ' + JSON.stringify({ pid: child.pid, endpoints,
        staleEndpointRejected: true, servingPidBound: true, arenaMax: identity.cap }));
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
      child.stdout.destroy(); child.stderr.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('binds matched PSS/heap/native samples and bounded query bytes to the serving PID, then reaps it', async () => {
    // Read the maintained desktop transport contract before bundle/DB work.
    // The separate device route supports only its curated mobile query names.
    const queryRoute = (await import('./endpoint-route/routes/zero-harness/rest-query')).default;
    expect(queryRoute.auth).toBe('loopback');
    const queryPath = '/api' + queryRoute.path;
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-memory-cohort-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    const reportPath = join(bundleRoot, 'cohort-report.json');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = String.raw`
      const { spawn } = require('node:child_process');
      const { readFileSync, writeFileSync, renameSync } = require('node:fs');
      const { pathToFileURL } = require('node:url');
      const path = require('node:path');
      const postgres = require('postgres');
      const inspectorEndpoints = ${inspectorEndpoints.toString()};
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const e = process.env, base = e.PAPERCUSP_OPERATOR_URL;
      const report = { schemaVersion: 1, plane: 'isolated-current-build-operator-api', incomplete: true,
        buildSha: e.TEST_BUILD_SHA, bundleHash: e.TEST_BUNDLE_HASH, startedAt: new Date().toISOString(),
        workload: { population: 1024, pageLimit: 128, windows: 3, requestsPerWindow: 8, concurrency: 8 },
        samples: [], windows: [], phases: [], limitations: [
          'One owned request-only process; background, production workers and fleet workloads are not measured.',
          'Sampling selfSize is live sampled allocation, not total heap or a retained-state owner.',
          'Completed-result diagnostic bytes are PostgreSQL wire bytes, not HTTP, payload storage or retained heap.',
          'Inspector sampling and forced GC are labeled diagnostic interventions, not ordinary production operation.'
        ] };
      let host, cdp, sql, inspectorUrl, sampling = false;
      let errors = '', startup = '';
      const publish = () => {
        // Complete reports grow with samples. Persist atomically outside the
        // disposable runtime home; stdout is a progress channel, not storage.
        writeFileSync(e.TEST_REPORT_PATH + '.next', JSON.stringify(report));
        renameSync(e.TEST_REPORT_PATH + '.next', e.TEST_REPORT_PATH);
        console.error('P011_MEMORY_PROGRESS ' + JSON.stringify({ phase: report.phase,
          samples: report.samples.length, windows: report.windows.length, incomplete: report.incomplete }));
      };
      const phase = label => {
        report.phase = label; report.phases.push({ label, at: new Date().toISOString() });
        console.error('P011_PHASE ' + label); publish();
      };
      const call = async (route, method = 'GET', body) => {
        const response = await fetch(base + route, { method,
          headers: { 'content-type': 'application/json', 'x-papercusp-workspace': e.PAPERCUSP_WORKSPACE_ID },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.status !== 200) {
          let error;
          try { const value = JSON.parse(bytes.toString()); error = value.error?.code ?? value.error ?? value.code; }
          catch { error = 'non-JSON response'; }
          report.httpFailure = { route, method, status: response.status, error: String(error).slice(0, 500) };
          throw new Error(route + ' HTTP ' + response.status + ': ' + report.httpFailure.error);
        }
        return { body: JSON.parse(bytes.toString()), bytes: bytes.length };
      };
      const descendants = pid => {
        const result = [];
        const visit = current => {
          const text = readFileSync('/proc/' + current + '/task/' + current + '/children', 'utf8').trim();
          for (const child of text ? text.split(/\s+/).map(Number) : []) { result.push(child); visit(child); }
        };
        visit(pid); return result;
      };
      const osMemory = pid => {
        const rollup = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const kb = name => {
          const match = rollup.match(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm'));
          if (!match) throw new Error('Missing ' + name + ' for PID ' + pid);
          return Number(match[1]) * 1024;
        };
        return { pid, pssBytes: kb('Pss'), rssBytes: kb('Rss'), anonymousBytes: kb('Anonymous') };
      };
      const sample = async label => {
        const started = Date.now();
        const result = await cdp.evaluate('(' + function inspectorSample() {
          const slots = globalThis[Symbol.for('@papercusp/module-singleton.slots')];
          const state = slots?.get('@papercusp/db-org.acquire-registry')?.value;
          if (!state) throw new Error('Completed-query registry is unobserved');
          return { pid: process.pid, memory: process.memoryUsage(), uptime: process.uptime(),
            pools: [...state.pools].map(([pool, value]) => ({ pool,
              totalRecorded: value.totalPgResults ?? 0,
              results: (value.pgResults ?? []).map(row => ({ source: row.source,
                queryFamily: row.queryFamily, connectionId: row.connectionId, queryId: row.queryId,
                rowCount: row.rowCount, wireBytes: row.wireBytes, elapsedMs: row.elapsedMs,
                status: row.status, recordedAt: row.recordedAt })) })) };
        }.toString() + ')()', { returnByValue: true });
        const value = result.result.value;
        if (value.pid !== host.pid) throw new Error('Inspector PID mismatch');
        const pids = [host.pid, ...descendants(host.pid)];
        const measured = { label, at: new Date().toISOString(), observerMs: Date.now() - started,
          ...value, processes: pids.map(osMemory) };
        report.samples.push(measured); publish(); return measured;
      };
      const allocationSummary = profile => {
        const totals = new Map();
        const walk = node => {
          const frame = node.callFrame;
          const key = (frame.functionName || '(anonymous)') + '@' + path.basename(frame.url || '') + ':' + frame.lineNumber;
          totals.set(key, (totals.get(key) || 0) + node.selfSize);
          for (const child of node.children || []) walk(child);
        };
        walk(profile.head);
        return { sampledLiveBytes: [...totals.values()].reduce((a, b) => a + b, 0),
          top: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([frame, bytes]) => ({ frame, bytes })) };
      };
      (async () => {
        phase('private-profile-preflight');
        if (e.PAPERCUSP_BACKGROUND_WORKERS !== '0' || !e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'))
          throw new Error('Private operator-api profile required');
        sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
        const identity = (await sql.unsafe('select current_database() as database'))[0];
        const schema = (await sql.unsafe('select filename, sha256, applied_at from harness_shared.schema_migrations order by applied_at desc limit 1'))[0];
        report.database = identity.database; report.schema = schema;
        if (!schema?.filename || !/^[a-f0-9]{64}$/.test(schema.sha256)) throw new Error('Migration identity unmeasured');
        phase('fixture-preflight');
        await sql.unsafe('insert into harness_shared.work_items (workspace_id,harness_slug,feature_id,title,summary,status,kind,payload,created_ts,updated_ts) ' +
          "select $1,$2,'WI-P011-' || g,'P011 fixture ' || g,repeat('controlled-summary-',128),'open','issue'," +
          "jsonb_build_object('_ei',jsonb_build_object('severity','minor'),'controlled',repeat('payload-',512)),g,g from generate_series(1,1024) g",
          [e.PAPERCUSP_WORKSPACE_ID, e.PAPERCUSP_POT_HOME_SLUG]);
        const population = (await sql.unsafe('select count(*)::int as n from harness_shared.work_items where workspace_id=$1 and harness_slug=$2',
          [e.PAPERCUSP_WORKSPACE_ID, e.PAPERCUSP_POT_HOME_SLUG]))[0].n;
        if (population !== report.workload.population) throw new Error('Private fixture population mismatch');
        await sql.end(); sql = null;
        phase('host-launch');
        // Match the maintained launchers and avoid paying a second module load.
        // Latest-endpoint selection still protects callers that need a re-exec.
        report.arenaMax = e.MALLOC_ARENA_MAX || e.TEST_MALLOC_ARENA_MAX;
        host = spawn(process.execPath, ['--inspect=127.0.0.1:0', e.TEST_BUNDLE_PATH], {
          cwd: path.join(process.cwd(), 'apps/operator'), env: { ...e, MALLOC_ARENA_MAX: report.arenaMax },
          stdio: ['ignore', 'pipe', 'pipe'] });
        report.pid = host.pid;
        for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => {
          const text = chunk.toString(); errors = (errors + text).slice(-3000);
          if (stream === host.stderr) {
            startup = (startup + text).slice(-32768);
            const endpoints = inspectorEndpoints(startup);
            if (endpoints.length) {
              report.inspectorEndpoints = endpoints;
              inspectorUrl = endpoints[endpoints.length - 1];
            }
          }
        });
        const deadline = Date.now() + 150000;
        let ready = false;
        while (Date.now() < deadline) {
          if (host.exitCode !== null || host.signalCode !== null) throw new Error('Owned host exited');
          try { const response = await call('/api/health/ready'); if (response.body.ready && inspectorUrl) { ready = true; break; } }
          catch {} await wait(500);
        }
        if (!ready) throw new Error('Owned host readiness failed');
        phase('inspector-owner-preflight');
        const { createCdpClient } = await import(pathToFileURL(path.join(process.cwd(), 'scripts/cdp-inspector.mjs')));
        cdp = createCdpClient(inspectorUrl); await cdp.connect();
        const owner = (await cdp.evaluate('({ pid: process.pid, entry: process.argv[1], arenaMax: process.env.MALLOC_ARENA_MAX })',
          { returnByValue: true })).result.value;
        report.inspector = { endpoint: inspectorUrl, ...owner };
        if (owner.pid !== host.pid || owner.entry !== e.TEST_BUNDLE_PATH || owner.arenaMax !== report.arenaMax)
          throw new Error('Inspector serving-process identity mismatch');
        phase('named-query-preflight');
        report.transport = { route: e.TEST_QUERY_ROUTE, auth: 'loopback', workspaceId: e.PAPERCUSP_WORKSPACE_ID };
        const route = e.TEST_QUERY_ROUTE + '?name=workItems.byHarness&args=' + encodeURIComponent(JSON.stringify({ harnessSlug: e.PAPERCUSP_POT_HOME_SLUG, limit: 128 }));
        // Warm the same named route before the paired idle/ordinary windows.
        const warmStartedAt = Date.now();
        const warm = await call(route);
        if (warm.body.rows?.length !== 128) throw new Error('Fixture page did not return 128 rows');
        report.warmHttpBytes = warm.bytes;
        const preflight = await sample('query-preflight');
        // readWorkItemsPageFromStore deliberately fetches limit+1 before slicing
        // the HTTP page. pgQueryFamily names the FIRST FROM (the spine CTE), not
        // every relation touched by a query, so do not infer its owner from it.
        const completedPage = row => row.status === 'ok' && row.rowCount === 129 && row.wireBytes > 0;
        report.namedQuery = { name: 'workItems.byHarness', startedAt: warmStartedAt,
          httpRows: warm.body.rows.length, expectedDbRows: 129,
          results: preflight.pools.flatMap(pool => pool.results.filter(row =>
            completedPage(row) && row.recordedAt >= warmStartedAt).map(row => ({ pool: pool.pool, ...row }))) };
        if (report.namedQuery.results.length !== 1)
          throw new Error('Completed named-query diagnostic unobserved');
        for (let window = 0; window < 3; window++) {
          phase('matched-window-' + window);
          await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 }); sampling = true;
          await sample('idle-' + window + '-start'); await wait(750); await sample('idle-' + window + '-end');
          const idle = await cdp.send('HeapProfiler.stopSampling'); sampling = false;
          await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 }); sampling = true;
          const start = await sample('ordinary-' + window + '-start');
          const requestStart = Date.now();
          const responses = await Promise.all(Array.from({ length: 8 }, () => call(route).then(({ body, bytes }) => {
            if (body.rows?.length !== 128) throw new Error('Concurrent fixture page mismatch');
            return { rows: body.rows.length, bytes };
          })));
          const end = await sample('ordinary-' + window + '-end');
          const ordinary = await cdp.send('HeapProfiler.stopSampling'); sampling = false;
          report.windows.push({ window, idleMs: 750, requestWallMs: Date.now() - requestStart,
            startAt: start.at, endAt: end.at, responses,
            completedPageResults: end.pools.flatMap(pool => pool.results.filter(row =>
              completedPage(row) && row.recordedAt >= requestStart).map(row => ({ pool: pool.pool, ...row }))),
            idleAllocation: allocationSummary(idle.profile), ordinaryAllocation: allocationSummary(ordinary.profile) });
          // A separately labeled post-GC survivor sample distinguishes transient allocation.
          await cdp.send('HeapProfiler.collectGarbage'); await sample('post-gc-' + window);
        }
        report.incomplete = false; phase('samples-complete');
      })().catch(error => { report.error = String(error); report.hostErrorTail = errors;
        report.startupTail = startup.slice(-3000); process.exitCode = 1; publish(); })
      .finally(async () => {
        if (sampling && cdp) { try { await cdp.send('HeapProfiler.stopSampling'); } catch {} }
        cdp?.close();
        if (host && host.exitCode === null && host.signalCode === null) {
          const exited = new Promise(resolve => host.once('exit', resolve));
          host.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
          if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await exited; }
        }
        host?.stdout.destroy(); host?.stderr.destroy();
        if (sql) await sql.end();
        report.finishedAt = new Date().toISOString(); report.home = e.HOME;
        report.hostReaped = !host || host.exitCode !== null || host.signalCode !== null;
        publish(); console.log('P011_MEMORY_COHORT report=' + e.TEST_REPORT_PATH);
      });
    `;
    try {
      // Reject malformed embedded JS before the expensive runtime preparation.
      expect(() => new Function(probe)).not.toThrow();
      const buildSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
        cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      });
      expect(build.status, build.stderr.slice(-3000)).toBe(0);
      const bundleHash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TEST_BUNDLE_PATH: bundle, TEST_BUNDLE_HASH: bundleHash, TEST_BUILD_SHA: buildSha,
          TEST_MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX, TEST_QUERY_ROUTE: queryPath, TEST_REPORT_PATH: reportPath },
      });
      const report = readCohortReport(reportPath, result);
      if (process.env.PAPERCUSP_P011_REPORT) writeFileSync(process.env.PAPERCUSP_P011_REPORT, JSON.stringify(report, null, 2) + '\n');
      expect(result.status, report.phase + ': ' + (report.error ?? report.runner.error ?? result.stderr.slice(-3000))).toBe(0);
      expect(report.incomplete).toBe(false);
      expect(report.hostReaped).toBe(true);
      expect(existsSync(report.home)).toBe(false);
      expect(report.windows).toHaveLength(3);
      expect(report.samples).toHaveLength(16);
      expect(report.inspector.pid).toBe(report.pid);
      expect(report.inspector.entry).toBe(bundle);
      for (const sample of report.samples) {
        expect(sample.pid).toBe(report.pid);
        expect(sample.memory.heapUsed).toBeGreaterThan(0);
        expect(sample.memory.external).toBeGreaterThanOrEqual(0);
        expect(sample.memory.arrayBuffers).toBeGreaterThanOrEqual(0);
        expect(sample.processes[0].pssBytes).toBeGreaterThan(0);
        for (const pool of sample.pools) {
          expect(pool.results.length).toBeLessThanOrEqual(32);
          for (const row of pool.results) {
            expect(row.wireBytes).toBeGreaterThanOrEqual(0);
            expect(row.rowCount).toBeGreaterThanOrEqual(0);
          }
        }
      }
      const results = report.samples.flatMap((sample: any) => sample.pools.flatMap((pool: any) => pool.results));
      expect(report.namedQuery.httpRows).toBe(128);
      expect(report.namedQuery.results).toHaveLength(1);
      expect(results.some((row: any) => row.rowCount === report.namedQuery.expectedDbRows && row.wireBytes > 0)).toBe(true);
      console.log('P011_COHORT_SUMMARY ' + JSON.stringify({ buildSha, bundleHash, pid: report.pid,
        windows: report.windows.length, samples: report.samples.length, database: report.database,
        pssBytes: report.samples.map((sample: any) => sample.processes[0].pssBytes),
        heapUsed: report.samples.map((sample: any) => sample.memory.heapUsed) }));
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 435_000);
});
