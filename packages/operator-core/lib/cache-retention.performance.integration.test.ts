import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const cacheRoot = fileURLToPath(new URL('../../../libs/generic/cache/', import.meta.url));
const fingerprint = (source: string) => createHash('sha256').update(source).digest('hex');
const moduleUrl = (source: string) => 'data:text/javascript;base64,' +
  Buffer.from(transformSync(source, { loader: 'ts', format: 'esm', target: 'node25' }).code).toString('base64');

function sources(control: boolean) {
  // Optional historical comparison reads objects, never changes the shared tree.
  // The recurring guard's control removes only pruning from the current source.
  const ref = control ? process.env.CACHE_RETENTION_BASELINE_REF : undefined;
  const read = (path: string) => ref
    ? execFileSync('git', ['show', ref + ':src/' + path], { cwd: cacheRoot, encoding: 'utf8' })
    : readFileSync(cacheRoot + 'src/' + path, 'utf8');
  let cache = read('cache.ts');
  const l1 = read('l1.ts');
  const generationStore = readFileSync(cacheRoot + 'src/generation-store.ts', 'utf8');
  const sourceHashes = { cache: fingerprint(cache), l1: fingerprint(l1), generationStore: fingerprint(generationStore) };
  if (control && !ref) cache = cache.replace(/^\s*this\.l1\.prune\([^\n]+\);/m, '');
  const linked = cache
    .replace("'./l1'", JSON.stringify(moduleUrl(l1)))
    // A data module has no filesystem base URL. Compile both pure dependencies
    // into data modules too, so child startup cannot depend on tsx path resolution.
    .replace("'./generation-store'", JSON.stringify(moduleUrl(generationStore)));
  return { module: moduleUrl(linked), sourceHashes, controlKind: !control ? 'current' : ref ? 'historical:' + ref : 'current-with-pruning-removed' };
}

async function cohort(control: boolean) {
  const source = sources(control);
  const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { performance } from 'node:perf_hooks';
    const { Cache } = await import(${JSON.stringify(source.module)});
    let now = 0;
    const cache = new Cache({ clock: () => now, maxL1Entries: 50000 });
    const weak = [];
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const collect = async () => { for (let i = 0; i < 3; i++) { await settle(); global.gc(); } };
    const memory = () => {
      const pss = readFileSync('/proc/self/smaps_rollup', 'utf8').match(/^Pss:\\s+(\\d+) kB$/m);
      return { ...process.memoryUsage(), pssBytes: pss ? Number(pss[1]) * 1024 : null };
    };
    const idle = async () => {
      const start = performance.now(), cpu = process.cpuUsage();
      await new Promise(resolve => setTimeout(resolve, 100));
      const used = process.cpuUsage(cpu);
      return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 };
    };
    await collect();
    const empty = memory();
    async function fill() {
      // R9 measured 1042 entries / 438 expired; payloads are synthetic, unique
      // 948-row contexts, not copied production content or retained-byte estimates.
      for (let i = 0; i < 438; i++) await cache.getOrSet('fixture', 'cold-' + i, () => {
        const value = Array.from({ length: 948 }, (_, row) => ({ row, body: (i + ':' + row + ':').padEnd(256, 'x') }));
        weak.push(new WeakRef(value));
        return value;
      }, { hardTtlMs: 100 });
      for (let i = 0; i < 604; i++) await cache.getOrSet('fixture', 'warm-' + i, () => ({ useful: i }));
    }
    await fill();
    await collect();
    const populated = memory();
    const idleBefore = await idle();
    now = 100;
    await collect();
    const expiredIdle = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 32; i++) {
      const value = await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('useful context rebuilt'); });
      if (value.useful !== i % 604) throw new Error('useful context changed');
    }
    const used = process.cpuUsage(cpu);
    const reclamation = { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, reads: 32 };
    await collect();
    const ordinary = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    const idleAfter = await idle();
    // Warm up both arms, then report equal-size blocks; exact timing is evidence,
    // not a machine-dependent CI latency assertion.
    for (let i = 0; i < 2000; i++) await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('miss'); });
    const blocks = [];
    for (let block = 0; block < 9; block++) {
      const before = process.cpuUsage(), t = performance.now();
      for (let i = 0; i < 10000; i++) await cache.getOrSet('fixture', 'warm-' + (i % 604), () => { throw new Error('miss'); });
      const cpu = process.cpuUsage(before);
      blocks.push({ reads: 10000, wallMs: performance.now() - t, cpuMs: (cpu.user + cpu.system) / 1000 });
    }
    cache.clearL1();
    await collect();
    const cleared = { memory: memory(), entries: cache.l1.size, reachable: weak.filter(ref => ref.deref()).length };
    process.stdout.write(JSON.stringify({ pid: process.pid, node: process.version, empty, populated,
      expiredIdle, ordinary, cleared, idleBefore, idleAfter, reclamation, blocks, stats: cache.stats }));
  `], { timeout: 20_000, maxBuffer: 64 * 1024, env: { ...process.env, NODE_OPTIONS: '' } });
  return { control, controlKind: source.controlKind, sourceHashes: source.sourceHashes, ...JSON.parse(stdout) };
}

describe('cache retained roots and resource costs in isolated processes', () => {
  it('reclaims untouched expired contexts during useful reads, preserves live contexts, and releases on clear', async () => {
    const control = await cohort(true);
    const current = await cohort(false);
    console.info('P011 cache resource comparison:', JSON.stringify({ control, current }));
    for (const arm of [control, current]) {
      expect(arm.expiredIdle.entries).toBe(1042);
      expect(arm.expiredIdle.reachable).toBe(438);
      expect(arm.cleared.entries).toBe(0);
      expect(arm.cleared.reachable).toBe(0);
      expect(arm.stats.builds).toBe(1042);
      expect(arm.stats.singleFlightJoins).toBe(0);
    }
    expect(control.ordinary.entries).toBe(1042);
    expect(control.ordinary.reachable).toBe(438);
    expect(current.ordinary.entries).toBe(604);
    expect(current.ordinary.reachable).toBe(0);
    // Large class-level guard; PSS/RSS need not shrink with allocator retention.
    expect(control.ordinary.memory.heapUsed - current.ordinary.memory.heapUsed).toBeGreaterThan(8 * 1024 * 1024);
  }, 45_000);
});
