/** P-003: exercise the native profiler in an isolated process, never the test host.
 * This is a mechanism/overhead experiment, not evidence of production p95 or a
 * hard memory bound when the main thread cannot rotate a recording.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('bounded overlapping V8 recordings', () => {
  it('preserves useful stacks, rotates without rebuilding native state, and cleans up', async () => {
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
        const until = performance.now() + 30;
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
    console.info('P-003 overlap fixture:', JSON.stringify(result));
    expect(result.anchorCount).toBe(0);
    expect(result.peakAnchors).toBe(2);
    expect(result.ended).toBe(49);
    expect(result.uniqueEnded).toBe(49);
    expect(result.usefulProfiles).toBe(50);
    expect(result.maxAnchorSamples).toBeGreaterThan(0);
    // Broad regression bounds for this controlled 60ms fixture, not a claim
    // that a main-thread timer can enforce a bound during an arbitrary stall.
    expect(result.maxAnchorSamples).toBeLessThan(10_000);
    expect(result.maxAnchorBytes).toBeLessThan(8 * 1024 * 1024);
    expect(Math.max(...result.heap) - Math.min(...result.heap)).toBeLessThan(16 * 1024 * 1024);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    expect(median(result.startMs)).toBeLessThan(Math.min(result.coldBefore, result.coldAfter) / 2);
  }, 60_000);

  it('measures steady idle sampling cost separately from profiler startup', async () => {
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
    console.info('P-003 idle sampler CPU:', JSON.stringify(result));
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const fraction = (row: { cpuMs: number; wallMs: number }) => row.cpuMs / row.wallMs;
    // A generous detector of a runaway sampler, not a production cost SLO.
    expect(median(result.active.map(fraction)) - median(result.baseline.map(fraction))).toBeLessThan(0.1);
  }, 30_000);
});
