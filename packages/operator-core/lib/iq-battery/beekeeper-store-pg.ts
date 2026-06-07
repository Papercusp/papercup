/**
 * PG store adapter for Beekeeper runner results (harness_shared schema).
 * Persists instance manifests, battery runs, and scores.
 */

import postgres from 'postgres';
import type { BeekeeperStore } from './beekeeper-runner';
import type { GymScore } from '../gym/judge';
import type { IQBatteryMetrics } from './collectors';
import type { InstanceManifest } from './instance-manifest';
import type { CorpusCase } from './corpus';

export class BeekeeperStorePg implements BeekeeperStore {
  constructor(private sql: postgres.Sql) {}

  async upsertInstance(manifest: InstanceManifest): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.beekeeper_instances
        (instance_id, workspace_id, code_sha, genome_id, memory_snapshot_id, battery_slice_id)
      VALUES
        (${manifest.instanceId}, ${manifest.workspaceId}, ${manifest.codeSha},
         ${manifest.genomeId || null}, ${manifest.memorySnapshotId || null},
         ${manifest.batterySliceId || null})
      ON CONFLICT (workspace_id, code_sha, genome_id) DO NOTHING
    `;
  }

  async upsertCorpusCase(c: CorpusCase): Promise<void> {
    // Store in a transient way; the corpus itself is external (P-001).
    // This is just for run-linking. In practice, cases are referenced by ID
    // and the full case data lives in the corpus store, not beekeeper.
    // Omitted for MVP — the case_id and case_variant on beekeeper_runs is sufficient.
  }

  async startRun(r: {
    runId: string;
    instanceId: string;
    caseId: string;
    caseVariant: string;
    caseTitle: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.beekeeper_runs
        (run_id, instance_id, case_id, case_variant, case_title)
      VALUES
        (${r.runId}, ${r.instanceId}, ${r.caseId}, ${r.caseVariant}, ${r.caseTitle})
    `;
  }

  async finishRun(
    runId: string,
    fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; elapsedMs: number }
  ): Promise<void> {
    await this.sql`
      UPDATE harness_shared.beekeeper_runs
      SET
        terminal_state = ${fields.terminalState},
        deterministic_signals = ${JSON.stringify(fields.deterministicSignals)},
        trace_ref = ${fields.traceRef || null},
        finished_at = now(),
        elapsed_ms = ${fields.elapsedMs}
      WHERE run_id = ${runId}
    `;
  }

  async recordScore(runId: string, score: GymScore, metrics: IQBatteryMetrics): Promise<void> {
    await this.sql`
      INSERT INTO harness_shared.beekeeper_scores
        (run_id, judge_model, rubric_hash, judge_temp, weights,
         success, tokens_per_task, time_to_green_secs, first_attempt_pass,
         recurrence, escalation, recall_hit,
         d1, d2, d3, composite, rationale)
      VALUES
        (${runId}, ${score.judgeModel}, ${score.rubricHash}, ${score.judgeTemp},
         ${JSON.stringify(score.weights)},
         ${metrics.success}, ${metrics.tokensPerSolvedTask}, ${metrics.timeToGreenSecs},
         ${metrics.firstAttemptPass},
         ${metrics.recurrence}, ${metrics.escalation}, ${metrics.recallHit},
         ${score.d1}, ${score.d2}, ${score.d3}, ${score.composite}, ${score.rationale || null})
    `;
  }
}

export async function createBeekeeperStore(sql: postgres.Sql): Promise<BeekeeperStore> {
  return new BeekeeperStorePg(sql);
}
