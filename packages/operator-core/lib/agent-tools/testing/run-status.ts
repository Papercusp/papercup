/**
 * testing:run-status — poll a detached recovery started by testing:run.
 *
 * A foreground testing:run timeout starts an independent store-backed run and
 * returns its id. This read surface exposes the same bounded snapshot that the
 * admin testing route can read, so the timeout response points to a callable
 * agent tool rather than an operator-only HTTP route or an undefined "poll".
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { clipMarker, payloadTierRecoveryHint } from '../plans/shape-clip';
import {
  getForegroundRunVerdictAsync,
  getRunAsync,
  getTestRunLedgerRecoveryAsync,
  TestingRunSnapshotUnavailableError,
  type DetachedRunLedgerRecovery,
  type ForegroundRunVerdict,
  type RunSnapshot,
  type TestingRunReadDiagnostic,
} from '../../testing-run-store';
import { readForegroundKernelVerdict } from '../../testing-run-store-foreground-kernel';

type StatusSnapshot = Omit<RunSnapshot, 'command'> & {
  command?: string[];
  commandOmitted?: true;
  commandRecovery?: string;
};

interface RunDiagnostics {
  lastBootstrapPhase?: string;
  coreWitness?: { phase: 'core-witness-verified'; coreMode: 'compiled'; witnessSchemaVersion?: number };
  failure?: { status: RunSnapshot['status']; exitCode: number | null; message: string };
}

const recoverOutput = payloadTierRecoveryHint('testing:run-status');

/** Log failures occur at the end; a prefix-only clip hides their cause. */
function outputTail(output: string, cap: number): string {
  if (output.length <= cap) return output;
  const keep = cap - clipMarker(output.length, recoverOutput).length - 1;
  return `${clipMarker(output.length - keep, recoverOutput)}\n${output.slice(-keep)}`;
}

function runDiagnostics(snapshot: RunSnapshot): RunDiagnostics {
  const diagnostics: RunDiagnostics = {};
  for (const line of snapshot.output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.schemaVersion !== 'testing-run-bootstrap-v1' || typeof record.phase !== 'string') continue;
    diagnostics.lastBootstrapPhase = record.phase.slice(0, 120);
    // This phase is written only after the compiled producer witness matches.
    // Its presence says nothing about the eventual test or acceptance verdict.
    if (record.phase === 'core-witness-verified' && record.coreMode === 'compiled') {
      diagnostics.coreWitness = {
        phase: 'core-witness-verified', coreMode: 'compiled',
        ...(typeof record.witnessSchemaVersion === 'number'
          ? { witnessSchemaVersion: record.witnessSchemaVersion } : {}),
      };
    }
  }
  if (snapshot.status === 'fail' || snapshot.status === 'error') {
    diagnostics.failure = {
      status: snapshot.status, exitCode: snapshot.exitCode,
      message: outputTail(snapshot.output.trimEnd(), 512),
    };
  }
  return diagnostics;
}

function boundedSnapshot(snapshot: RunSnapshot): StatusSnapshot {
  const { command, ...rest } = snapshot;
  const output = outputTail(snapshot.output, 2048);
  return {
    ...rest,
    ...(JSON.stringify(command).length <= 512 ? { command }
      : { commandOmitted: true as const, commandRecovery: recoverOutput }),
    output,
    truncated: snapshot.truncated || output !== snapshot.output,
  };
}

export type TestingRunStatusResult =
  | { ok: true; snapshot: StatusSnapshot; diagnostics?: RunDiagnostics }
  | { ok: true; foreground: ForegroundRunVerdict }
  | { ok: true; ledgerRecovery: DetachedRunLedgerRecovery }
  | { ok: false; error: 'unknown_run'; runId: string; message: string }
  | { ok: false; error: 'snapshot_unavailable'; runId: string; retryable: true; message: string; readFailures?: TestingRunReadDiagnostic[] };

const argsSchema = z.object({
  runId: z
    .string()
    .min(1)
    .max(120)
    .describe('Pass testing:run timeout detachedRunId; the foreground origin runId also resolves when its durable alias is present.'),
});

export default defineTool({
  name: 'testing:run-status',
  // @not-a-cell live state, but a SINGLE DOOR keyed by an ephemeral run id: getRunAsync()
  // is the one local-first/durable snapshot oracle and the admin route consumes that same
  // function rather than re-deriving it. A scalar registry cell would require one entry per
  // detached run and add a read door without removing one.
  description:
    'Read detached testing:run recovery with testing:run-status { runId }. Pass the timeout response detachedRunId value; its top-level runId is the foreground origin and also resolves when the durable alias is present. Returns the lifecycle snapshot when available; if it is missing or unreadable, terminal per-file test_runs rows for the exact run_group_id can return a ledgerRecovery verdict. An absent/expired id returns unknown_run, and an unreadable snapshot without a terminal ledger verdict returns retryable snapshot_unavailable.',
  guidance: {
    when: 'Poll the detachedRunId returned by testing:run after a foreground timeout until its snapshot reaches a terminal status. Pass that value as this tool\'s runId; the response\'s top-level runId is the foreground origin.',
    notWhen:
      'Start a test run (use testing:run), read persisted test history (use testing:runs), or poll a capability:bash job (use capability:bash_output). unknown_run means neither a snapshot nor a terminal ledger verdict was found; snapshot_unavailable means the lifecycle store and terminal ledger verdict were unavailable and is retryable. Neither is evidence that the test passed.',
    chaining: 'testing:run → timeout { runId: foreground origin, detachedRunId: poll handle } → testing:run-status { runId: detachedRunId } until status is pass, fail, cancelled, or error.',
    seeAlso: ['testing:run (start an exact-file run)', 'testing:runs (read persisted test-run history)'],
  },
  capability: 'operator:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: argsSchema,
  async handler(args, ctx): Promise<{ data: TestingRunStatusResult }> {
    let snapshot: RunSnapshot | null;
    let snapshotUnavailable = false;
    const readFailures: TestingRunReadDiagnostic[] = [];
    const recordUnavailable = (error: unknown): void => {
      if (!(error instanceof TestingRunSnapshotUnavailableError)) throw error;
      snapshotUnavailable = true;
      if (error.diagnostic && readFailures.length < 3) readFailures.push(error.diagnostic);
    };
    try {
      snapshot = await getRunAsync(args.runId, undefined, undefined, undefined, readForegroundKernelVerdict);
    } catch (error) {
      recordUnavailable(error);
      snapshot = null;
    }
    if (snapshot) {
      if (snapshot.kind === 'vitest'
        && (snapshot.status === 'running' || snapshot.status === 'error' || snapshot.status === 'unknown')) {
        let ledgerRecovery: DetachedRunLedgerRecovery | null = null;
        try {
          ledgerRecovery = await getTestRunLedgerRecoveryAsync(args.runId);
        } catch (error) {
          if (!(error instanceof TestingRunSnapshotUnavailableError)) throw error;
        }
        if (ledgerRecovery?.status === 'pass') {
          return {
            data: {
              ok: true,
              ledgerRecovery: {
                ...ledgerRecovery,
                message:
                  `Recovered pass from ${ledgerRecovery.fileCount} latest per-file test_runs row(s); ` +
                  `the stale ${snapshot.status} lifecycle snapshot was superseded by terminal ledger evidence.`,
              },
            },
          };
        }
      }
      const fullOutputRequested =
        ctx.payloadTierOverride === 'full' && ctx.sourceMaterialization?.promotedToFull !== true;
      const diagnostics = runDiagnostics(snapshot);
      return { data: {
        ok: true,
        ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
        snapshot: fullOutputRequested ? snapshot : boundedSnapshot(snapshot),
      } };
    }

    let ledgerRecovery: DetachedRunLedgerRecovery | null = null;
    try {
      ledgerRecovery = await getTestRunLedgerRecoveryAsync(args.runId);
    } catch (error) {
      recordUnavailable(error);
    }
    if (ledgerRecovery) return { data: { ok: true, ledgerRecovery } };

    // A foreground run (e.g. one released by a host-shutdown handoff) has no
    // detached snapshot; its task row decides running vs recorded vs lost.
    try {
      const foreground = await getForegroundRunVerdictAsync(args.runId, undefined, readForegroundKernelVerdict);
      if (foreground) return { data: { ok: true, foreground } };
    } catch (error) {
      recordUnavailable(error);
    }

    if (snapshotUnavailable) {
      return {
        data: {
          ok: false,
          error: 'snapshot_unavailable',
          runId: args.runId,
          retryable: true,
          ...(readFailures.length ? { readFailures } : {}),
          message:
            'The detached lifecycle snapshot and a terminal per-file test_runs verdict were unavailable. Retry testing:run-status; this does not mean the run is absent or that the test passed.',
        },
      };
    }
    return {
      data: {
        ok: false,
        error: 'unknown_run',
        runId: args.runId,
        message:
          'No detached test-run snapshot or terminal per-file ledger verdict is available for this runId; it may be unknown or evicted after the one-hour retention window. If this came from a testing:run timeout response, try its detachedRunId value (the top-level runId is the foreground origin). This is not evidence that the test passed.',
      },
    };
  },
});
