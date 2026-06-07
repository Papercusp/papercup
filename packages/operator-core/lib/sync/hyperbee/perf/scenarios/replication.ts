/**
 * replication.ts — Tier-1 multi-process replication benches (P-005).
 *
 * Real OS processes per peer (see peer-child.ts for why), loopback transport
 * over a local testnet DHT. Two scenarios:
 *
 *   replication.sustained — append→visible latency at a sustained writer rate
 *     across a peer-count sweep. Readers merge at the PRODUCTION cadence
 *     (mergePollMs 1000), so the headline latency includes the 1Hz poll
 *     quantization — that is what a user experiences.
 *
 *   replication.ceiling — writer appends as fast as it can; readers merge at
 *     a tight cadence. The ceiling is ops/sec from `go` to every reader
 *     having applied all measurement ops. This is the EI-79-class stress
 *     case: reader loop lag during catch-up is the SLO metric that matters.
 *
 * The artifact's loop-lag/SLO verdict is the WORST child process (the
 * parent's own loop only orchestrates).
 */

import { ScenarioMeter, summarize } from '../metrics';
import type { PerfScenario, ScenarioRunCtx } from '../scenario-types';
import { spawnProcMesh, foldChildResults } from '../child-driver';

export const sustained: PerfScenario = {
  id: 'replication.sustained',
  tier: 1,
  describe: 'Append→visible latency at sustained writer rates across a peer-count sweep (production 1Hz reader merges).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const rates = ctx.profile === 'smoke' ? [10] : ctx.profile === 'ci' ? [10, 100] : [1, 10, 100];
    for (const peers of ctx.peerCounts) {
      for (const rate of rates) {
        // Enough ops for a stable distribution; bounded so a sweep stays sane.
        const count = Math.max(20, Math.min(rate * 20, 400));
        const mesh = await spawnProcMesh({
          readers: peers - 1,
          log: ctx.log,
          writerCfg: { rate, count, seed: ctx.seed },
          readerCfg: { mergePollMs: 1000, expectedWinners: count, catchUpTimeoutMs: 120_000 },
        });
        try {
          const meter = new ScenarioMeter({
            scenario: 'replication.sustained',
            tier: 1,
            params: { peers, rate, count },
          });
          ctx.log(`replication.sustained: peers=${peers} rate=${rate}/s count=${count} — go`);
          mesh.writer.send('go');
          const writerDone = await mesh.writer.waitFor(
            'writer-done',
            (count / Math.max(rate, 1)) * 1000 + 60_000,
          );
          if (!writerDone) meter.note('writer never reported done — partial run');
          // Wait for every reader to see all ops (bounded).
          for (const r of mesh.readers) {
            const ok = await r.waitFor('caught-up', 30_000);
            if (!ok) meter.note(`reader ${r.cfg.peerIndex} did not apply all ops in time`);
          }
          const results = [
            await mesh.writer.stopAndCollect(),
            ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
          ];
          const allLat: number[] = [];
          for (const r of results) {
            if (r?.role === 'reader' && r.latenciesRaw) allLat.push(...r.latenciesRaw);
          }
          const artifact = foldChildResults(
            meter,
            (a) => {
              a.metrics['appendToVisibleMs'] = summarize(allLat, 'ms');
              const w = results[0];
              if (w?.appendMs) a.metrics['appendCallMs'] = w.appendMs;
            },
            results,
          );
          await ctx.emit(artifact);
        } finally {
          await mesh.teardown();
        }
      }
    }
  },
};

export const ceiling: PerfScenario = {
  id: 'replication.ceiling',
  tier: 1,
  describe: 'Max replication throughput: writer floods, readers catch up (tight 200ms merges).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const count = ctx.profile === 'smoke' ? 300 : ctx.profile === 'ci' ? 1500 : 5000;
    for (const peers of ctx.peerCounts) {
      const mesh = await spawnProcMesh({
        readers: peers - 1,
        log: ctx.log,
        writerCfg: { rate: 0, count, seed: ctx.seed },
        readerCfg: { mergePollMs: 200, expectedWinners: count, catchUpTimeoutMs: 300_000 },
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'replication.ceiling',
          tier: 1,
          params: { peers, count },
        });
        ctx.log(`replication.ceiling: peers=${peers} count=${count} — go`);
        const tGo = Date.now();
        mesh.writer.send('go');
        const ceilingRate = meter.metric('ceilingOpsPerSec', 'ops/sec');
        const catchUp = meter.metric('floodCatchUpMs', 'ms');
        for (const r of mesh.readers) {
          const e = await r.waitFor('caught-up', 300_000);
          if (e) {
            const elapsed = Date.now() - tGo;
            catchUp.push(elapsed);
            ceilingRate.push(count / (elapsed / 1000));
          } else {
            meter.note(`reader ${r.cfg.peerIndex} never caught up — ceiling not reached`);
          }
        }
        const results = [
          await mesh.writer.stopAndCollect(),
          ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
        ];
        await ctx.emit(foldChildResults(meter, () => {}, results));
      } finally {
        await mesh.teardown();
      }
    }
  },
};

export const replicationScenarios: PerfScenario[] = [sustained, ceiling];
