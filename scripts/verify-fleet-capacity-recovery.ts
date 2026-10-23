/** Read-only semantic instrument over the existing native operational evidence ledger. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listSpecEvidence } from '../packages/operator-core/lib/agent-tools/plans/spec-evidence-store';
import { inspectCommittedOperationalEvidence } from '../packages/operator-core/lib/agent-tools/testing/record-run';
import { LUNA_CAPACITY_PLAN, validateCapacityRecoveryProof, validateCapacityShipmentProof,
  validateCapacityDiagnosticProof, validateCapacityContinuationProof } from '../packages/operator-core/lib/fleet/capacity-recovery-evidence';

async function main() {
const [root, phase] = process.argv.slice(2);
const result: { scope: string; phase: string; status: string; bindingIds: number[]; violations: string[] } =
  { scope: 'luna-capacity-semantic-v1', phase, status: 'unknown', bindingIds: [], violations: [] };
try {
  if (!root || !['recovery', 'shipment', 'diagnostic', 'continuation'].includes(phase)) throw new Error('invalid-instrument-scope');
  const specIds: Record<string, string> = { recovery: 'LUNA-CAPACITY-005', shipment: 'LUNA-CAPACITY-006',
    diagnostic: 'LUNA-CAPACITY-002', continuation: 'LUNA-CAPACITY-004' };
  const rows = await listSpecEvidence({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
    planSlugs: [LUNA_CAPACITY_PLAN], specIds: [specIds[phase]],
    evidenceKinds: phase === 'continuation' ? ['test'] : ['operational'], current: true, limit: 21 });
  if (!rows.length || rows.length > 20) throw new Error('missing-or-truncated-evidence');
  result.bindingIds = rows.map(r => r.id);
  const nativeContinuations: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.currentness.overall !== 'current') throw new Error('noncurrent-evidence:' + row.id);
    const execution = row.testRunExecution;
    const native = row.testRunProvenance;
    if (!row.testRunId || !execution || !native || !['pass', 'passed'].includes(execution.status ?? '') ||
      execution.failed !== 0 || execution.collectionFailed || execution.passed < 1 ||
      !/^[a-f0-9]{40}$/.test(native.commitSha ?? '')) throw new Error('missing-native-success:' + row.id);
    if (phase === 'continuation') {
      nativeContinuations.push({ bindingId: row.id, testRunId: row.testRunId, currentness: row.currentness.overall,
        status: execution.status, failed: execution.failed, passed: execution.passed,
        collectionFailed: execution.collectionFailed, testLayer: execution.testLayer, filePath: execution.filePath,
        ...(execution.scenarioId ? { scenarioId: execution.scenarioId } : {}),
        ...(execution.passedCaseTitles ? { passedCaseTitles: execution.passedCaseTitles } : {}) });
      continue;
    }
    // The expected bytes come from the native run's immutable commit, not from
    // binder-authored details. The canonical reader also requires HEAD equality.
    const bytes = execFileSync('git', ['show', native.commitSha + ':' + native.filePath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const artifact = await inspectCommittedOperationalEvidence(root, native.filePath, createHash('sha256').update(bytes).digest('hex'));
    if (artifact.artifact.exitCode !== 0 || artifact.artifact.assertions.some(a => !a.passed)) throw new Error('failed-operational-artifact');
    const verdict = phase === 'recovery' ? validateCapacityRecoveryProof(artifact.artifact.capacityRecoveryProof)
      : phase === 'diagnostic' ? validateCapacityDiagnosticProof(artifact.artifact.capacityRecoveryProof)
        : validateCapacityShipmentProof(artifact.artifact.capacityRecoveryProof);
    result.violations.push(...verdict.violations.map(v => row.id + ':' + v));
  }
  if (phase === 'continuation') result.violations.push(...validateCapacityContinuationProof(nativeContinuations).violations);
  result.status = result.violations.length ? 'fail' : 'pass';
} catch (error) { result.violations.push(error instanceof Error ? error.message : String(error)); }
// This is a one-shot, read-only CLI. Flush its receipt before closing the
// process, including any idle database pool opened by the canonical reader.
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
