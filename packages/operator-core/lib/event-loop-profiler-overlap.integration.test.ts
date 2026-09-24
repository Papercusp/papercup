/** P-003: exercise the native profiler in an isolated process, never the test host.
 * This is a mechanism/overhead experiment, not evidence of production p95 or a
 * hard memory bound when the main thread cannot rotate a recording.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('bounded overlapping V8 recordings', () => {
  it.each([1000, 10_000])('preserves useful stacks and cleanup at a %i microsecond sampling interval', async (samplingIntervalUs) => {
    const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
      import { Session } from 'node:inspector/promises';
      import { performance } from 'node:perf_hooks';
      const retained = Array.from({ length: 25000 }, (_, i) => new Function('x', 'return x + ' + i));
      const session = new Session();
      const ended = [];
      let anchorCount = 0, peakAnchors = 0, maxAnchorSamples = 0, maxAnchorBytes = 0;
      let usefulProfiles = 0, anchorId = 0;
      const startMs = [], rotateMs = [], heap = [], rss = [];
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      function profilerFixtureWork() {
        const until = performance.now() + ${samplingIntervalUs === 1000 ? 30 : 100};
        let value = 0;
        while (performance.now() < until) value = retained[value % retained.length](value) % 100000;
        return value;
      }
      session.connect();
      session.on('Profiler.consoleProfileFinished', ({ params }) => {
        anchorCount--;
        ended.push(params.title);
        maxAnchorSamples = Math.max(maxAnchorSamples, params.profile.samples?.length ?? 0);
        maxAnchorBytes = Math.max(maxAnchorBytes, Buffer.byteLength(JSON.stringify(params.profile)));
      });
      const beginAnchor = () => {
        const name = 'papercusp-fixture-' + ++anchorId;
        console.profile(name);
        anchorCount++;
        peakAnchors = Math.max(peakAnchors, anchorCount);
        return name;
      };
      const capture = async () => {
        const before = performance.now();
        await session.post('Profiler.start');
        const start = performance.now() - before;
        profilerFixtureWork();
        await sleep(30);
        const { profile } = await session.post('Profiler.stop');
        // V8 can inline profilerFixtureWork into capture. performance.now is
        // called repeatedly by the work loop in either representation; require
        // multiple sampled ticks, not just the initial inspector-dispatch stack.
        const workIds = new Set(profile.nodes.filter(n => ['profilerFixtureWork', 'now'].includes(n.callFrame.functionName)).map(n => n.id));
        // A stack node alone isn't a sample: require actual samples at the work
        // frame or one of its descendants.
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of profile.nodes) if (workIds.has(node.id)) {
            for (const child of node.children ?? []) if (!workIds.has(child)) { workIds.add(child); changed = true; }
          }
        }
        if (profile.samples.filter(id => workIds.has(id)).length >= 3) usefulProfiles++;
        return start;
      };
      let anchor;
      let coldBefore, coldAfter;
      try {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: ${samplingIntervalUs} });
        coldBefore = await capture();
        anchor = beginAnchor();
        for (let batch = 0; batch < 4; batch++) {
          for (let i = 0; i < 12; i++) {
            startMs.push(await capture());
            const before = performance.now();
            const next = beginAnchor();
            console.profileEnd(anchor);
            anchor = next;
            rotateMs.push(performance.now() - before);
          }
          global.gc();
          heap.push(process.memoryUsage().heapUsed);
          rss.push(process.memoryUsage().rss);
        }
        console.profileEnd(anchor);
        anchor = undefined;
        coldAfter = await capture();
      } finally {
        if (anchor) console.profileEnd(anchor);
        session.disconnect();
      }
      global.gc();
      process.stdout.write(JSON.stringify({ coldBefore, coldAfter, startMs, rotateMs, heap, rss,
        finalHeap: process.memoryUsage().heapUsed, anchorCount, peakAnchors,
        ended: ended.length, uniqueEnded: new Set(ended).size, maxAnchorSamples, maxAnchorBytes, usefulProfiles }));
    `], { timeout: 45_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 overlap fixture:', JSON.stringify({ samplingIntervalUs, ...result }));
    expect(result.anchorCount).toBe(0);
    expect(result.peakAnchors).toBe(2);
    expect(result.ended).toBe(49);
    expect(result.uniqueEnded).toBe(49);
    expect(result.usefulProfiles).toBe(50);
    expect(result.maxAnchorSamples).toBeGreaterThan(0);
    // Broad regression bounds for this controlled short fixture, not a claim
    // that a main-thread timer can enforce a bound during an arbitrary stall.
    expect(result.maxAnchorSamples).toBeLessThan(10_000);
    expect(result.maxAnchorBytes).toBeLessThan(8 * 1024 * 1024);
    expect(Math.max(...result.heap) - Math.min(...result.heap)).toBeLessThan(16 * 1024 * 1024);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    expect(median(result.startMs)).toBeLessThan(Math.min(result.coldBefore, result.coldAfter) / 2);
  }, 60_000);

  it.each([1000, 10_000])('measures idle sampling cost separately from startup at %i microseconds', async (samplingIntervalUs) => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { Session } from 'node:inspector/promises';
      import { performance } from 'node:perf_hooks';
      const session = new Session();
      const baseline = [], active = [];
      const measure = async () => {
        const before = process.cpuUsage(), start = performance.now();
        await new Promise(resolve => setTimeout(resolve, 500));
        const cpu = process.cpuUsage(before);
        return { cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - start };
      };
      session.connect();
      try {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: ${samplingIntervalUs} });
        for (let i = 0; i < 4; i++) {
          baseline.push(await measure());
          // Construction and destruction are OUTSIDE the measured window.
          console.profile('idle-cost');
          active.push(await measure());
          console.profileEnd('idle-cost');
        }
        baseline.push(await measure());
      } finally { session.disconnect(); }
      process.stdout.write(JSON.stringify({ baseline, active }));
    `], { timeout: 20_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 idle sampler CPU:', JSON.stringify({ samplingIntervalUs, ...result }));
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const fraction = (row: { cpuMs: number; wallMs: number }) => row.cpuMs / row.wallMs;
    // A generous detector of a runaway sampler, not a production cost SLO.
    expect(median(result.active.map(fraction)) - median(result.baseline.map(fraction))).toBeLessThan(0.1);
  }, 30_000);

  it('measures loaded 100Hz recording and exposes delayed-rotation growth', async () => {
    const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
      import { Session } from 'node:inspector/promises';
      import { performance } from 'node:perf_hooks';
      const retained = Array.from({ length: 25000 }, (_, i) => new Function('x', 'return x + ' + i));
      const data = Int32Array.from({ length: 8192 }, (_, i) => i * 17);
      const work = () => {
        let value = retained.length;
        // One hot calculation reaches a stable tier. Calling all 25,000 generated
        // functions instead kept compiling between the before/after controls.
        for (let i = 0; i < 25000000; i++) value = Math.imul(value ^ data[i & 8191], 1664525) | 0;
        return value;
      };
      const measure = () => {
        const before = process.cpuUsage(), start = performance.now();
        const checksum = work();
        const cpu = process.cpuUsage(before);
        return { checksum, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - start };
      };
      for (let i = 0; i < 12; i++) work(); // compile/tier-up the same fixed workload first
      const baselineBefore = Array.from({ length: 4 }, measure);
      global.gc();
      const beforeMemory = process.memoryUsage();
      const active = [], memory = [], ended = [];
      let maxSamples = 0, maxBytes = 0, delayed;
      const session = new Session();
      session.connect();
      session.on('Profiler.consoleProfileFinished', ({ params }) => {
        ended.push(params.title);
        maxSamples = Math.max(maxSamples, params.profile.samples.length);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(params.profile)));
        if (params.title === 'loaded-0') delayed = {
          durationUs: params.profile.endTime - params.profile.startTime,
          samples: params.profile.samples.length,
        };
      });
      let anchor = 'loaded-0';
      try {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 10000 });
        console.profile(anchor);
        // Simulate a rotation tick delayed by synchronous work. The native
        // recording continues while JS cannot rotate it: do not call that capped.
        const until = performance.now() + 1000;
        while (performance.now() < until) work();
        for (let i = 1; i <= 24; i++) {
          active.push(measure());
          const next = 'loaded-' + i;
          console.profile(next);
          console.profileEnd(anchor);
          anchor = next;
          if (i % 4 === 0) { global.gc(); memory.push(process.memoryUsage()); }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        console.profileEnd(anchor);
        anchor = undefined;
      } finally {
        if (anchor) console.profileEnd(anchor);
        session.disconnect();
      }
      global.gc();
      const afterMemory = process.memoryUsage();
      const baselineAfter = Array.from({ length: 4 }, measure);
      process.stdout.write(JSON.stringify({ baselineBefore, active, baselineAfter, beforeMemory,
        memory, afterMemory, ended: ended.length, maxSamples, maxBytes, delayed }));
    `], { timeout: 90_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 loaded sampler:', JSON.stringify(result));
    const rows = [...result.baselineBefore, ...result.active, ...result.baselineAfter];
    expect(new Set(rows.map((row) => row.checksum)).size).toBe(1);
    expect(result.ended).toBe(25);
    expect(result.delayed.durationUs).toBeGreaterThan(1_000_000);
    expect(result.delayed.samples).toBeGreaterThan(10);
    expect(result.maxBytes).toBeLessThan(8 * 1024 * 1024);
    const heaps = result.memory.map((row: { heapUsed: number }) => row.heapUsed);
    expect(Math.max(...heaps) - Math.min(...heaps)).toBeLessThan(16 * 1024 * 1024);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const baselineCpu = median([...result.baselineBefore, ...result.baselineAfter].map((row) => row.cpuMs));
    const controlRatio = median(result.baselineBefore.map((row: { cpuMs: number }) => row.cpuMs)) /
      median(result.baselineAfter.map((row: { cpuMs: number }) => row.cpuMs));
    expect(controlRatio).toBeGreaterThan(0.85);
    expect(controlRatio).toBeLessThan(1.15);
    // Broad runaway detector; log the actual tradeoff for acceptance review.
    expect(median(result.active.map((row: { cpuMs: number }) => row.cpuMs)) / baselineCpu).toBeLessThan(1.25);
  }, 100_000);
});
