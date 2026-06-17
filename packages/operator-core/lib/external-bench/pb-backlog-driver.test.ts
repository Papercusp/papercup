/**
 * PaperBench fleet-arm backlog driver tests (benchmark-suite-paperbench-2026-06-17 #18, the dual-arm
 * unification). Focus: the driver implements the canonical HiveBacklogDriver contract — emits a
 * HiveBacklogResult (FleetTaskResult[] + ConcurrencyTimeline) with the produced-tree provenance
 * (suite / submitted / filesWritten / hasReproduceSh) on armMeta; never-throws; runs on BOTH arms; and the
 * GATED live arm (realPaperReplicationOps → PaperBenchArmNotReadyError) cleanly settles as a non-ok row
 * (not a throw). Fake ops write a temp tree — no arm / no LLM / no docker / no spend.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paperBenchBacklogDriver, runPaperBenchSuiteViaFleet } from './pb-backlog-driver';
import type { PaperReplicationOps, PaperReplicationRequest } from './_pb_hive_solve';
import type { BenchTask, GenerationBudget } from './types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const task = (n: number): BenchTask => ({
  benchmark: 'paperbench',
  instanceId: `paper-${n}`,
  problemStatement: `replicate paper ${n}`,
  graderMeta: { paperId: `paper-${n}` },
});

/** Build a request whose outDir is a fresh temp dir the (fake) arm will populate. */
function buildRequest(input: { task: BenchTask; arm: string; seed: string; budget: GenerationBudget }): PaperReplicationRequest {
  const outDir = mkdtempSync(join(tmpdir(), 'pb-test-'));
  dirs.push(outDir);
  return {
    paperId: input.task.instanceId,
    paperContext: { paperId: input.task.instanceId, paperDir: '', instructions: '', paperMd: '', addendum: '', blacklist: '', pdfPath: null },
    outDir,
    arm: input.arm,
    budgetUsd: input.budget.maxUsd ?? 40,
    codeOnly: true,
    runId: 'pb-test',
    workspaceId: 'ws',
  };
}

/** Fake arm that writes a replication tree (code + reproduce.sh) into outDir → a gradable submission. */
const writingOps: PaperReplicationOps = {
  async drive(req) {
    writeFileSync(join(req.outDir, 'reproduce.sh'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(req.outDir, 'model.py'), 'print(1)\n');
    return { filesWritten: 2, costUsd: 0.5, agentId: `agent-${req.paperId}` };
  },
};

const BACKLOG = [0, 1, 2].map(task);

describe('paperBenchBacklogDriver', () => {
  it('emits the canonical HiveBacklogResult with suite/submitted/tree-provenance on armMeta', async () => {
    const driver = paperBenchBacklogDriver({ concurrencyCap: () => 2, buildRequest, ops: writingOps, sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'paperbench', runId: 'r1', seed: 0, backlog: BACKLOG, budget: { maxUsd: 40 } });

    expect(res.arm).toBe('su-independent');
    expect(res.suite).toBe('paperbench');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults).toHaveLength(3);
    expect(res.concurrencyTimeline).toBeDefined();

    const t0 = res.taskResults.find((t) => t.attempt.instanceId === 'paper-0')!;
    expect(t0.attempt.armMeta!.suite).toBe('paperbench');
    expect(t0.attempt.armMeta!.submitted).toBe(true); // non-empty tree → gradable
    expect(t0.attempt.armMeta!.filesWritten).toBe(2);
    expect(t0.attempt.armMeta!.hasReproduceSh).toBe(true);
    expect(t0.attempt.stopReason).toBe('done');
    expect(t0.attempt.costUsd).toBe(0.5);
    expect(t0.disposition).toBe('spawn');
  });

  it('an empty submission → submitted=false (excluded), never throws', async () => {
    const emptyOps: PaperReplicationOps = { async drive() { return { filesWritten: 0, costUsd: 0.1, agentId: null }; } };
    const driver = paperBenchBacklogDriver({ concurrencyCap: () => 2, buildRequest, ops: emptyOps, sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'paperbench', runId: 'r', seed: 0, backlog: BACKLOG, budget: {} });
    expect(res.taskResults).toHaveLength(3);
    for (const t of res.taskResults) {
      expect(t.attempt.armMeta!.submitted).toBe(false); // empty tree → grader excludes it
      expect(t.attempt.stopReason).toBe('infra-failed');
    }
  });

  it('the GATED live arm (realPaperReplicationOps) settles each task as a non-ok row, NOT a throw', async () => {
    // No `ops` → defaults to realPaperReplicationOps → paperbench-arm-binding.drivePaperViaArm throws
    // PaperBenchArmNotReadyError, which drivePaperReplication catches → a non-ok result.
    const driver = paperBenchBacklogDriver({ concurrencyCap: () => 2, buildRequest, sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'hive-realqueen', suite: 'paperbench', runId: 'r', seed: 0, backlog: [task(0)], budget: {} });
    expect(res.runError).toBeUndefined(); // the RUN didn't error — the task settled cleanly
    expect(res.taskResults).toHaveLength(1);
    const t = res.taskResults[0];
    expect(t.attempt.armMeta!.submitted).toBe(false);
    expect(t.attempt.stopReason).toBe('infra-failed');
    expect(t.attempt.generationError).toContain('cannot drive paper'); // the gate message, surfaced not thrown
  });
});

describe('runPaperBenchSuiteViaFleet', () => {
  it('runs BOTH arms through the shared fleet contract → one canonical record per arm', async () => {
    const banked: string[] = [];
    const out = await runPaperBenchSuiteViaFleet({
      tasks: BACKLOG,
      concurrencyCap: () => 2,
      buildRequest,
      opsFor: () => writingOps,
      sampleIntervalMs: 1,
      onTaskCollected: (arm) => { banked.push(arm); },
    });
    expect(out.fleet.map((f) => f.fleetArm).sort()).toEqual(['hive-realqueen', 'su-independent']);
    for (const f of out.fleet) {
      expect(f.result.suite).toBe('paperbench');
      expect(f.result.taskResults).toHaveLength(3);
    }
    expect(banked.length).toBe(6); // 3 papers × 2 arms
  });
});
