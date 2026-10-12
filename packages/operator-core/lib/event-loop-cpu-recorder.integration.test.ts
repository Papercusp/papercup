import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const recorderPath = fileURLToPath(new URL('./event-loop-cpu-recorder.ts', import.meta.url));
const eagerAdapterPath = fileURLToPath(new URL('./event-loop-cpu-profiler-eager-adapter.cc', import.meta.url));
const nodeIncludePath = join(dirname(dirname(process.execPath)), 'include', 'node');
const hasNode259ProfilerHeaders =
  process.platform === 'linux' &&
  process.versions.node.startsWith('25.9.') &&
  existsSync(join(nodeIncludePath, 'v8-profiler.h'));

describe('real monitor CPU recorder in an isolated Node process', () => {
  it('retains useful 100Hz samples across rotations, discards delayed work and releases its sampler', async () => {
    const { stdout } = await exec(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', `
      import { LoopCpuRecorder } from ${JSON.stringify(recorderPath)};
      import { performance, PerformanceObserver } from 'node:perf_hooks';
      const retained = Array.from({ length: 25000 }, (_, i) => new Function('x', 'return x + ' + i));
      const observer = [], memory = [], starts = [], stops = [];
      const gcEntries = [];
      const gcObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          gcEntries.push({ startTime: entry.startTime, durationMs: entry.duration, kind: entry.detail?.kind ?? null });
        }
      });
      gcObserver.observe({ entryTypes: ['gc'] });
      const recorder = new LoopCpuRecorder(2000, (line, detail) => observer.push({ line, ...detail }));
      const measureIdle = async () => {
        const start = performance.now(), before = process.cpuUsage(), threadBefore = process.threadCpuUsage?.();
        await new Promise(r => setTimeout(r, 500));
        const end = performance.now();
        const cpu = process.cpuUsage(before);
        const threadCpu = threadBefore && process.threadCpuUsage?.(threadBefore);
        await new Promise(r => setImmediate(r));
        return {
          wallMs: end - start,
          cpuMs: (cpu.user + cpu.system) / 1000,
          threadCpuMs: threadCpu ? (threadCpu.user + threadCpu.system) / 1000 : null,
          gcEvents: gcEntries.filter(entry => entry.startTime >= start && entry.startTime <= end)
            .map(({ kind, durationMs }) => ({ kind, durationMs })),
        };
      };
      const before = await measureIdle();
      let useful = 0, maxSamples = 0, maxBytes = 0;
      const work = () => {
        const until = performance.now() + 130;
        let x = 0;
        while (performance.now() < until) x = retained[x % retained.length](x) % 100000;
      };
      let active, after, delayedRejected, abortRejected, unavailable;
      try {
        if (!await recorder.update(true, true)) throw new Error('recorder failed to start');
        active = await measureIdle();
        for (let i = 0; i < 40; i++) {
          if (!await recorder.update(true, true)) throw new Error('rotation failed');
          const pending = recorder.record(160);
          // Let Profiler.start complete before synchronous work begins.
          await new Promise(r => setImmediate(r));
          work();
          const { profile, startMs, stopMs, samplingIntervalUs } = await pending;
          if (samplingIntervalUs !== 10000) throw new Error('wrong sample interval');
          const ids = new Set(profile.nodes.filter(n => ['work', 'now'].includes(n.callFrame.functionName)).map(n => n.id));
          for (let changed = true; changed;) {
            changed = false;
            for (const n of profile.nodes) if (ids.has(n.id)) for (const c of n.children ?? []) {
              if (!ids.has(c)) { ids.add(c); changed = true; }
            }
          }
          if (profile.samples.filter(id => ids.has(id)).length >= 3) useful++;
          maxSamples = Math.max(maxSamples, profile.samples.length);
          maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(profile)));
          starts.push(startMs); stops.push(stopMs);
          if (i % 5 === 0) { global.gc(); memory.push(process.memoryUsage()); }
        }
        const controller = new AbortController();
        const cancelled = recorder.record(60000, controller.signal).then(() => false, () => true);
        controller.abort();
        abortRejected = await cancelled;
        // A late tick must discard without publishing the now-oversized anchor.
        await new Promise(r => setTimeout(r, 2100));
        delayedRejected = !await recorder.update(true, true);
        unavailable = await recorder.record(1).then(() => false, () => true);
        if (!await recorder.update(true, true)) throw new Error('safe recovery failed');
        await recorder.update(false, true);
        after = await measureIdle();
      } finally { recorder.stop(); gcObserver.disconnect(); }
      global.gc();
      process.stdout.write(JSON.stringify({ observer, memory, starts, stops, useful, maxSamples,
        maxBytes, before, active, after, delayedRejected, abortRejected, unavailable }));
    `], { timeout: 35_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 product warm recorder:', JSON.stringify(result));
    console.info('P-003 active CPU window diagnostics:', JSON.stringify({
      before: result.before,
      active: result.active,
      after: result.after,
      warmups: result.observer.filter((e: { warmupMs?: number }) => 'warmupMs' in e),
    }));
    expect(result.useful).toBe(40);
    expect(result.observer.filter((e: { warmupMs?: number }) => 'warmupMs' in e)).toHaveLength(2);
    expect(result.delayedRejected).toBe(true);
    expect(result.abortRejected).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.maxSamples).toBeGreaterThan(3);
    expect(result.maxBytes).toBeLessThan(8 * 1024 * 1024);
    const heaps = result.memory.map((row: { heapUsed: number }) => row.heapUsed);
    expect(Math.max(...heaps) - Math.min(...heaps)).toBeLessThan(16 * 1024 * 1024);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(median(result.starts)).toBeLessThan(result.observer[0].warmupMs / 2);
    // Broad runaway detector. Exact observations are logged, not a production SLO.
    expect(result.active.cpuMs / result.active.wallMs).toBeLessThan(0.15);
    expect(result.after.cpuMs / result.after.wallMs).toBeLessThan(0.02);
  }, 45_000);

  it.skipIf(!hasNode259ProfilerHeaders)(
    'measures the test-only eager V8 profiler lifecycle beside LoopCpuRecorder',
    async () => {
      const maxSamples = 64;
      const tempDir = await mkdtemp(join(tmpdir(), 'papercusp-eager-profiler-'));
      const addonPath = join(tempDir, 'eager-profiler.node');

      try {
        const compile = await exec(
          process.env.CXX ?? 'c++',
          [
            '-std=c++20',
            '-shared',
            '-fPIC',
            '-O2',
            '-I' + nodeIncludePath,
            eagerAdapterPath,
            '-o',
            addonPath,
          ],
          { timeout: 30_000, maxBuffer: 128 * 1024 },
        );
        expect(existsSync(addonPath)).toBe(true);

        const run = async (strategy: 'inspector' | 'eager', v8Flags: string[] = []) => {
          const workerSource =
            "const { parentPort } = require('node:worker_threads'); " +
            "let waiting = false; " +
            "function tick() { if (waiting) return; waiting = true; parentPort.postMessage(1); } " +
            "parentPort.on('message', () => { waiting = false; setTimeout(tick, 5); }); " +
            'tick();';
          const childScript = [
            "import { createRequire } from 'node:module';",
            "import { performance } from 'node:perf_hooks';",
            "import { setTimeout as delay } from 'node:timers/promises';",
            "import { Worker } from 'node:worker_threads';",
            'import { LoopCpuRecorder } from ' + JSON.stringify(recorderPath) + ';',
            'const strategy = ' + JSON.stringify(strategy) + ';',
            'const maxSamples = ' + maxSamples + ';',
            'const addonPath = ' + JSON.stringify(addonPath) + ';',
            'const require = createRequire(import.meta.url);',
            "const eager = strategy === 'eager' ? require(addonPath) : null;",
            'const recorderLogs = [];',
            "const recorder = strategy === 'inspector' ? new LoopCpuRecorder(1500, (line, detail) => recorderLogs.push({ line, ...detail })) : null;",
            'const worker = new Worker(' + JSON.stringify(workerSource) + ', { eval: true, execArgv: [] });',
            'let gapWindow = null;',
            "worker.on('message', () => {",
            '  const now = performance.now();',
            '  if (gapWindow) { gapWindow.maxMs = Math.max(gapWindow.maxMs, now - gapWindow.lastMs); gapWindow.lastMs = now; }',
            "  worker.postMessage('ack');",
            '});',
            'await new Promise(resolve => worker.once("online", resolve));',
            'await delay(40);',
            'async function measure(action) {',
            '  await delay(20);',
            '  const window = { maxMs: 0, lastMs: performance.now() };',
            '  gapWindow = window;',
            '  const startedAt = performance.now();',
            '  const value = await action();',
            '  await delay(25);',
            '  gapWindow = null;',
            '  return { value, durationMs: performance.now() - startedAt, workerGapMaxMs: window.maxMs };',
            '}',
            'let cursor = 1;',
            'let churnedFunctions = 0;',
            'let hotFrameCalls = 0;',
            'const retained = Array.from({ length: 25000 }, (_, i) => {',
            "  const fn = new Function('return function map_' + i + '(x) { return x + ' + i + '; }')();",
            '  fn(i);',
            '  return fn;',
            '});',
            'function cpuHotFrame(durationMs = 8) {',
            '  hotFrameCalls++;',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) cursor = retained[cursor % retained.length](cursor) % retained.length;',
            '}',
            'let memoryWindow = null;',
            'function sampleMemory() {',
            '  if (!memoryWindow) return;',
            '  const current = process.memoryUsage();',
            '  memoryWindow.peakRss = Math.max(memoryWindow.peakRss, current.rss);',
            '  memoryWindow.peakHeapUsed = Math.max(memoryWindow.peakHeapUsed, current.heapUsed);',
            '}',
            'async function workFor(durationMs) {',
            '  const until = performance.now() + durationMs;',
            '  while (performance.now() < until) {',
            '    cpuHotFrame();',
            '    const batch = Array.from({ length: 32 }, (_, offset) => {',
            "      const name = 'churn_' + churnedFunctions + offset;",
            "      const fn = new Function('x', 'return x + ' + (churnedFunctions + offset));",
            "      Object.defineProperty(fn, 'name', { value: name });",
            '      fn(cursor);',
            '      return fn;',
            '    });',
            '    churnedFunctions += batch.length;',
            '    void batch;',
            '    sampleMemory();',
            '    await delay(5);',
            '  }',
            '  return churnedFunctions;',
            '}',
            'function summarize(profile) {',
            '  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];',
            '  const samples = Array.isArray(profile?.samples) ? profile.samples : [];',
            '  const nodesById = new Map(nodes.map(node => [node.id, node]));',
            '  const parentById = new Map();',
            '  for (const node of nodes) for (const child of node.children ?? []) parentById.set(child, node.id);',
            '  const sampleFrames = samples.map(sampleId => {',
            '    const frames = [], seen = new Set();',
            '    let nodeId = sampleId;',
            '    while (nodeId !== undefined && !seen.has(nodeId)) {',
            '      seen.add(nodeId);',
            '      const node = nodesById.get(nodeId);',
            '      if (!node) break;',
            '      frames.push(node.callFrame?.functionName ?? "");',
            '      nodeId = parentById.get(nodeId);',
            '    }',
            '    return frames;',
            '  });',
            '  const isMapFrame = name => /^map_[0-9]+$/.test(name);',
            '  const mapFrameNames = [...new Set(sampleFrames.flat().filter(isMapFrame))];',
            '  const hotSamples = sampleFrames.filter(frames => frames.includes("cpuHotFrame")).length;',
            '  const mapSamples = sampleFrames.filter(frames => frames.some(isMapFrame)).length;',
            '  const usefulSamples = sampleFrames.filter(frames => frames.includes("cpuHotFrame") || frames.some(isMapFrame)).length;',
            '  const rankCounts = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);',
            '  const leafCounts = new Map();',
            '  const frameCounts = new Map();',
            '  const pathCounts = new Map();',
            '  for (const frames of sampleFrames) {',
            '    const leaf = frames[0] || "(empty)";',
            '    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);',
            '    const path = frames.slice(0, 6).join(" <- ");',
            '    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);',
            '    for (const name of new Set(frames)) frameCounts.set(name, (frameCounts.get(name) ?? 0) + 1);',
            '  }',
            '  return { samples: samples.length, nodes: nodes.length, hotSamples, mapSamples, mapFrameNames: mapFrameNames.slice(0, 8), usefulSamples, sampleLeafCounts: rankCounts(leafCounts), sampleFrameCounts: rankCounts(frameCounts), samplePathCounts: rankCounts(pathCounts).slice(0, 8), bytes: Buffer.byteLength(JSON.stringify(profile)) };',
            '}',
            'async function captureInspector(durationMs) {',
            '  const rotate = setInterval(() => { void recorder.update(true, true); }, 40);',
            '  try {',
            '    const pending = recorder.record(durationMs + 50);',
            '    await delay(15);',
            '    const beforeWork = { hotFrameCalls, churnedFunctions };',
            '    await workFor(durationMs);',
            '    const workload = { hotFrameCalls: hotFrameCalls - beforeWork.hotFrameCalls, churnedFunctions: churnedFunctions - beforeWork.churnedFunctions };',
            '    const recording = await pending;',
            '    return { profile: summarize(recording.profile), workload, startMs: recording.startMs, stopMs: recording.stopMs };',
            '  } finally { clearInterval(rotate); }',
            '}',
            'async function captureEager(durationMs, alreadyStarted = false) {',
            '  if (!alreadyStarted) eager.start(maxSamples);',
            '  const beforeWork = { hotFrameCalls, churnedFunctions };',
            '  await workFor(durationMs);',
            '  const workload = { hotFrameCalls: hotFrameCalls - beforeWork.hotFrameCalls, churnedFunctions: churnedFunctions - beforeWork.churnedFunctions };',
            '  const finished = eager.finish(true, false);',
            '  return { profile: summarize(JSON.parse(finished.profileJson)), workload, sampleCount: finished.sampleCount, serialized: finished.serialized, disposed: finished.disposed };',
            '}',
            'async function revokeInspector(enabled, safe) {',
            '  const pending = recorder.record(60000).then(() => false, () => true);',
            '  await delay(15);',
            '  const measured = await measure(() => recorder.update(enabled, safe));',
            '  return { updateReturned: measured.value, durationMs: measured.durationMs, workerGapMaxMs: measured.workerGapMaxMs, captureRejected: await pending };',
            '}',
            'async function revokeEager() {',
            '  eager.start(maxSamples);',
            '  const measured = await measure(() => eager.finish(false, true));',
            '  return { ...measured.value, durationMs: measured.durationMs, workerGapMaxMs: measured.workerGapMaxMs };',
            '}',
            'const startup = await measure(() => strategy === "inspector" ? recorder.update(true, true) : eager.create());',
            'for (const fn of retained) fn(1);',
            'await delay(50);',
            'const primary = await measure(() => strategy === "inspector" ? captureInspector(1000) : captureEager(1000));',
            'const disabledRevocation = strategy === "inspector" ? await revokeInspector(false, true) : await revokeEager();',
            'const recoveryWarmup = await measure(() => strategy === "inspector" ? recorder.update(true, true) : (eager.create(), eager.start(maxSamples)));',
            'const recoveryCapture = await measure(() => strategy === "inspector" ? captureInspector(350) : captureEager(350, true));',
            'const unsafeRevocation = strategy === "inspector" ? await revokeInspector(true, false) : await revokeEager();',
            'const memoryBefore = process.memoryUsage();',
            'memoryWindow = { peakRss: memoryBefore.rss, peakHeapUsed: memoryBefore.heapUsed };',
            'if (strategy === "inspector") await recorder.update(true, true);',
            'else { eager.create(); eager.start(maxSamples); }',
            'await workFor(2100);',
            'const memoryPeak = { ...memoryWindow };',
            'memoryWindow = null;',
            'const delayedCleanup = strategy === "inspector"',
            '  ? await measure(() => recorder.update(true, true))',
            '  : await measure(() => eager.finish(false, true));',
            'if (global.gc) global.gc();',
            'const memoryAfter = process.memoryUsage();',
            'const delayed = {',
            '  cleanup: delayedCleanup.value,',
            '  durationMs: delayedCleanup.durationMs,',
            '  workerGapMaxMs: delayedCleanup.workerGapMaxMs,',
            '  memory: { beforeRss: memoryBefore.rss, peakRss: memoryPeak.peakRss, peakRssDelta: memoryPeak.peakRss - memoryBefore.rss, beforeHeapUsed: memoryBefore.heapUsed, peakHeapUsed: memoryPeak.peakHeapUsed, retainedHeapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed },',
            '};',
            'const result = {',
            '  strategy,',
            '  startup: { durationMs: startup.durationMs, workerGapMaxMs: startup.workerGapMaxMs },',
            '  primary: { ...primary.value, durationMs: primary.durationMs, workerGapMaxMs: primary.workerGapMaxMs },',
            '  disabledRevocation,',
            '  recoveryWarmup: { durationMs: recoveryWarmup.durationMs, workerGapMaxMs: recoveryWarmup.workerGapMaxMs },',
            '  recoveryCapture: { ...recoveryCapture.value, durationMs: recoveryCapture.durationMs, workerGapMaxMs: recoveryCapture.workerGapMaxMs },',
            '  unsafeRevocation,',
            '  delayed,',
            '  serializations: strategy === "eager" ? eager.serializationCount() : null,',
            '  churnedFunctions,',
            '  recorderWarmups: recorderLogs.filter(entry => "warmupMs" in entry).map(entry => entry.warmupMs),',
            '};',
            'if (strategy === "inspector") recorder.stop();',
            'if (strategy === "eager") eager.dispose();',
            'await worker.terminate();',
            'process.stdout.write(JSON.stringify(result));',
          ].join('\n');

          const { stdout } = await exec(
            process.execPath,
            [...v8Flags, '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', childScript],
            { timeout: 90_000, maxBuffer: 128 * 1024 },
          );
          return JSON.parse(stdout);
        };

        const inspector = await run('inspector');
        const eager = await run('eager');
        const eagerNoInlining = await run('eager', ['--no-turbo-inlining']);
        const gates = {
          sampleCap: eager.primary.sampleCount <= maxSamples &&
            eager.recoveryCapture.profile.samples <= maxSamples &&
            eager.delayed.cleanup.sampleCount <= maxSamples,
          primaryFixtureVisible: eager.primary.profile.usefulSamples >= 1,
          recoveredHotFrames: eager.recoveryCapture.profile.usefulSamples >= 3,
          discardedWithoutSerialization:
            !eager.disabledRevocation.serialized &&
            !eager.unsafeRevocation.serialized &&
            !eager.delayed.cleanup.serialized,
          disposedOnRevocation:
            eager.disabledRevocation.disposed &&
            eager.unsafeRevocation.disposed &&
            eager.delayed.cleanup.disposed,
          boundedMemory:
            eager.delayed.memory.peakRssDelta < 128 * 1024 * 1024 &&
            eager.delayed.memory.retainedHeapDelta < 16 * 1024 * 1024,
          lowerRecoveryGap:
            eager.recoveryWarmup.workerGapMaxMs < inspector.recoveryWarmup.workerGapMaxMs,
        };
        console.info('P-003 paired eager V8 profiler measurement:', JSON.stringify({
          inspector,
          eager,
          eagerNoInlining,
          inlineControl: {
            flag: '--no-turbo-inlining',
            defaultRecovery: {
              hotSamples: eager.recoveryCapture.profile.hotSamples,
              mapSamples: eager.recoveryCapture.profile.mapSamples,
              usefulSamples: eager.recoveryCapture.profile.usefulSamples,
            },
            noInliningRecovery: {
              hotSamples: eagerNoInlining.recoveryCapture.profile.hotSamples,
              mapSamples: eagerNoInlining.recoveryCapture.profile.mapSamples,
              usefulSamples: eagerNoInlining.recoveryCapture.profile.usefulSamples,
            },
          },
          gates: { ...gates, candidateQualified: Object.values(gates).every(Boolean) },
        }));

        expect(eager.primary.serialized).toBe(true);
        expect(eager.primary.profile.samples).toBeLessThanOrEqual(maxSamples);
        // Prove the fixture is visible in V8-emitted sample stacks before
        // interpreting a post-disposal miss as lifecycle recovery failure.
        expect(eager.primary.profile.usefulSamples).toBeGreaterThanOrEqual(1);
        expect(eager.primary.profile.bytes).toBeLessThan(8 * 1024 * 1024);
        expect(eagerNoInlining.recoveryCapture.workload.hotFrameCalls).toBeGreaterThan(0);
        expect(eagerNoInlining.recoveryCapture.workload.churnedFunctions).toBeGreaterThan(0);
        expect(eager.disabledRevocation.serialized).toBe(false);
        expect(eager.unsafeRevocation.serialized).toBe(false);
        expect(eager.delayed.cleanup.serialized).toBe(false);
        expect(eager.delayed.cleanup.disposed).toBe(true);
        expect(eager.serializations).toBe(2);
        expect(Number.isFinite(eager.recoveryWarmup.workerGapMaxMs)).toBe(true);
        expect(Number.isFinite(eager.delayed.workerGapMaxMs)).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
