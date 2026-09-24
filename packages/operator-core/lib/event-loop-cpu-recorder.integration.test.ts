import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const recorderPath = fileURLToPath(new URL('./event-loop-cpu-recorder.ts', import.meta.url));

describe('real monitor CPU recorder in an isolated Node process', () => {
  it('retains useful 100Hz samples across rotations, discards delayed work and releases its sampler', async () => {
    const { stdout } = await exec(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', `
      import { LoopCpuRecorder } from ${JSON.stringify(recorderPath)};
      import { performance } from 'node:perf_hooks';
      const retained = Array.from({ length: 25000 }, (_, i) => new Function('x', 'return x + ' + i));
      const observer = [], memory = [], starts = [], stops = [];
      const recorder = new LoopCpuRecorder(2000, (line, detail) => observer.push({ line, ...detail }));
      const measureIdle = async () => {
        const start = performance.now(), before = process.cpuUsage();
        await new Promise(r => setTimeout(r, 500));
        const cpu = process.cpuUsage(before);
        return { wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000 };
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
      } finally { recorder.stop(); }
      global.gc();
      process.stdout.write(JSON.stringify({ observer, memory, starts, stops, useful, maxSamples,
        maxBytes, before, active, after, delayedRejected, abortRejected, unavailable }));
    `], { timeout: 35_000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.info('P-003 product warm recorder:', JSON.stringify(result));
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
});
