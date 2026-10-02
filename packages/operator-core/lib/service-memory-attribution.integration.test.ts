/** P-011: matched resources and decoded-query evidence in the maintained private API route.
 * This measures one request-only host, not the production six-worker/background cohort.
 * Allocation samples and completed query bytes do not prove a retained-state owner.
 */
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_MALLOC_ARENA_MAX } from '../../../apps/operator/bin/malloc-arena-reexec';
import { createCdpClient, readProcessMemory, withFunctionCallTrace } from '../../../scripts/cdp-inspector.mjs';

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

async function readSourceRequest(chunks: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// queryObjects triggers GC and enumerates survivors. Its aggregate sizes are
// container entries, not retained bytes; bound inspection and release the CDP
// handles so the diagnostic cannot become a new retainer itself.
async function retainedContainerCensus(client: any, kind: 'map' | 'array') {
  const group = 'p011-retained-' + kind;
  const startedAt = Date.now();
  try {
    const prototype = await client.evaluate(kind === 'map' ? 'Map.prototype' : 'Array.prototype', { objectGroup: group });
    const objects = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const result = await client.send('Runtime.callFunctionOn', {
      objectId: objects.objects.objectId, returnByValue: true,
      arguments: [{ value: kind }, { value: 2000 }, { value: 200 }],
      // Literal JS stays independent of the test transform's lexical helpers.
      functionDeclaration: String.raw`function (type, limit, budgetMs) {
        const owners = new WeakMap();
        const register = (value, prefix) => {
          if (!value || typeof value !== 'object') return;
          if (value instanceof Map || Array.isArray(value)) { owners.set(value, prefix); return; }
          // Inspect data properties only: do not invoke application getters.
          let fields = 0;
          for (const key in value) {
            if (fields++ >= 64) break;
            const child = Object.getOwnPropertyDescriptor(value, key)?.value;
            if (child instanceof Map || Array.isArray(child)) owners.set(child, prefix + '.' + key);
          }
        };
        const slots = globalThis[Symbol.for('@papercusp/module-singleton.slots')];
        if (slots instanceof Map) {
          let count = 0;
          for (const [key, slot] of slots) {
            if (count++ >= 256) break;
            register(slot?.value, String(key));
          }
        }
        register(globalThis[Symbol.for('@papercusp/p011.retainer.fixture')], 'private-fixture');
        const start = Date.now();
        const top = [];
        const owned = [];
        const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
        let examined = 0, checked = 0, notApplicable = 0, totalEntries = 0;
        for (const value of this) {
          if (examined >= limit || Date.now() - start >= budgetMs) break;
          examined++;
          let entries;
          if (type === 'array') {
            if (!Array.isArray(value)) { notApplicable++; continue; }
            entries = value.length;
          } else {
            // Prototype descendants may lack the builtin's internal slots.
            try { entries = mapSize.call(value); }
            catch (error) {
              if (!(error instanceof TypeError)) throw error;
              notApplicable++; continue;
            }
          }
          const owner = owners.get(value) ?? null;
          checked++; totalEntries += entries;
          top.push({ entries, owner }); top.sort((a, b) => b.entries - a.entries); top.length = Math.min(top.length, 10);
          if (owner && owned.length < 32) owned.push({ entries, owner });
        }
        return { kind: type, population: this.length, checked, notApplicable, notChecked: this.length - examined,
          totalEntries, top, owned, inspectionMs: Date.now() - start,
          limits: { objects: limit, inspectionMs: budgetMs, owners: 32, slots: 256, fieldsPerSlot: 64 },
          definition: 'Surviving container entries; not retained bytes or a complete retainer graph.' };
      }`,
    });
    if (result.exceptionDetails) throw new Error('Retained-container aggregate failed: ' +
      (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 500));
    return { ...result.result.value, elapsedMs: Date.now() - startedAt, intervention: 'queryObjects GC/enumeration' };
  } finally {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: group });
  }
}

describe.skipIf(process.platform !== 'linux')('P-011 private request-host memory cohort', () => {
  it('preserves source bytes when request chunks split a UTF-8 character', async () => {
    const text = 'export const label = "A→🙂éZ";';
    const body = Buffer.from(JSON.stringify({ path: 'unicode.ts', text }));
    for (let split = 1; split < body.length; split++) {
      const chunks = async function* () { yield body.subarray(0, split); yield body.subarray(split); };
      expect(await readSourceRequest(chunks())).toEqual({ path: 'unicode.ts', text });
    }
  });

  it('attributes exercised content-lint transforms to matched request-host and executable descendant samples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-content-lint-cohort-'));
    const sourcePath = 'packages/operator-core/lib/content-lint/esbuild-transform.ts';
    const sourceHash = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
    const entry = join(dir, 'request-host.ts'), bundle = join(dir, 'request-host.cjs');
    const meta = join(dir, 'metafile.json');
    // Dynamic import resolves from the private bundle, independently of NODE_PATH.
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const fixtureSources = [
      'packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts',
      'packages/operator-core/lib/content-lint/esbuild-transform.ts',
      'packages/operator-core/lib/harness/improvements/watchdog.ts',
    ].map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }));
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const buildSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const compilerPath = resolve(root, 'node_modules/@esbuild/linux-x64/bin/esbuild');
    const compilerHash = hash(readFileSync(compilerPath));
    const reports: any[] = [];
    let completeReport: any;
    let failure: unknown;
    const reportPath = process.env.PAPERCUSP_P011_CALLER_REPORT ? resolve(root, process.env.PAPERCUSP_P011_CALLER_REPORT) : null;
    if (reportPath) expect(existsSync(dirname(reportPath)), 'Evidence destination must exist before starting a host.').toBe(true);
    writeFileSync(entry, `
      import { createServer } from 'node:http';
      import { findEsbuildTransformError } from ${JSON.stringify(join(root, sourcePath))};
      ${readSourceRequest.toString()}
      globalThis.p011Compiler = require('esbuild');
      const mode = process.env.P011_COHORT_MODE;
      createServer(async (request, response) => {
        try {
          const value = await readSourceRequest(request);
          const error = request.url === '/warm' || mode === 'transform'
            ? await findEsbuildTransformError(value.path, value.text) : null;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error, sourceBytes: Buffer.byteLength(value.text) }));
        } catch (error) { response.statusCode = 500; response.end(String(error)); }
      }).listen(0, '127.0.0.1', function () {
        console.log(JSON.stringify({ pid: process.pid, port: this.address().port }));
      });
    `);
    try {
      // Compile the current application module into a private request fixture;
      // the metafile and exact bytes identify this plane, not a deployed host.
      const built = spawnSync(compilerPath, [entry, '--bundle', '--platform=node', '--format=cjs',
        '--packages=external', '--outfile=' + bundle, '--metafile=' + meta], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
      });
      expect(built.status, built.stderr).toBe(0);
      const graph = Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs).map(path => {
        const absolute = resolve(root, path);
        return { path: absolute === entry ? '<private-request-fixture>' : path, sha256: hash(readFileSync(absolute)) };
      });
      expect(graph.some(row => row.path === sourcePath && row.sha256 === sourceHash)).toBe(true);
      const sampleProcess = (pid: number) => {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const executable = readlinkSync('/proc/' + pid + '/exe');
        const rollup = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const kb = (name: string) => Number(new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(rollup)?.[1]);
        return { pid, startTicks: tail[19], executable, executableSha256: hash(readFileSync('/proc/' + pid + '/exe')),
          pssKb: kb('Pss'), anonymousKb: kb('Anonymous'), privateDirtyKb: kb('Private_Dirty') };
      };
      for (const mode of ['control', 'transform']) {
        const host = spawn(process.execPath, ['--inspect=127.0.0.1:0', bundle], {
          cwd: root, env: { ...process.env, NODE_PATH: join(root, 'node_modules'), P011_COHORT_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '', client: ReturnType<typeof createCdpClient> | undefined;
        let pauses = 0;
        const seen = new Map<number, string>();
        const report: any = { mode, samples: [], requests: [], windows: [], trace: null, reaped: false };
        reports.push(report);
        host.stdout.on('data', chunk => { stdout += chunk.toString(); });
        host.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const exited = new Promise<void>(resolve => host.once('exit', () => resolve()));
        try {
          const readyDeadline = Date.now() + 10_000;
          while ((!stdout.includes('\n') || !inspectorEndpoints(stderr).length) && Date.now() < readyDeadline && host.exitCode === null) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const ready = JSON.parse(stdout.trim().split('\n')[0]!);
          expect(ready.pid).toBe(host.pid);
          report.pid = ready.pid;
          client = createCdpClient(inspectorEndpoints(stderr).at(-1)!);
          await client.connect();
          client.ws.on?.('message', data => { if (JSON.parse(String(data)).method === 'Debugger.paused') pauses++; });
          let requestSequence = 0;
          const request = async (path: string, text: string, route = '/check') => {
            const requestId = requestSequence++;
            const started = performance.now();
            const response = await fetch('http://127.0.0.1:' + ready.port + route, {
              method: 'POST', body: JSON.stringify({ path, text }), signal: AbortSignal.timeout(10_000),
            });
            const responseText = await response.text();
            expect(response.status, responseText).toBe(200);
            const value = JSON.parse(responseText);
            expect(value.sourceBytes).toBe(Buffer.byteLength(text));
            report.requests.push({ requestId, path, route, sourceSha256: hash(text), sourceBytes: Buffer.byteLength(text),
              error: value.error, elapsedMs: performance.now() - started });
            return value;
          };
          const sample = async (phase: string) => {
            const memory = await readProcessMemory(client!, { expectedPid: ready.pid });
            const parent = sampleProcess(ready.pid);
            const children = readFileSync('/proc/' + ready.pid + '/task/' + ready.pid + '/children', 'utf8')
              .trim().split(/\s+/).filter(Boolean).map(Number).map(sampleProcess);
            for (const child of children) {
              expect(child.executableSha256, 'Classify the executable, not a cmdline substring.').toBe(compilerHash);
              seen.set(child.pid, child.startTicks);
            }
            expect(children).toHaveLength(1);
            expect(parent.pssKb).toBeGreaterThan(0);
            expect(memory.memory.heapUsed).toBeGreaterThan(0);
            report.samples.push({ phase, at: new Date().toISOString(), parent, memory, children });
          };
          await request('warm.ts', 'export const warm = 1', '/warm');
          await sample('warm-idle');
          const traced = await withFunctionCallTrace(client, { expectedPid: ready.pid,
            targets: [{ name: 'transform', expression: 'p011Compiler.transform' }],
            durationMs: 20_000, maxCalls: 64, maxStacks: 4, maxStackChars: 2000,
          }, async () => {
            for (let window = 0; window < 3; window++) {
              const start = performance.now();
              const results = await Promise.all(fixtureSources.map(source => request(source.path, source.text)));
              expect(results.every(value => value.error === null)).toBe(true);
              report.windows.push({ window, concurrency: 3, completed: results.length, elapsedMs: performance.now() - start });
              await sample('ordinary-' + window);
            }
          });
          report.trace = traced.trace; report.traceLimits = traced.limits;
          expect(traced.trace.calls.transform.calls).toBe(mode === 'transform' ? 9 : 0);
          expect(traced.trace.limited).toBe(false);
          if (mode === 'transform') expect(traced.trace.calls.transform.stacks.join('\n')).toContain('findEsbuildTransformError');
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sample('one-second-idle');
          // The real syntax diagnostic remains functional after the concurrent
          // window. Its memory is deliberately outside the matched valid cohort.
          const invalid = await request('invalid.ts', 'export const broken = ;');
          expect(invalid.error === null).toBe(mode === 'control');
          const roots = await client.evaluate("Object.keys(globalThis).filter(key => key.startsWith('__papercuspCdpTrace_'))", { returnByValue: true });
          expect(roots.result.value).toEqual([]);
          expect(pauses).toBe(0); report.pauses = pauses;
        } catch (error) {
          report.error = String(error); throw error;
        } finally {
          client?.close();
          host.kill('SIGTERM');
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([exited, new Promise<void>((_, reject) => {
              cleanupTimer = setTimeout(() => { host.kill('SIGKILL'); reject(new Error('Private compiler host cleanup exceeded 3s')); }, 3000);
            })]);
          } finally { clearTimeout(cleanupTimer); }
          const deadline = Date.now() + 3000;
          const stillOwned = (pid: number, start: string) => {
            try { return sampleProcess(pid).startTicks === start; } catch { return false; }
          };
          while ([...seen].some(([pid, start]) => stillOwned(pid, start)) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          report.unreaped = [...seen].filter(([pid, start]) => stillOwned(pid, start));
          report.reaped = host.exitCode !== null || host.signalCode !== null;
          expect(report.unreaped).toEqual([]); expect(report.reaped).toBe(true);
        }
      }
      expect(hash(readFileSync(join(root, sourcePath)))).toBe(sourceHash);
      const scheduledInputs = (report: any) => [...report.requests].sort((a, b) => a.requestId - b.requestId)
        .map(row => [row.requestId, row.path, row.route, row.sourceSha256, row.sourceBytes]);
      // Concurrent completions may arrive in different orders. Match the
      // scheduled requests, preserving multiplicity and each window's order.
      expect(scheduledInputs(reports[0])).toEqual(scheduledInputs(reports[1]));
      completeReport = { schemaVersion: 1, incomplete: false, plane: 'current-source-private-content-lint-http-fixture', buildSha,
        bundleHash: hash(readFileSync(bundle)), graph, compiler: { path: compilerPath, sha256: compilerHash },
        workload: { windows: 3, requestsPerWindow: 3, concurrency: 3, inputFiles: fixtureSources.map(row => ({ path: row.path, sha256: hash(row.text) })) },
        reports, limitations: [
          'Current application source compiled into a private request fixture; not the deployed operator runtime.',
          'One-second idle is bounded fixture evidence, not an ordinary production idle baseline.',
          'V8 malloced/external counters and executable PSS are measured separately; no total native allocation estimate.',
          'Named exercised content-lint caller does not attribute the historical 4.2 GiB production census.',
          'Compiler trace adds bounded diagnostic overhead; control receives identical source bytes without transform work.',
        ] };
      console.log('P011_CONTENT_LINT_COHORT ' + JSON.stringify(reports.map(row => ({ mode: row.mode,
        calls: row.trace.calls.transform.calls, parentPssKb: row.samples.map((sample: any) => sample.parent.pssKb),
        compilerPssKb: row.samples.map((sample: any) => sample.children[0].pssKb), reaped: row.reaped }))));
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        if (reportPath) writeFileSync(reportPath,
          JSON.stringify(completeReport ?? { schemaVersion: 1, incomplete: true, buildSha, sourcePath, sourceHash,
            error: String(failure), reports }, null, 2) + '\n');
      } catch (error) {
        throw new AggregateError(failure ? [failure, error] : [error], 'Compiler cohort evidence write failed');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 90_000);

  it('compares real closure and transform services in isolated processes and reaps their descendants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-esbuild-census-'));
    const script = String.raw`
      import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { transform, stop, version } from 'esbuild';
      const mode = process.argv[1], dir = process.argv[2];
      const modules = 192, declarations = 128;
      const sources = Array.from({ length: modules }, (_, i) =>
        Array.from({ length: declarations }, (_, j) =>
          'export const v' + j + ' = ' + JSON.stringify(i + ':' + j + ':' + 'abcdef0123456789'.repeat(10)) + ';').join('\n'));
      mkdirSync(join(dir, mode), { recursive: true });
      const checkout = join(dir, mode);
      for (let i = 0; i < modules; i++) writeFileSync(join(checkout, 'm' + i + '.ts'), sources[i]);
      writeFileSync(join(checkout, 'entry.test.ts'), sources.map((_, i) => 'import * as m' + i + ' from "./m' + i + '";').join('\n') +
        '\nconsole.log(' + sources.map((_, i) => 'm' + i).join(',') + ');');
      writeFileSync(join(checkout, 'subject.ts'), 'export const unrelated = 1;');
      const { mutationProbeRefusal } = await import(pathToFileURL(join(process.cwd(),
        'packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts')).href);
      const samples = [], servicePids = new Set();
      function sample(phase) {
        const children = readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean);
        const services = children.flatMap(id => {
          try {
            const command = readFileSync('/proc/' + id + '/cmdline', 'utf8').split('\0');
            if (!command.some(arg => arg.startsWith('--service='))) return [];
            const rollup = readFileSync('/proc/' + id + '/smaps_rollup', 'utf8');
            servicePids.add(Number(id));
            return [{ pid: Number(id), pssKb: Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1]),
              anonymousKb: Number(/^Anonymous:\s+(\d+)/m.exec(rollup)?.[1]) }];
          } catch { return []; }
        });
        samples.push({ phase, at: new Date().toISOString(), services, parent: process.memoryUsage() });
      }
      try {
        await transform('export const warm = 1', { loader: 'ts' });
        sample('warm');
        for (let pass = 0; pass < 3; pass++) {
          if (mode === 'closure') {
            const result = await mutationProbeRefusal(checkout, ['entry.test.ts'], { probePaths: async () => ['subject.ts'] });
            if (result !== null) throw new Error('Closure comparison did not admit unrelated source: ' + JSON.stringify(result));
          } else {
            for (const source of sources) await transform(source, { loader: 'ts', target: 'node22', logLevel: 'silent' });
          }
          sample('pass-' + pass);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        sample('one-second-idle');
      } finally { await stop(); }
      const deadline = Date.now() + 3000;
      while ([...servicePids].some(pid => existsSync('/proc/' + pid)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const unreaped = [...servicePids].filter(pid => existsSync('/proc/' + pid));
      console.log(JSON.stringify({ mode, version, modules, declarations,
        sourceBytes: sources.reduce((n, source) => n + Buffer.byteLength(source), 0), samples, unreaped }));
      if (unreaped.length) process.exitCode = 1;
    `;
    try {
      const reports = ['closure', 'transform'].map(mode => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, mode, dir], {
          cwd: root, env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 128 * 1024,
        });
        expect(result.error?.message ?? result.stderr).toBe('');
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.unreaped).toEqual([]);
        expect(report.samples.map((sample: any) => sample.phase)).toEqual(['warm', 'pass-0', 'pass-1', 'pass-2', 'one-second-idle']);
        for (const sample of report.samples) {
          expect(sample.services).toHaveLength(1);
          expect(sample.services[0].pssKb).toBeGreaterThan(0);
        }
        return report;
      });
      expect(reports[0].sourceBytes).toBe(reports[1].sourceBytes);
      const closure = reports[0], warmService = closure.samples[0].services[0];
      for (const sample of closure.samples.slice(1)) {
        expect(sample.services[0].pid, 'A closure must preserve the caller transform service.').toBe(warmService.pid);
        // R12's inline implementation retained ~132 MiB above warm after this
        // exact 4.66 MB graph. The 32 MiB allowance tolerates native GC timing
        // while rejecting that retained ownership; it is not a leak threshold.
        expect(sample.services[0].pssKb - warmService.pssKb).toBeLessThan(32 * 1024);
      }
      // Report measured costs without turning fluctuating PSS into a leak assertion.
      const report = { schemaVersion: 1, definition: 'Isolated real closure versus transforms; one-second idle is not a production idle baseline.', reports };
      if (process.env.PAPERCUSP_P011_ESBUILD_REPORT) writeFileSync(process.env.PAPERCUSP_P011_ESBUILD_REPORT, JSON.stringify(report, null, 2) + '\n');
      console.log('P011_ESBUILD_CENSUS ' + JSON.stringify(reports.map(r => ({ mode: r.mode,
        pssKb: r.samples.map((s: any) => s.services[0].pssKb), unreaped: r.unreaped }))));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 100_000);

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
      expect(stdout.trim(), `Inspector child produced no identity (exit ${child.exitCode}):\n${startup}`).not.toBe('');
      const identity = JSON.parse(stdout.trim());
      expect(identity, startup).toEqual({ pid: child.pid, cap: HOST_MALLOC_ARENA_MAX });
      const endpoints = inspectorEndpoints(startup);
      expect(endpoints, startup).toHaveLength(2);
      expect(endpoints[0]).not.toBe(endpoints[1]);
      expect(inspectorEndpoints(startup.slice(0, startup.indexOf(endpoints[0]) + 12))).toEqual([]);
      const { createCdpClient, readProcessMemory } = await import('../../../scripts/cdp-inspector.mjs');
      const stale = createCdpClient(endpoints[0]);
      try { await expect(stale.connect()).rejects.toThrow(); } finally { stale.close(); }
      client = createCdpClient(endpoints.at(-1)!);
      await client.connect();
      const measured = await client.evaluate('({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX })', { returnByValue: true });
      expect(measured.result.value).toEqual(identity);
      // Exercise the maintained reader on a real inspector without an ESM
      // import callback. A wrong target must fail even when its counters look valid.
      const memory = await readProcessMemory(client, { expectedPid: child.pid });
      expect(memory.pid).toBe(child.pid);
      expect(memory.memory.heapUsed).toBeGreaterThan(0);
      expect(memory.memory.external).toBeGreaterThanOrEqual(0);
      expect(memory.heap.used_heap_size).toBeGreaterThan(0);
      expect(memory.heap.number_of_detached_contexts).toBeGreaterThanOrEqual(0);
      await expect(readProcessMemory(client, { expectedPid: child.pid! + 1 })).rejects.toThrow('Inspector PID mismatch');
      await expect(readProcessMemory(client, {})).rejects.toThrow('positive expectedPid');
      await client.evaluate("globalThis[Symbol.for('@papercusp/p011.retainer.fixture')] = { map: new Map(Array.from({length: 5}, (_, i) => [i, i])), array: Array(7).fill(1), fakeMap: Object.create(Map.prototype), fakeArray: Object.create(Array.prototype) }");
      const remoteIds: string[] = [];
      const observer = { evaluate: client.evaluate, send: async (method: string, args: object) => {
        const result = await client.send(method, args);
        if (method === 'Runtime.queryObjects') remoteIds.push(result.objects.objectId);
        return result;
      } };
      try {
        for (const kind of ['map', 'array'] as const) {
          const census = await retainedContainerCensus(observer, kind);
          expect(census.checked).toBeGreaterThan(0);
          expect(census.checked).toBeLessThanOrEqual(census.limits.objects);
          expect(census.checked + census.notApplicable + census.notChecked).toBe(census.population);
          expect(census.notApplicable).toBeGreaterThan(0);
          expect(census.owned).toContainEqual({ owner: 'private-fixture.' + kind, entries: kind === 'map' ? 5 : 7 });
        }
        for (const objectId of remoteIds) {
          await expect(client.send('Runtime.getProperties', { objectId })).rejects.toThrow('Runtime.getProperties failed');
        }
      } finally { await client.evaluate("delete globalThis[Symbol.for('@papercusp/p011.retainer.fixture')]"); }
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
      const retainedContainerCensus = ${retainedContainerCensus.toString()};
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const e = process.env, base = e.PAPERCUSP_OPERATOR_URL;
      const report = { schemaVersion: 1, plane: 'isolated-current-build-operator-api', incomplete: true,
        buildSha: e.TEST_BUILD_SHA, bundleHash: e.TEST_BUNDLE_HASH, startedAt: new Date().toISOString(),
        workload: { population: 1024, pageLimit: 128, windows: 3, requestsPerWindow: 8, concurrency: 8 },
        samples: [], windows: [], retainedContainers: [], phases: [], limitations: [
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
          // Keep survivor enumeration outside the ordinary workload windows.
          report.retainedContainers.push({ window, maps: await retainedContainerCensus(cdp, 'map'),
            arrays: await retainedContainerCensus(cdp, 'array') }); publish();
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
      expect(report.retainedContainers).toHaveLength(3);
      for (const census of report.retainedContainers.flatMap((row: any) => [row.maps, row.arrays])) {
        expect(census.checked + census.notApplicable + census.notChecked).toBe(census.population);
        expect(census.checked).toBeLessThanOrEqual(census.limits.objects);
      }
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
