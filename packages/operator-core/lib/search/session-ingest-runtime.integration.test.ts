import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const source = resolve(root, 'packages/operator-core/lib/search/session-ingest.ts');

describe('current-build ingestion on a private background runtime', () => {
  it.each([false, true])('attributes a fixed incremental workload with CPU sampling=%s and removes its database and home', (sampleCpu) => {
    const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    // An optional frozen local tail exercises real mixed record sizes without
    // checking private transcripts into the repository. Only hashes and counts
    // enter the receipt; the canonical synthetic fixture remains self-contained.
    const corpusPath = process.env.TEST_INGEST_CORPUS_PATH;
    const corpusHash = corpusPath
      ? createHash('sha256').update(readFileSync(corpusPath)).digest('hex')
      : '';
    // Exercise the maintained runtime route in a fresh process: no mocked clock,
    // database, adapters, filesystem, flag read, or phase instrumentation.
    const probe = String.raw`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import fsPromises from 'node:fs/promises';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { performance } from 'node:perf_hooks';
      import { Session } from 'node:inspector/promises';
      import { createHash } from 'node:crypto';
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { getOrgPg } from '@papercusp/db-org';
      import { FILE_ADAPTERS, jsonlAtDepth, runSessionIngestOnce } from './packages/operator-core/lib/search/session-ingest.ts';

      const e = process.env;
      assert.equal(e.PAPERCUSP_HOME, join(e.HOME, '.papercusp'));
      assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '1');
      assert.equal(e.PAPERCUSP_DBOS_ROUTINES, '0');
      assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
      assert.ok(e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'));
      assert.ok(!e.PAPERCUSP_SID && !e.CODEX_HOME && !e.VITEST && !e.SSH_AUTH_SOCK);
      assert.ok(!e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_DHT_BOOTSTRAP);
      assert.notEqual(e.HOME, e.TEST_LIVE_HOME);
      const dbUrl = new URL(e.HARNESS_ADMIN_DATABASE_URL);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname));
      assert.equal(dbUrl.port, e.PAPERCUSP_PG_PORT);
      assert.notEqual(dbUrl.port, '5432');
      const sourceHash = createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex');
      assert.equal(sourceHash, e.TEST_INGEST_SOURCE_HASH);
      for (const adapter of FILE_ADAPTERS) {
        for (const spec of adapter.roots()) assert.ok(spec.root.startsWith(e.HOME + '/'));
      }
      console.log('INGEST_RUNTIME_ENV ' + JSON.stringify({ home: e.HOME, dbPort: dbUrl.port, sourceHash }));

      // Match the observed candidate/tail scale, not the changing live corpus:
      // 320 managed homes, 15 rollouts/home, 80 changed tails, 64 useful turns,
      // 640 faithful parts. Metadata-only unchanged files isolate discovery,
      // state loading and metadata; this is not a production p95 workload.
      const workload = { id: 'synthetic-offset-tail-v1', homes: 320, filesPerHome: 15,
        changedFiles: 80, usefulTurns: 64, parts: 640, repeats: 4 };
      // A/B/B/A compares the same workload with and without the observer.
      // These are awaited-operation spans, including queueing and scheduling;
      // neither their wall time nor eventLoopUtilization measures kernel IO time.
      const observerOrder = [false, true, true, false];
      const sampleCpu = e.TEST_INGEST_SAMPLE_CPU === '1';
      // Keep filesystem observation fixed for the profiler comparison. Its
      // off/on/on/off series must not confound two observers changing together.
      if (sampleCpu) observerOrder.fill(true);
      const profilerOrder = sampleCpu ? [false, true, true, false] : observerOrder.map(() => false);
      const profiler = sampleCpu ? new Session() : null;
      if (profiler) {
        profiler.connect();
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.setSamplingInterval', { interval: 10_000 });
      }
      function summarizeProfile(profile) {
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        const parents = new Map();
        for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
        assert.equal(profile.samples.length, profile.timeDeltas.length);
        const sampled = new Map();
        let sourceSamples = 0;
        for (let i = 0; i < profile.samples.length; i++) {
          const leaf = profile.samples[i];
          let bucket = sampled.get(leaf);
          if (!bucket) {
            const stack = [];
            for (let id = leaf; id != null; id = parents.get(id)) {
              assert.ok(nodes.has(id), 'every sampled stack node must exist');
              const frame = nodes.get(id).callFrame;
              stack.push({ function: frame.functionName, url: frame.url, line: frame.lineNumber });
            }
            bucket = { samples: 0, precedingIntervalUs: 0, stack };
            sampled.set(leaf, bucket);
          }
          bucket.samples++;
          // timeDeltas describe intervals preceding samples; neither their sum
          // nor ancestry allocation is exact per-function or per-phase CPU.
          bucket.precedingIntervalUs += profile.timeDeltas[i];
          if (bucket.stack.some(frame => frame.url.endsWith('/search/session-ingest.ts'))) sourceSamples++;
        }
        assert.ok(profile.samples.length > 0 && sourceSamples > 0, 'require actual sampled ingestion stacks');
        return { profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
          intervalUs: 10_000, startTimeUs: profile.startTime, endTimeUs: profile.endTime,
          totalSamples: profile.samples.length, sourceSamples, sampledStacks: [...sampled.values()] };
      }
      const managedRoot = join(e.PAPERCUSP_HOME, 'su-codex-homes');
      const originals = { readdir: fsPromises.readdir, stat: fsPromises.stat };
      let fsObservation = null;
      function observeDiscovery(enabled) {
        fsObservation = enabled ? { pending: 0, maxPending: 0,
          readdir: { calls: 0, awaitMs: 0, activeMs: 0, idleMs: 0 },
          stat: { calls: 0, awaitMs: 0, activeMs: 0, idleMs: 0 } } : null;
        for (const name of ['readdir', 'stat']) {
          fsPromises[name] = enabled ? async function(...args) {
            if (typeof args[0] !== 'string' || !args[0].startsWith(managedRoot)) {
              return originals[name](...args);
            }
            const bucket = fsObservation[name];
            bucket.calls++;
            fsObservation.maxPending = Math.max(fsObservation.maxPending, ++fsObservation.pending);
            const began = performance.now();
            const loopBegan = performance.eventLoopUtilization();
            try { return await originals[name](...args); }
            finally {
              const loop = performance.eventLoopUtilization(loopBegan);
              bucket.awaitMs += performance.now() - began;
              bucket.activeMs += loop.active;
              bucket.idleMs += loop.idle;
              fsObservation.pending--;
            }
          } : originals[name];
        }
        syncBuiltinESMExports();
      }
      async function measuredSweep(observe, profileCpu) {
        observeDiscovery(observe);
        let profilerActive = false;
        const startBegan = performance.now();
        if (profileCpu) {
          await profiler.post('Profiler.start');
          profilerActive = true;
        }
        const profilerStartMs = profileCpu ? performance.now() - startBegan : 0;
        const cpuStarted = process.cpuUsage();
        const loopStarted = performance.eventLoopUtilization();
        try {
          const stats = await runSessionIngestOnce();
          const loop = performance.eventLoopUtilization(loopStarted);
          const cpu = process.cpuUsage(cpuStarted);
          let cpuProfile = null;
          let profilerStopMs = 0;
          if (profileCpu) {
            const stopBegan = performance.now();
            const { profile } = await profiler.post('Profiler.stop');
            profilerActive = false;
            profilerStopMs = performance.now() - stopBegan;
            cpuProfile = summarizeProfile(profile);
          }
          const observation = fsObservation;
          if (observation) {
            assert.equal(observation.pending, 0);
            assert.equal(observation.maxPending, 1, 'production discovery is sequential');
            // Root + home/sessions/year/month/day for every managed home.
            assert.equal(observation.readdir.calls, workload.homes * 5 + 1);
            assert.equal(observation.stat.calls, workload.homes * workload.filesPerHome);
            for (const bucket of [observation.readdir, observation.stat]) {
              assert.ok(bucket.awaitMs > 0 && bucket.activeMs >= 0 && bucket.idleMs >= 0);
            }
            assert.ok(observation.readdir.awaitMs + observation.stat.awaitMs <= stats.phaseMs.discovery + 1,
              'non-overlapping discovery spans must fit their production phase');
          }
          return { ...stats, discoveryFs: observation,
            cpuProfile, profilerStartMs, profilerStopMs,
            mainLoopMs: { active: loop.active, idle: loop.idle },
            // Includes all process threads; never label this per-phase JS CPU.
            processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 } };
        } finally {
          observeDiscovery(false);
          // Also stop sampling on an assertion/error path; the private runtime
          // exits after this unit and the inspector is disconnected below.
          if (profilerActive) await profiler.post('Profiler.stop');
        }
      }
      let frozenTail = null;
      let corpusHash = null;
      if (e.TEST_INGEST_CORPUS_PATH) {
        frozenTail = readFileSync(e.TEST_INGEST_CORPUS_PATH);
        corpusHash = createHash('sha256').update(frozenTail).digest('hex');
        assert.equal(corpusHash, e.TEST_INGEST_CORPUS_HASH);
        assert.ok(frozenTail.length > 0 && frozenTail.length < 5 * 1024 * 1024 - 1024);
        assert.equal(frozenTail.at(-1), 10, 'frozen tail must end on a complete record');
        const adapter = FILE_ADAPTERS.find(a => a.sourceKind === 'codex');
        const lines = frozenTail.toString('utf8').trimEnd().split('\n');
        for (const line of lines) JSON.parse(line);
        // Existing parser guards establish parsing correctness. This preflight
        // determines the frozen input's expected output before any private write.
        workload.id = 'frozen-local-codex-tail-v1';
        workload.usefulTurns = lines.filter(line => adapter.parseLine(line)).length * workload.changedFiles;
        workload.parts = lines.reduce((n, line) => n + adapter.parseParts(line).length, 0) * workload.changedFiles;
        assert.ok(workload.usefulTurns > 0 && workload.usefulTurns < 4000);
        assert.ok(workload.parts > 0);
        workload.tailBytesPerFile = frozenTail.length;
        workload.tailLinesPerFile = lines.length;
        workload.corpusHash = corpusHash;
      }
      const workloadHash = createHash('sha256').update(JSON.stringify(workload)).digest('hex');
      const files = [];
      const ids = [];
      const prefix = JSON.stringify({ type: 'session_meta', payload: {} }) + '\n';
      const prefixBytes = Buffer.byteLength(prefix);
      assert.ok(prefixBytes > 0); // the production candidate filter excludes empty files
      for (let h = 0; h < workload.homes; h++) {
        const home = join(e.PAPERCUSP_HOME, 'su-codex-homes', 'session-' + (10000 + h));
        const day = join(home, 'sessions', '2026', '10', '01');
        await mkdir(day, { recursive: true });
        await writeFile(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
        for (let f = 0; f < workload.filesPerHome; f++) {
          const index = h * workload.filesPerHome + f;
          const id = '019f4fa9-4a09-78c0-8a35-' + index.toString(16).padStart(12, '0');
          const path = join(day, 'rollout-2026-10-01T00-00-00-' + id + '.jsonl');
          await writeFile(path, prefix);
          files.push(path);
          ids.push(id);
        }
      }
      const codex = FILE_ADAPTERS.find(adapter => adapter.sourceKind === 'codex');
      const discovered = await Promise.all(codex.roots().map(spec => jsonlAtDepth(spec.root, spec.dirDepth, spec.descend)));
      assert.equal(discovered.flat().length, files.length, 'fixture must use the production discovery layout');
      const { sql } = getOrgPg();
      try {
        const migrated = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.schema_migrations');
        assert.ok(migrated[0].n > 0);
        await sql.unsafe([
          'INSERT INTO harness_shared.session_ingest_state',
          '(source_kind, file_path, session_id, byte_offset, turn_count, part_count,',
          'counts_backfill_offset, counts_backfilled_at, parts_backfill_offset, parts_backfilled_at)',
          "SELECT 'codex', path, id, $2::bigint, 0, 0, $2::bigint, now(), $2::bigint, now()",
          'FROM jsonb_to_recordset($1::jsonb) AS f(path text, id text)',
        ].join(' '), [JSON.stringify(files.map((path, i) => ({ path, id: ids[i] }))), prefixBytes]);
        const baseline = await runSessionIngestOnce();
        assert.equal(baseline.errors, 0);
        assert.equal(baseline.filesScanned, 4800, JSON.stringify(baseline));
        assert.equal(baseline.filesIngested, 0);
        assert.equal(baseline.turnsInserted, 0);
        const passes = [];
        const matchedUnchanged = [];
        for (let repeat = 0; repeat < workload.repeats; repeat++) {
          const sizes = [];
          for (let i = 0; i < workload.changedFiles; i++) {
            const lines = [];
            for (let part = 0; part < 8; part++) {
              const payload = part === 0 && i < workload.usefulTurns
                ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixed useful ingestion turn ' + repeat + ':' + i }] }
                : { type: 'function_call_output', call_id: 'fixed-' + i + '-' + part,
                    output: 'fixed tool result ' + 'x'.repeat(1024) };
              lines.push(JSON.stringify({ type: 'response_item', timestamp: '2026-10-01T00:00:00Z', payload }));
            }
            const content = frozenTail
              ? Buffer.concat([Buffer.from(prefix), frozenTail])
              : prefix + lines.join('\n') + '\n';
            // Reset exactly these private offsets for a repeatable new-tail pass.
            await writeFile(files[i], content);
            sizes.push(Buffer.byteLength(content));
          }
          const changedPaths = JSON.stringify(files.slice(0, workload.changedFiles));
          await sql.unsafe([
            'UPDATE harness_shared.session_ingest_state SET byte_offset = $2::bigint,',
            'counts_backfill_offset = $2::bigint, parts_backfill_offset = $2::bigint',
            'WHERE file_path IN (SELECT jsonb_array_elements_text($1::jsonb))',
          ].join(' '), [changedPaths, prefixBytes]);
          const stats = await measuredSweep(observerOrder[repeat], profilerOrder[repeat]);
          assert.equal(stats.errors, 0, JSON.stringify(stats));
          assert.equal(stats.filesScanned, 4800);
          assert.equal(stats.filesIngested, workload.changedFiles);
          assert.equal(stats.turnsInserted, workload.usefulTurns);
          assert.equal(stats.partsInserted, workload.parts);
          assert.equal(stats.countBackfillFiles, 0);
          assert.equal(stats.partsBackfillFiles, 0);
          assert.ok(stats.phaseMs && Object.values(stats.phaseMs).every(n => Number.isFinite(n) && n >= 0));
          const total = Object.values(stats.phaseMs).reduce((sum, ms) => sum + ms, 0);
          assert.ok(Math.abs(total - stats.durationMs) < 1, JSON.stringify(stats));
          assert.ok(stats.phaseMs.discovery > 0 && stats.phaseMs.state > 0 && stats.phaseMs.metadata > 0);
          assert.ok(stats.phaseMs.decode > 0 && stats.phaseMs.writes > 0);
          const offsets = await sql.unsafe([
            'SELECT file_path, byte_offset::text FROM harness_shared.session_ingest_state',
            'WHERE file_path IN (SELECT jsonb_array_elements_text($1::jsonb))',
          ].join(' '), [changedPaths]);
          const byPath = new Map(offsets.map(r => [r.file_path, Number(r.byte_offset)]));
          for (let i = 0; i < workload.changedFiles; i++) assert.equal(byPath.get(files[i]), sizes[i]);
          passes.push(stats);
          const noTail = await measuredSweep(observerOrder[repeat], profilerOrder[repeat]);
          assert.equal(noTail.errors, 0);
          assert.equal(noTail.filesScanned, files.length);
          assert.equal(noTail.filesIngested, 0);
          assert.equal(noTail.turnsInserted, 0);
          assert.equal(noTail.partsInserted ?? 0, 0);
          assert.equal(noTail.phaseMs.decode, 0);
          assert.equal(noTail.phaseMs.writes, 0);
          matchedUnchanged.push(noTail);
        }
        const rows = await sql.unsafe("SELECT count(*)::int AS n FROM harness_shared.session_turns WHERE source_kind = 'codex'");
        const parts = await sql.unsafe("SELECT count(*)::int AS n FROM harness_shared.session_turn_parts WHERE source_kind = 'codex'");
        assert.equal(rows[0].n, workload.usefulTurns * workload.repeats);
        assert.equal(parts[0].n, workload.parts * workload.repeats);
        const unchanged = await runSessionIngestOnce();
        assert.equal(unchanged.errors, 0);
        assert.equal(unchanged.filesScanned, 4800);
        assert.equal(unchanged.filesIngested, 0);
        assert.equal(unchanged.turnsInserted, 0);
        assert.equal(unchanged.partsInserted ?? 0, 0);
        assert.equal(unchanged.phaseMs.decode, 0);
        assert.equal(unchanged.phaseMs.writes, 0);
        if (corpusHash) assert.equal(corpusHash,
          createHash('sha256').update(readFileSync(e.TEST_INGEST_CORPUS_PATH)).digest('hex'));
        assert.equal(sourceHash, createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex'));
        console.log('INGEST_RUNTIME_PROBE ' + JSON.stringify({
          sourceHash, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          workload, workloadHash, observerOrder, profilerOrder, baseline, passes, matchedUnchanged, unchanged,
          child: { pid: process.pid, node: process.version, backgroundWorkers: e.PAPERCUSP_BACKGROUND_WORKERS },
          privateRows: rows[0].n, privateParts: parts[0].n, home: e.HOME, dbPort: dbUrl.port,
        }));
      } finally { profiler?.disconnect(); await sql.end(); }
    `;
    // Reject malformed probe JavaScript before the costly migrated runtime boot.
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: probe, encoding: 'utf8', timeout: 10_000,
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const result = spawnSync(process.execPath, [
      resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe,
    ], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TEST_INGEST_SOURCE_HASH: sourceHash, TEST_LIVE_HOME: process.env.HOME ?? '',
        TEST_INGEST_CORPUS_HASH: corpusHash, TEST_INGEST_SAMPLE_CPU: sampleCpu ? '1' : '0' },
    });
    const dataDir = result.stdout.match(/datadir ([^)]+)\)/)?.[1];
    expect(dataDir).toBeTruthy();
    expect(existsSync(dataDir!)).toBe(false);
    const environment = result.stdout.match(/^INGEST_RUNTIME_ENV (.+)$/m)?.[1];
    if (environment) expect(existsSync(JSON.parse(environment).home)).toBe(false);
    expect(result.status, `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`).toBe(0);
    const receipt = result.stdout.match(/^INGEST_RUNTIME_PROBE (.+)$/m)?.[1];
    expect(receipt, result.stdout.slice(-4000)).toBeTruthy();
    const evidence = JSON.parse(receipt!) as { sourceHash: string; home: string; dbPort: string };
    expect(evidence.sourceHash).toBe(sourceHash);
    expect(existsSync(evidence.home)).toBe(false);
    const stopped = spawnSync(process.execPath, ['-e',
      "const net=require('node:net');const s=net.createConnection({host:'localhost',port:Number(process.argv[1])});" +
      "s.on('connect',()=>{s.destroy();process.exitCode=1;});" +
      "s.on('error',e=>{if(e.code!=='ECONNREFUSED'){console.error(e.code);process.exitCode=1;}});",
      evidence.dbPort,
    ], { encoding: 'utf8', timeout: 10_000 });
    expect(stopped.status, stopped.stderr).toBe(0);
    console.log('INGEST_RUNTIME_RECEIPT', JSON.stringify({ ...evidence, homeRemoved: true, dataDirRemoved: true, dbPortClosed: true }));
  }, 185_000);
});
