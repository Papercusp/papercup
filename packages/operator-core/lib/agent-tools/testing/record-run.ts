/**
 * testing:record-run — register an already-executed non-Vitest check in the
 * canonical test_runs execution ledger.
 *
 * This is deliberately a recorder, not a shell runner. The evidence must be a
 * committed docs/evidence JSON artifact whose bytes describe the command,
 * timestamps, exit code, and individual assertions. The server derives the
 * verdict from those bytes, pins their SHA-256 and HEAD commit, and returns the
 * exact numeric row IDs that plans:bind-spec-evidence accepts.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
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
  })
  .passthrough();

export type OperationalEvidenceArtifact = z.infer<typeof operationalEvidenceArtifactSchema>;

export interface CommittedOperationalEvidence {
  artifact: OperationalEvidenceArtifact;
  filePath: string;
  sha256: string;
  commit: string;
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
}

const DEFAULT_DEPS: RecordOperationalRunDeps = {
  inspectEvidence: inspectCommittedOperationalEvidence,
  findIds: findHarnessTestRunIds,
  persist: persistHarnessTestRunsWithIds,
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

  return {
    artifact,
    filePath: normalized,
    sha256,
    commit,
  };
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
    `Record an already-executed non-Vitest operational check in harness_shared.test_runs and return its numeric testRunIds for plans:bind-spec-evidence. The evidence must be a committed docs/evidence/*.json artifact with schemaVersion:1, kind:"operational-test-evidence", command, timestamps, exitCode, summary, and explicit assertions; expectedSha256 pins the exact bytes. Mutation-probe evidence must include exact per-probe records copied from MUTATION_PROBE_EVIDENCE_JSON and cannot cite shared .papercusp/scratch commands. Evidence JSON is capped at ${MAX_OPERATIONAL_EVIDENCE_BYTES} bytes; keep it compact and store bulky payloads as raw artifacts pinned by SHA-256. The verdict is derived from exitCode + assertions, never accepted as a caller boolean. Idempotent by artifact hash.`,
  guidance: {
    when: 'A real Playwright, Cargo, node, shell, desktop, or other operational acceptance run already completed and needs an honest numeric execution-ledger anchor.',
    notWhen:
      'Executing Vitest files (use testing:run), recording a temporary /tmp log, or manufacturing proof for a run that did not happen. Commit a self-describing docs/evidence JSON artifact first.',
    chaining:
      'Run the operational check → write and commit its docs/evidence JSON artifact → testing:record-run → bind the returned numeric testRunIds with plans:bind-spec-evidence.',
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
