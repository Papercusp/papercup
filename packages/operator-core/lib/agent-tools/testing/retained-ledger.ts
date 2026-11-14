/** Recover an existing successful Vitest attempt; never starts a test process. */
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { verifyNativeProofPacket, type NativeCustodyLocator } from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';
import { completedDetachedReport, distillVitestRun, reconcileHarnessTestRunRows } from '../../testing-run-store';
import { defaultTestRunArtifactBase } from './run-artifacts';

export async function recoverRetainedVitestLedger(input: {
  directory: string; runId: string; workItemId: string; workspaceId: string; harnessSlug: string;
}, persist = reconcileHarnessTestRunRows) {
  const directory = resolve(input.directory);
  if (realpathSync(directory) !== directory || dirname(directory) !== realpathSync(defaultTestRunArtifactBase())
    || !basename(directory).startsWith('run-')) throw new Error('retained_report_directory_invalid');
  const outer = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const identity = { workspace: input.workspaceId, harness: input.harnessSlug, runId: input.runId };
  const locator = outer.nativeCustody?.locator as NativeCustodyLocator | undefined;
  if (!locator || !/^[a-f0-9]{64}\.native-proof\.json$/.test(locator.manifest?.ref ?? ''))
    throw new Error('retained_report_custody_missing');
  const nativeRoot = join(directory, 'native-proof');
  const declaration = JSON.parse(readFileSync(join(nativeRoot, 'objects', locator.manifest.ref), 'utf8'));
  const verified = verifyNativeProofPacket(nativeRoot, locator, { identity, expected: declaration.expected });
  if (verified.status !== 'complete') throw new Error('retained_report_custody_incomplete');
  const execution = verified.manifest.verdicts.execution as {
    childState?: string; result?: { ok?: boolean; runId?: string; root?: string;
      passed?: number; failed?: number; skipped?: number; byFile?: Record<string, unknown> };
  };
  const result = execution?.result;
  if (execution?.childState !== 'closed' || result?.ok !== true || result.runId !== input.runId
    || result.failed !== 0 || !(Number(result.passed) > 0)) throw new Error('retained_report_not_successful_closed_run');
  const auxiliaries = verified.manifest.groups.flatMap(group => group.auxiliary);
  const read = (role: string) => {
    const matches = auxiliaries.filter(row => row.role === role && row.state === 'produced' && row.artifact);
    if (matches.length !== 1) throw new Error('retained_report_auxiliary_missing_or_ambiguous:' + role);
    const pin = matches[0]!.artifact!;
    const bytes = readFileSync(join(nativeRoot, 'objects', pin.ref));
    if (bytes.byteLength !== pin.byteLength || createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new Error('retained_report_auxiliary_changed:' + role);
    return JSON.parse(bytes.toString('utf8'));
  };
  // Read verified copies, never the mutable source paths beside the packet.
  const ledger = read('ledger.json');
  const source = read('source.json');
  const router = read('router.json');
  const configurationSnapshot = readConfigurationSnapshot(read('configuration.json'));
  if (ledger.runGroup !== input.runId || ledger.workspace !== input.workspaceId
    || ledger.harness !== input.harnessSlug || ledger.workItem !== input.workItemId)
    throw new Error('retained_report_scope_mismatch');
  if (!isAbsolute(source.root ?? '') || source.root !== result.root || !configurationSnapshot
    || router.code !== 0 || router.childState !== 'closed' || router.signal != null || router.timedOut || router.aborted)
    throw new Error('retained_report_context_incomplete');
  // The foreground packet currently retains one canonical combined JSON report.
  // Refuse alternate/mixed report populations instead of guessing their merge.
  const reportRoles = auxiliaries.filter(row => row.role.startsWith('reports/') && row.role.endsWith('.json')
    && !row.role.endsWith('/failure-details.json')).map(row => row.role);
  if (reportRoles.length !== 1 || reportRoles[0] !== 'reports/report.json')
    throw new Error('retained_report_population_unsupported');
  const report = read('reports/report.json');
  const text = JSON.stringify(report);
  const counts = distillVitestRun(text, source.root, { environment: {} });
  const files = Object.keys(result.byFile ?? {}).sort();
  // Reuse restart recovery's complete-report validation and redaction. The
  // original child environment is unavailable, so free-form assertion text
  // cannot be safely persisted; measured counts/timestamps remain recoverable.
  const rows = completedDetachedReport(text, source.root, undefined, files.map(file => join(source.root, file)));
  if (counts.passed !== result.passed || counts.failed !== result.failed || counts.skipped !== result.skipped
    || !rows
    || JSON.stringify(rows.map(row => row.filePath).sort()) !== JSON.stringify(files)
    || rows.some(row => !row.execution || !source.inputs?.some((pin: { path: string; sha256?: string }) =>
      pin.path === row.filePath && /^[a-f0-9]{64}$/.test(pin.sha256 ?? '')))
    || typeof report.startTime !== 'number' || !Number.isFinite(report.startTime))
    throw new Error('retained_report_result_mismatch');
  const recorded = await persist({ rows, root: source.root, runGroupId: input.runId,
    workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, source: 'local',
    runStartedAt: new Date(report.startTime).toISOString(), commit: source.worktree?.commit ?? null,
    // No after-run worktree snapshot was retained. Preserve uncertainty, never
    // promote these bytes into clean-commit or loaded-import-closure evidence.
    worktreeDirty: true, configurationSnapshot, testNamePattern: ledger.testNamePattern ?? null });
  return { runId: input.runId, root: source.root, testRunIds: recorded.map(row => row.id),
    artifactDirectory: directory, worktreeDirty: true as const,
    selectorRecovery: Object.hasOwn(ledger, 'testNamePattern') ? 'recorded' : 'unavailable',
    sourceCoverage: 'selected files and dependency lock; loaded import closure unavailable' };
}
