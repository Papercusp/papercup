/**
 * churn.ts — Tier-1 churn + cold-join benches (P-006).
 *
 *   churn.cold-join — a fresh peer joins a swarm whose writer carries H ops of
 *     history: wall time from peer boot to every winner applied, vs H. This is
 *     the substrate portion of join-shared-harness (steps 4-5: boot_federate +
 *     await_admission_merge); the OAuth/clone/gist steps need GitHub and are
 *     out of a loopback bench's scope.
 *
 *   churn.reconnect-storm — all readers crash (SIGKILL) and rejoin AT ONCE
 *     against a writer with history: today's post-restart thundering-herd
 *     pattern. Measures per-reader rejoin catch-up and the writer's loop lag
 *     through the storm.
 *
 * KNOWN LIMIT this bench exposes (and exists to keep exposed): boot.ts caps
 * merge ingest at MAX_OPS_PER_AUTHOR=50k ops per log per pass with NO cursor,
 * so a cold-join against >50k ops of history never fully catches up until the
 * EI-79 residual (P-013, incremental merge cursor) lands. Artifacts record
 * `caughtUp:false` + the applied fraction rather than hiding it.
 */

import { ScenarioMeter, summarize } from '../metrics';
import type { PerfScenario, ScenarioRunCtx } from '../scenario-types';
import {
  spawnPeerChild,
  spawnProcMesh,
  foldChildResults,
  type PeerChildHandle,
} from '../child-driver';
import type { PeerChildResult } from '../peer-child';
import { generateCorpus } from '../corpus';

const CORPUS_AUTHOR = 'a'.repeat(64);

/** Distinct winner keys for a corpus — what a fully-caught-up reader applies. */
export function expectedWinnersFor(seed: number, count: number): number {
  const keys = new Set<string>();
  for (const op of generateCorpus({ seed, count, authorPubkey: CORPUS_AUTHOR })) {
    keys.add(`${op.table}::${op.hbKey}`);
  }
  return keys.size;
}

/** Catch-up budget: generous, scales with history (decode + apply is linear). */
function catchUpBudgetMs(size: number): number {
  return Math.max(60_000, Math.min(15 * 60_000, size * 3));
}

export const coldJoin: PerfScenario = {
  id: 'churn.cold-join',
  tier: 1,
  describe: 'Fresh peer joins a harness with H ops of history: boot → fully merged, vs H.',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    for (const size of ctx.sizes) {
      const winners = expectedWinnersFor(ctx.seed, size);
      ctx.log(`cold-join: H=${size} (${winners} winner keys) — seeding writer…`);
      const budget = catchUpBudgetMs(size);
      const mesh = await spawnProcMesh({
        readers: 1,
        log: ctx.log,
        writerCfg: { preSeed: size, seed: ctx.seed, corpusAuthor: CORPUS_AUTHOR },
        readerCfg: {
          mergePollMs: 1000,
          expectedWinners: winners,
          catchUpTimeoutMs: budget,
        },
        meshTimeoutMs: budget,
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'churn.cold-join',
          tier: 1,
          params: { historySize: size, winners, seed: ctx.seed },
        });
        if (size > 50_000) {
          meter.note(
            'historySize exceeds MAX_OPS_PER_AUTHOR (50k, no merge cursor) — full catch-up is ' +
              'EXPECTED to fail until the EI-79 residual (P-013) lands.',
          );
        }
        const reader = mesh.readers[0];
        const caught = await reader.waitFor('caught-up', budget);
        const results = [
          await mesh.writer.stopAndCollect(),
          await reader.stopAndCollect(),
        ];
        const r = results[1];
        const artifact = foldChildResults(
          meter,
          (a) => {
            if (r?.role === 'reader') {
              a.opsDecoded = r.appliedOps;
              a.notes.push(`caughtUp=${r.caughtUp ?? false} appliedKeys=${r.appliedKeys}/${winners}`);
              if (typeof r.catchUpMs === 'number') {
                a.metrics['coldJoinMs'] = summarize([r.catchUpMs], 'ms');
              } else {
                a.notes.push(
                  `reader never caught up within ${budget}ms — applied ${r.appliedKeys}/${winners} keys`,
                );
              }
            }
            if (!caught && r?.caughtUp) {
              a.notes.push('caught-up event raced the stop — using child-reported catchUpMs');
            }
          },
          results,
        );
        await ctx.emit(artifact);
      } finally {
        await mesh.teardown();
      }
    }
  },
};

export const reconnectStorm: PerfScenario = {
  id: 'churn.reconnect-storm',
  tier: 1,
  describe: 'All readers crash and rejoin at once against a writer with history (post-restart thundering herd).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const peers = Math.max(...ctx.peerCounts);
    const readersN = Math.max(1, peers - 1);
    const size = ctx.profile === 'smoke' ? 1_000 : 10_000;
    const winners = expectedWinnersFor(ctx.seed, size);
    const budget = catchUpBudgetMs(size);
    ctx.log(`reconnect-storm: ${readersN} readers, H=${size} — phase 1 (initial catch-up)…`);
    const mesh = await spawnProcMesh({
      readers: readersN,
      log: ctx.log,
      writerCfg: { preSeed: size, seed: ctx.seed, corpusAuthor: CORPUS_AUTHOR },
      readerCfg: { mergePollMs: 1000, expectedWinners: winners, catchUpTimeoutMs: budget },
      meshTimeoutMs: budget,
    });
    const respawned: PeerChildHandle[] = [];
    try {
      const meter = new ScenarioMeter({
        scenario: 'churn.reconnect-storm',
        tier: 1,
        params: { readers: readersN, historySize: size, winners, seed: ctx.seed },
      });

      for (const r of mesh.readers) {
        const ok = await r.waitFor('caught-up', budget);
        if (!ok) meter.note(`phase 1: reader ${r.cfg.peerIndex} never caught up`);
      }

      ctx.log('reconnect-storm: phase 2 — SIGKILL all readers, rejoin at once…');
      for (const r of mesh.readers) r.kill('SIGKILL');
      await new Promise((res) => setTimeout(res, 2000));

      const rejoin = meter.metric('rejoinCatchUpMs', 'ms');
      for (const r of mesh.readers) {
        respawned.push(
          spawnPeerChild(
            {
              ...r.cfg,
              expectedWinners: winners,
              catchUpTimeoutMs: budget,
            },
            ctx.log,
          ),
        );
      }
      const results: Array<PeerChildResult | null> = [];
      for (const r of respawned) {
        const caught = await r.waitFor('caught-up', budget);
        if (!caught) meter.note(`storm rejoin: reader ${r.cfg.peerIndex} never caught up`);
      }
      for (const r of respawned) {
        const res = await r.stopAndCollect();
        results.push(res);
        if (res?.role === 'reader' && typeof res.catchUpMs === 'number') {
          rejoin.push(res.catchUpMs);
        }
      }
      // Writer last: its loop lag covers the whole window including the storm.
      const writerRes = await mesh.writer.stopAndCollect();
      results.push(writerRes);
      if (writerRes) {
        meter.note(
          `writer loop-lag through storm: p95=${writerRes.loopLag.p95Ms}ms max=${writerRes.loopLag.maxMs}ms`,
        );
      }
      await ctx.emit(foldChildResults(meter, () => {}, results));
    } finally {
      for (const r of respawned) r.kill('SIGKILL');
      await mesh.teardown();
    }
  },
};

export const churnScenarios: PerfScenario[] = [coldJoin, reconnectStorm];
