/**
 * testing:record-run — register an already-executed non-Vitest check in the
 * canonical test_runs execution ledger.
 *
 * This is deliberately a recorder, not a shell runner. The evidence must be a
 * committed docs/evidence JSON artifact whose bytes describe the command,
 * timestamps, exit code, and individual assertions. The server derives the
 * verdict from those bytes, pins their SHA-256 and HEAD commit, and returns the
 * exact numeric row IDs that plans:bind-spec-evidence accepts. An archivedMutation
 * artifact can recover failed case identities from a committed raw mutation log
 * after validating it against the original scoped receipt. Recovery appends a
 * labelled row and preserves the original execution; it does not run a new test.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { parseTestRunExecutionDetails, isRecordedCaseTitle } from '@papercusp/test-config/execution-details';
import { runGit } from '../../harness/docs/git-runner';
import {
  findHarnessTestRunIds,
  persistHarnessTestRunsWithIds,
  type HarnessTestFileRow,
  type PersistHarnessTestRunsParams,
  type PersistHarnessTestRunsResult,
} from '../../testing-run-store';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { harnessArg, harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_OPERATIONAL_EVIDENCE_BYTES = 256 * 1024;

const mutationProbeReplaySchema = z.object({
  schemaVersion: z.literal(1),
  runnerPath: z.literal('scripts/mutation-probe.sh'),
  runnerSha256: sha256Schema,
  runnerCommit: z.string().regex(/^[a-f0-9]{40}$/),
  cwd: z.string().trim().min(1).max(400),
  argv: z.array(z.string().min(1).max(10_000)).min(2).max(50),
  result: z.object({
    verdict: z.enum(['caught', 'survived', 'harness-error', 'inconclusive']),
    expected: z.enum(['caught', 'survived']),
    target: z.string().trim().min(1).max(100),
    baselineExit: z.number().int(),
    guardExit: z.number().int(),
    mutantParse: z.string().trim().min(1).max(100),
    assertionEvidence: z.string().trim().min(1).max(300),
    relocation: z.string().trim().min(1).max(100),
  }),
});

const operationalEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('operational-test-evidence'),
    name: z.string().trim().min(1).max(300),
    framework: z.enum(['playwright', 'node', 'shell', 'cargo', 'operational']),
    command: z.array(z.string().min(1).max(1000)).min(1).max(50),
    exitCode: z.number().int(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    summary: z.string().trim().min(1).max(3000),
    assertions: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(200),
          passed: z.boolean(),
          evidence: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(100),
    mutationProbes: z.array(mutationProbeReplaySchema).min(1).max(100).optional(),
    archivedMutation: z.object({
      originalTestRunId: z.number().int().positive(),
      rawLogFile: z.string().min(1).max(400),
      rawLogSha256: sha256Schema,
    }).optional(),
  })
  .passthrough();

export type OperationalEvidenceArtifact = z.infer<typeof operationalEvidenceArtifactSchema>;

export interface CommittedOperationalEvidence {
  artifact: OperationalEvidenceArtifact;
  filePath: string;
  sha256: string;
  commit: string;
  /** Exact committed bytes loaded by the inspector, never caller-supplied names. */
  archiveLog?: string;
}

export interface ArchivedMutationRun {
  id: number | string;
  file_path: string;
  status: string;
  source: string;
  framework: string;
  workspace_id: string | null;
  harness_slug: string | null;
  commit_sha: string | null;
  worktree_dirty: boolean;
  started_at: string | Date;
  finished_at: string | Date | null;
  execution_details: unknown;
}

type RecordContext = {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  projectDir?: string;
};

export interface RecordOperationalRunDeps {
  inspectEvidence: (
    root: string,
    filePath: string,
    expectedSha256: string,
  ) => CommittedOperationalEvidence | Promise<CommittedOperationalEvidence>;
  findIds: typeof findHarnessTestRunIds;
  persist: (params: PersistHarnessTestRunsParams) => Promise<PersistHarnessTestRunsResult>;
  readArchivedRun?: (id: number, scope: { workspaceId: string; harnessSlug: string }) => Promise<ArchivedMutationRun | null>;
}

const DEFAULT_DEPS: RecordOperationalRunDeps = {
  inspectEvidence: inspectCommittedOperationalEvidence,
  findIds: findHarnessTestRunIds,
  persist: persistHarnessTestRunsWithIds,
  async readArchivedRun(id, scope) {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT id, file_path, status, source, framework, workspace_id, harness_slug,
             commit_sha, worktree_dirty, started_at, finished_at, execution_details
        FROM harness_shared.test_runs
       WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}`;
    return (rows[0] as unknown as ArchivedMutationRun | undefined) ?? null;
  },
};

function insideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function gitOutput(root: string, args: string[]): Promise<Buffer> {
  const result = await runGit(args, root);
  if (result.code !== 0) throw new Error('git_command_failed');
  return Buffer.from(result.stdout, 'utf8');
}

export function parseOperationalEvidenceArtifact(bytes: Buffer): OperationalEvidenceArtifact {
  if (bytes.byteLength > MAX_OPERATIONAL_EVIDENCE_BYTES) {
    throw new Error(
      `evidence_too_large: ${bytes.byteLength} bytes exceeds the ${MAX_OPERATIONAL_EVIDENCE_BYTES}-byte limit. ` +
        'Store bulky payloads as a raw artifact pinned by SHA-256 and keep the docs/evidence JSON small.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('evidence_invalid_json');
  }
  const result = operationalEvidenceArtifactSchema.safeParse(parsed);
  if (!result.success) {
    // Name every failing field: a bare "expected string, received undefined"
    // gives an artifact author nothing to fix (WI-10003460).
    const issues = result.error.issues.slice(0, 5).map((issue) =>
      `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
    const more = result.error.issues.length > 5 ? ` (+${result.error.issues.length - 5} more)` : '';
    throw new Error(`evidence_schema_invalid: ${issues.join('; ') || 'invalid'}${more}`);
  }
  const artifact = result.data;
  if (artifact.archivedMutation && !artifact.mutationProbes?.length) {
    throw new Error('evidence_archived_mutation_probe_required');
  }
  const mutationProbeEvidence =
    artifact.mutationProbes !== undefined ||
    artifact.command.some((part) => /mutation[-_ ]probe/i.test(part)) ||
    /mutation[-_ ]probe/i.test(
      `${artifact.summary}\n${artifact.assertions.map((assertion) => assertion.evidence).join('\n')}`,
    );
  if (mutationProbeEvidence) {
    const referencesSharedScratch = (value: string) =>
      value.replace(/\\/g, '/').toLowerCase().includes('.papercusp/scratch');
    if (artifact.command.some(referencesSharedScratch)) {
      throw new Error('evidence_mutation_probe_scratch_command_invalid');
    }
    if (!artifact.mutationProbes?.length) {
      throw new Error('evidence_mutation_probe_replay_required');
    }
    for (const [index, probe] of artifact.mutationProbes.entries()) {
      if (
        probe.runnerPath.startsWith('/') ||
        probe.runnerPath.split('/').includes('..') ||
        probe.cwd.startsWith('/') ||
        probe.cwd.split('/').includes('..') ||
        probe.runnerPath.replace(/\\/g, '/').toLowerCase().includes('.papercusp/scratch') ||
        probe.argv.some(referencesSharedScratch)
      ) {
        throw new Error(`evidence_mutation_probe_replay_not_immutable: mutationProbes.${index}`);
      }
      const file = probe.argv.indexOf('--file');
      const test = probe.argv.indexOf('--test');
      const hasHistoricalSelector =
        probe.argv.includes('--against-commit') || probe.argv.includes('--against-last-without');
      const mutation = probe.argv.indexOf('--mutate');
      if (
        file < 0 || !probe.argv[file + 1] ||
        test < 0 || !probe.argv[test + 1] ||
        (!hasHistoricalSelector && (mutation < 0 || !probe.argv[mutation + 1]))
      ) {
        throw new Error(`evidence_mutation_probe_replay_incomplete: mutationProbes.${index}.argv`);
      }
    }
  }
  const startedAt = Date.parse(result.data.startedAt);
  const finishedAt = Date.parse(result.data.finishedAt);
  if (finishedAt < startedAt) throw new Error('evidence_time_order_invalid');
  return artifact;
}

/** Validate that the artifact bytes are exactly those stored at the caller tree's HEAD. */
export async function inspectCommittedOperationalEvidence(
  root: string,
  filePath: string,
  expectedSha256: string,
): Promise<CommittedOperationalEvidence> {
  const normalized = filePath.replace(/\\/g, '/');
  if (
    isAbsolute(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    !normalized.startsWith('docs/evidence/') ||
    !normalized.endsWith('.json')
  ) {
    throw new Error('evidence_path_invalid');
  }
  const realRoot = realpathSync(root);
  const absolute = realpathSync(resolve(realRoot, normalized));
  if (!insideRoot(realRoot, absolute) || !statSync(absolute).isFile()) throw new Error('evidence_path_invalid');

  const bytes = readFileSync(absolute);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('evidence_sha256_mismatch');
  const headBytes = await gitOutput(realRoot, ['show', `HEAD:${normalized}`]);
  if (!headBytes.equals(bytes)) throw new Error('evidence_not_committed');
  const commit = (await gitOutput(realRoot, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('evidence_commit_unreadable');

  const artifact = parseOperationalEvidenceArtifact(bytes);
  for (const [index, probe] of (artifact.mutationProbes ?? []).entries()) {
    let runnerSourceAvailable = false;
    let runnerSourceFound = false;
    for (const sourceCommit of [probe.runnerCommit, commit]) {
      try {
        const runnerBytes = await gitOutput(realRoot, ['show', `${sourceCommit}:${probe.runnerPath}`]);
        runnerSourceAvailable = true;
        if (createHash('sha256').update(runnerBytes).digest('hex') === probe.runnerSha256) {
          runnerSourceFound = true;
          break;
        }
      } catch {
        // The runner may have been dirty when it ran and committed with the
        // evidence artifact; in that case the artifact commit is its first
        // immutable source.
      }
    }
    if (!runnerSourceAvailable) {
      throw new Error(`evidence_mutation_probe_runner_unavailable: mutationProbes.${index}`);
    }
    if (!runnerSourceFound) {
      throw new Error(`evidence_mutation_probe_runner_sha256_mismatch: mutationProbes.${index}`);
    }
  }

  let archiveLog: string | undefined;
  if (artifact.archivedMutation) {
    const archive = artifact.archivedMutation;
    const path = archive.rawLogFile;
    if (!path.startsWith('docs/evidence/') || !path.endsWith('.log') || path.includes('\\')
      || path.split('/').includes('..') || path.includes('\0')) throw new Error('evidence_archive_path_invalid');
    const absoluteLog = realpathSync(resolve(realRoot, path));
    if (!insideRoot(realRoot, absoluteLog) || !statSync(absoluteLog).isFile()) throw new Error('evidence_archive_path_invalid');
    if (statSync(absoluteLog).size > 2 * 1024 * 1024) throw new Error('evidence_archive_too_large');
    const logBytes = readFileSync(absoluteLog);
    if (createHash('sha256').update(logBytes).digest('hex') !== archive.rawLogSha256) {
      throw new Error('evidence_archive_sha256_mismatch');
    }
    if (!(await gitOutput(realRoot, ['show', `HEAD:${path}`])).equals(logBytes)) {
      throw new Error('evidence_archive_not_committed');
    }
    archiveLog = logBytes.toString('utf8');
  }
  return {
    artifact,
    filePath: normalized,
    sha256,
    commit,
    ...(archiveLog === undefined ? {} : { archiveLog }),
  };
}

/** Validate a saved machine log against an exact scoped receipt. No historical row is updated. */
export function recoverArchivedMutationFailures(
  evidence: CommittedOperationalEvidence,
  original: ArchivedMutationRun | null,
  scope: { workspaceId: string; harnessSlug: string },
) {
  const archive = evidence.artifact.archivedMutation;
  const detail = parseTestRunExecutionDetails(original?.execution_details);
  if (!archive || !evidence.archiveLog || !original || !detail
    || Number(original.id) !== archive.originalTestRunId
    || original.workspace_id !== scope.workspaceId || original.harness_slug !== scope.harnessSlug
    || detail.workspaceId !== scope.workspaceId || detail.harnessSlug !== scope.harnessSlug
    || original.source !== 'mutation-probe' || original.status !== 'fail' || original.framework !== 'vitest'
    || original.worktree_dirty !== false || detail.worktreeDirty !== false
    || detail.collectionFailed !== false || detail.mutationPhase !== 'mutant'
    || detail.failed === 0 || original.commit_sha !== detail.commitSha
    || !original.commit_sha || !/^[a-f0-9]{40}$/.test(original.commit_sha)
    || original.file_path !== detail.filePath) throw new Error('evidence_archive_receipt_mismatch');
  const lines = evidence.archiveLog.split('\n');
  const titles: string[] = [];
  const quoted = '"(?:[^"\\\\]|\\\\.)*"';
  const assertion = new RegExp(`^TEST_FILE_ASSERTION_FAILURE file=(${quoted}) name=(${quoted}) message=`);
  for (const line of lines.filter(line => line.startsWith('TEST_FILE_ASSERTION_FAILURE '))) {
    const match = assertion.exec(line);
    if (!match) throw new Error('evidence_archive_assertion_invalid');
    const file: unknown = JSON.parse(match[1]);
    const title: unknown = JSON.parse(match[2]);
    if (file !== resolve(detail.root, detail.filePath) || !isRecordedCaseTitle(title)) {
      throw new Error('evidence_archive_assertion_mismatch');
    }
    titles.push(title);
  }
  if (titles.length !== detail.failed || new Set(titles).size !== titles.length
    || !parseTestRunExecutionDetails({ ...detail, failedCaseTitles: titles })
    || (detail.failedCaseTitles !== undefined && JSON.stringify(detail.failedCaseTitles) !== JSON.stringify(titles))) {
    throw new Error('evidence_archive_failed_cases_mismatch');
  }
  const probes = lines.filter(line => line.startsWith('MUTATION_PROBE_EVIDENCE_JSON='));
  if (probes.length !== 1 || evidence.artifact.mutationProbes?.length !== 1) throw new Error('evidence_archive_probe_mismatch');
  const probe = mutationProbeReplaySchema.parse(JSON.parse(probes[0].slice('MUTATION_PROBE_EVIDENCE_JSON='.length)));
  if (JSON.stringify(probe) !== JSON.stringify(evidence.artifact.mutationProbes[0])
    || probe.runnerCommit !== original.commit_sha || probe.result.verdict !== 'caught'
    || probe.result.expected !== 'caught' || probe.result.guardExit === 0 || probe.result.baselineExit !== 0
    || probe.result.assertionEvidence !== 'test-file-assertion-failure') throw new Error('evidence_archive_probe_mismatch');
  const marker = lines.filter(line => line.startsWith('TEST_FILE_RESULT ')).at(-1) ?? '';
  if (!marker.includes('requested=1 executed=1 matched=1 status=failed ')
    || !marker.includes(`head=${original.commit_sha.slice(0, 10)} `)
    || !marker.includes('uncommittedPaths=0/1 provenance=stamped ')
    || !marker.endsWith(`skippedTests=${detail.skipped}`)) throw new Error('evidence_archive_verdict_mismatch');
  const summary = lines.filter(line => /^\s*Tests\s/.test(line)).at(-1) ?? '';
  const count = (status: string) => Number(new RegExp(`(\\d+) ${status}`).exec(summary)?.[1] ?? 0);
  if (count('failed') !== detail.failed || count('passed') !== detail.passed || count('skipped') !== detail.skipped) {
    throw new Error('evidence_archive_counts_mismatch');
  }
  const stamps = lines.filter(line => line.startsWith('TEST_FILE_PROVENANCE ')).slice(-2);
  const pre = /phase=pre-run startedAt=(\S+)/.exec(stamps[0] ?? '');
  const post = /phase=post-run startedAt=(\S+)/.exec(stamps[1] ?? '');
  const startedAt = new Date(original.started_at);
  const finishedAt = new Date(original.finished_at ?? NaN);
  if (!pre || !post || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(finishedAt.getTime())
    || !(Date.parse(pre[1]) <= startedAt.getTime() && startedAt.getTime() <= finishedAt.getTime()
      && finishedAt.getTime() <= Date.parse(post[1]))) throw new Error('evidence_archive_time_mismatch');
  return { detail, titles, startedAt, finishedAt };
}

function derivedVerdict(artifact: OperationalEvidenceArtifact): 'pass' | 'fail' {
  return artifact.exitCode === 0 && artifact.assertions.every((assertion) => assertion.passed) ? 'pass' : 'fail';
}

function outputTail(evidence: CommittedOperationalEvidence): string {
  const passed = evidence.artifact.assertions.filter((assertion) => assertion.passed).length;
  return [
    evidence.artifact.summary,
    `artifact_sha256=${evidence.sha256}`,
    `exit_code=${evidence.artifact.exitCode}`,
    `assertions=${passed}/${evidence.artifact.assertions.length}`,
  ]
    .join('\n')
    .slice(-4000);
}

export async function recordOperationalRun(
  args: { evidenceFile: string; expectedSha256: string; harness?: string },
  ctx: RecordContext,
  deps: RecordOperationalRunDeps = DEFAULT_DEPS,
) {
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, error: 'workspace_required' as const };
  }
  const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
  if (!harnessSlug) return { ok: false, error: 'harness_required' as const };

  let evidence: CommittedOperationalEvidence;
  try {
    evidence = await deps.inspectEvidence(resolveAgentWorkspaceRoot(ctx), args.evidenceFile, args.expectedSha256);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'evidence_unreadable' };
  }

  if (evidence.artifact.archivedMutation) {
    const archive = evidence.artifact.archivedMutation;
    try {
      const original = await deps.readArchivedRun?.(archive.originalTestRunId, { workspaceId, harnessSlug }) ?? null;
      const recovered = recoverArchivedMutationFailures(evidence, original, { workspaceId, harnessSlug });
      const runGroupId = `archive-mutation:${archive.originalTestRunId}:${evidence.sha256.slice(0, 40)}`;
      const existing = await deps.findIds({ workspaceId, harnessSlug, runGroupId, filePath: original!.file_path });
      if (existing.length > 0) return { ok: true, alreadyRecorded: true, runGroupId, testRunIds: existing,
        status: 'fail' as const, recoveredFromTestRunId: archive.originalTestRunId,
        evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit } };
      const { root, testNamePattern, mutationPhase, passed, failed, skipped, collectionFailed,
        testLayer, runStartedAt } = recovered.detail;
      const execution = { passed, failed, skipped, collectionFailed,
        ...(testLayer === undefined ? {} : { testLayer }),
        ...(runStartedAt === undefined ? {} : { runStartedAt }) };
      const persisted = await deps.persist({ workspaceId, harnessSlug, runGroupId, root, testNamePattern, mutationPhase,
        source: 'mutation-probe', commit: original!.commit_sha, worktreeDirty: false,
        rows: [{ filePath: original!.file_path, framework: 'vitest', status: 'fail',
          startedAt: recovered.startedAt, finishedAt: recovered.finishedAt,
          durationMs: recovered.finishedAt.getTime() - recovered.startedAt.getTime(),
          outputTail: `ARCHIVED MUTATION: original_test_run_id=${archive.originalTestRunId}; artifact=${evidence.filePath}; artifact_sha256=${evidence.sha256}; raw_log_sha256=${archive.rawLogSha256}. No new test execution.`,
          execution: { ...execution, failedCaseTitles: recovered.titles } }],
      });
      if (persisted.written !== 1 || persisted.ids.length !== 1) return { ok: false, error: 'ledger_write_failed' as const, runGroupId };
      return { ok: true, alreadyRecorded: false, runGroupId, testRunIds: persisted.ids, status: 'fail' as const,
        recoveredFromTestRunId: archive.originalTestRunId,
        evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'evidence_archive_unreadable' };
    }
  }

  const runGroupId = `operational:${evidence.sha256.slice(0, 40)}`;
  const identity = { workspaceId, harnessSlug, runGroupId, filePath: evidence.filePath };
  const existing = await deps.findIds(identity);
  if (existing.length > 0) {
    return {
      ok: true,
      alreadyRecorded: true,
      runGroupId,
      testRunIds: existing,
      evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit },
      status: derivedVerdict(evidence.artifact),
    };
  }

  const startedAt = new Date(evidence.artifact.startedAt);
  const finishedAt = new Date(evidence.artifact.finishedAt);
  const row: HarnessTestFileRow = {
    filePath: evidence.filePath,
    framework: evidence.artifact.framework,
    status: derivedVerdict(evidence.artifact),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt,
    finishedAt,
    outputTail: outputTail(evidence),
  };
  const persisted = await deps.persist({
    harnessSlug,
    workspaceId,
    rows: [row],
    runGroupId,
    source: 'local',
    commit: evidence.commit,
    // The exact evidence bytes were compared with HEAD above. Unrelated dirty
    // files in the shared tree do not make this committed artifact ambiguous.
    worktreeDirty: false,
  });
  if (persisted.written !== 1 || persisted.ids.length !== 1) {
    return { ok: false, error: 'ledger_write_failed' as const, runGroupId };
  }
  return {
    ok: true,
    alreadyRecorded: false,
    runGroupId,
    testRunIds: persisted.ids,
    status: row.status,
    evidence: { filePath: evidence.filePath, sha256: evidence.sha256, commit: evidence.commit },
  };
}

export default defineTool({
  name: 'testing:record-run',
  description:
    `Register a completed non-Vitest check in harness_shared.test_runs and return testRunIds for plans:bind-spec-evidence. Commit docs/evidence/*.json with schemaVersion:1, kind:"operational-test-evidence", command, timestamps, exitCode, summary, and assertions; pass expectedSha256 for those bytes. Mutation probes need exact MUTATION_PROBE_EVIDENCE_JSON records and cannot use shared .papercusp/scratch. Optional archivedMutation:{originalTestRunId,rawLogFile,rawLogSha256} adds failed-case identities from a committed raw log after validating the original scoped receipt; it never changes that receipt or runs a test. Evidence JSON limit: ${MAX_OPERATIONAL_EVIDENCE_BYTES} bytes; pin bulky raw artifacts by SHA-256. Verdict derives from exitCode + assertions, not caller input. Idempotent by artifact hash.`,
  guidance: {
    when: 'A completed Playwright, Cargo, node, shell, desktop, or other operational acceptance run needs a numeric ledger record; or historical mutation case identities need recovery.',
    notWhen:
      'Not for Vitest (use testing:run), temporary logs, or checks that did not run.',
    chaining:
      'Run check → commit docs/evidence JSON → testing:record-run → bind returned IDs with plans:bind-spec-evidence.',
  },
  capability: 'testing:run',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: harnessArg,
    evidenceFile: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'Repo-relative committed JSON path under docs/evidence/. Absolute, temporary, untracked, dirty, and symlink-escape paths are refused.',
      ),
    expectedSha256: sha256Schema.describe('Lowercase SHA-256 of the exact committed evidence file bytes.'),
  }),
  async handler(args, ctx) {
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!harnessSlug) return harnessRequiredResult('testing:record-run', ctx);
    return { data: await recordOperationalRun({ ...args, harness: harnessSlug }, ctx) };
  },
});
