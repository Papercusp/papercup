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
import { spawnProcMesh, foldChildResults, awaitAllChildEvent } from '../child-driver';

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
        // EI-20581532536662596: ONE budget, used for BOTH the child's own catch-up
        // timeout and the parent's wait. These were previously two separate literals
        // (120_000 here, 30_000 at the wait below) — the parent abandoned at 30s a
        // child its own config gave 120s, and nothing made the drift visible.
        const catchUpBudgetMs = 120_000;
        const mesh = await spawnProcMesh({
          readers: peers - 1,
          log: ctx.log,
          writerCfg: { rate, count, seed: ctx.seed },
          readerCfg: { mergePollMs: 1000, expectedWinners: count, catchUpTimeoutMs: catchUpBudgetMs },
        });
        try {
          const meter = new ScenarioMeter({
            scenario: 'replication.sustained',
            tier: 1,
            params: { peers, rate, count },
          });
          meter.expectReaders(mesh.readers.length);
          ctx.log(`replication.sustained: peers=${peers} rate=${rate}/s count=${count} — go`);
          mesh.writer.send('go');
          const writerDone = await mesh.writer.waitFor(
            'writer-done',
            (count / Math.max(rate, 1)) * 1000 + 60_000,
          );
          if (!writerDone) meter.note('writer never reported done — partial run');
          // Wait for every reader to see all ops (bounded), CONCURRENTLY against a
          // SHARED deadline — every timer starts at the same instant here.
          //
          // EI-20581532536662596: this was a SERIAL loop giving each reader a FRESH
          // 30s budget. Because `waitFor` returns immediately for an already-fired
          // event (child-driver.ts:81-82), the reader polled FIRST got exactly 30s
          // from loop start while the Nth got 30s PLUS all the time already spent
          // waiting on readers 0..N-1 — so the deadline was a function of a reader's
          // POSITION IN THE ITERATION ORDER rather than of the run. The signature was
          // unmistakable once looked for: across 7 runs at 48 peers every failing run
          // missed by EXACTLY ONE reader (46/47, never 45), because the first slow
          // reader burned its budget and thereby widened everyone else's. That made a
          // red `convergencePassed` unable to distinguish "the substrate failed" from
          // "the box was loaded and a fixed timer tripped" — on a shared box running an
          // agent fleet, load alone flipped this verdict (6 repeats at a FIXED 48 peers
          // went FAIL/FAIL/pass/pass/pass/pass, the two failures being the two slowest
          // runs). Do not reintroduce a per-reader budget measured from when the loop
          // happens to reach that reader.
          const settled = await awaitAllChildEvent(mesh.readers, 'caught-up', catchUpBudgetMs);
          // Record the GOALPOST and the observed times, not just the verdict —
          // a bare converged/not binary cannot distinguish "cleared the budget
          // with 110s to spare" from "cleared it by 200ms", which is exactly
          // what makes a green ladder unattributable after a budget change.
          meter.convergenceBudget(catchUpBudgetMs);
          for (const { reader, event, elapsedMs } of settled) {
            if (event) meter.readerConverged(reader.cfg.peerIndex, elapsedMs);
            else meter.readerDidNotConverge(reader.cfg.peerIndex);
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
        meter.expectReaders(mesh.readers.length);
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
            meter.readerDidNotConverge(r.cfg.peerIndex, 'never caught up — ceiling not reached');
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
