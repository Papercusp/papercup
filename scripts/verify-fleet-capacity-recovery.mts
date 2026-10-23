/** Read-only semantic instrument over the existing native operational evidence ledger.
 * Explicit ESM keeps the maintained committed-source loader ahead of tsx transforms. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { listSpecEvidence } from '../packages/operator-core/lib/agent-tools/plans/spec-evidence-store';
import type { inspectCommittedOperationalEvidence } from '../packages/operator-core/lib/agent-tools/testing/record-run';
import type { NativeCapacityLlmRun, NativeCapacityBriefReceipt } from '../packages/operator-core/lib/fleet/capacity-recovery-evidence';

const S42_PATH = 'packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function nativeToolReceipt(id: number): Promise<NativeCapacityBriefReceipt & { servingBuildSha: string | null }> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const [native] = await sql<Array<{ id: number; tool_name: string; status: string; workspace_id: string;
    coord_owner_id: string | null; invoked_at: Date; duration_ms: number | null; metadata_json: unknown;
    args_json: unknown; serving_build_sha: string | null; serving_host: string | null; serving_process_id: string | null }>>`
    SELECT id, tool_name, status, workspace_id, coord_owner_id, invoked_at, duration_ms, metadata_json, args_json, serving_build_sha,
           serving_host, serving_process_id
      FROM harness_shared.tool_invocations
     WHERE id = ${id} AND workspace_id = 'papercusp-workspace'`;
  if (!native) throw new Error('native-tool-receipt-missing:' + id);
  return { id: Number(native.id), toolName: native.tool_name, status: native.status, workspaceId: native.workspace_id,
    actorId: native.coord_owner_id, invokedAt: native.invoked_at.toISOString(), durationMs: native.duration_ms,
    metadata: native.metadata_json, args: native.args_json, servingBuildSha: native.serving_build_sha,
    servingHost: native.serving_host, servingProcessId: native.serving_process_id };
}

async function matchesMeasuredSource(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number], sha: string | null) {
  const { repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot } =
    await import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store');
  const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
  const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
  if (!paths.length || !/^[a-f0-9]{7,40}$/.test(sha ?? '')) return false;
  // Reuse the canonical reader's gitlink pins, binary-safe batching and limits.
  const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
    await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
  try {
    const files = await readCommittedFiles(root, sha!, paths, {}, REPO_FILE_SET_READ_LIMITS);
    return paths.every(path => files.get(path)?.sha256 === sha256(readFileSync(join(root, path))));
  } catch { return false; }
}

async function readBriefProof(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const { capacityBriefCaptureSchema, validateCapacityBriefReceipt } =
    await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
  const capture = capacityBriefCaptureSchema.parse(artifact.capacityBriefCapture);
  const native = await nativeToolReceipt(capture.invocationId);
  return validateCapacityBriefReceipt(artifact.capacityRecoveryProof, capture, native,
    { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt,
      sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) });
}

async function readAdmissionProof(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const { capacityAdmissionCapturesSchema, recoveryProofSchema, validateCapacityAdmissionReceipt } =
    await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence');
  const proof = recoveryProofSchema.parse(artifact.capacityRecoveryProof);
  const captures = capacityAdmissionCapturesSchema.parse(artifact.capacityAdmissionCaptures ?? []);
  if (captures.length !== proof.recoveries.length || new Set(captures.map(c => c.memberId)).size !== captures.length
    || captures.some(c => !proof.recoveries.some(r => r.memberId === c.memberId))) throw new Error('native-admission-population');
  const violations: string[] = [];
  for (const c of captures) {
    const native = await nativeToolReceipt(c.capture.invocationId);
    violations.push(...validateCapacityAdmissionReceipt(proof, c.memberId, c.capture, native,
      { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt,
        sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) }).violations);
  }
  return violations;
}

async function readDiagnosticOutputs(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const [{ capacityRuntimeCapturesSchema, capacityBriefCaptureSchema, validateCapacityDiagnosticOutputs },
    { repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot }] = await Promise.all([
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store'),
  ]);
  const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
  const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
  const required = ['leader-brief.ts', 'leader-brief-shape.ts', 'leader-brief-aggregate.ts']
    .map(name => 'packages/operator-core/lib/agent-tools/fleet/' + name);
  if (required.some(path => !paths.includes(path))) throw new Error('native-runtime-source-not-measured');
  const qualify = async (capture: ReturnType<typeof capacityBriefCaptureSchema.parse>) => {
    const native = await nativeToolReceipt(capture.invocationId);
    return { capture, native, sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) };
  };
  const runtime = await Promise.all(capacityRuntimeCapturesSchema.parse(artifact.capacityRuntimeCaptures).map(qualify));
  const caller = artifact.capacityCallerCapture == null ? null : await qualify(capacityBriefCaptureSchema.parse(artifact.capacityCallerCapture));
  const { readCommittedFiles, REPO_FILE_SET_READ_LIMITS } =
    await import('../packages/operator-core/lib/agent-tools/plans/committed-tree-reader');
  const proof = (await import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'))
    .diagnosticProofSchema.parse(artifact.capacityRecoveryProof);
  const compilerInputs = await readCommittedFiles(root, proof.candidate.commit, required, {}, REPO_FILE_SET_READ_LIMITS);
  return validateCapacityDiagnosticOutputs(artifact.capacityRecoveryProof, runtime, caller,
    { root, sources: required.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))),
      gitBlob: compilerInputs.get(path)?.gitBlob ?? '' })),
      now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt });
}

async function readRecoveryOperations(root: string, row: Awaited<ReturnType<typeof listSpecEvidence>>[number],
  artifact: Awaited<ReturnType<typeof inspectCommittedOperationalEvidence>>['artifact']) {
  const [{ getOrgPg }, { recoveryProofSchema, capacityBriefCaptureSchema, validateCapacityRecoveryOperations }] = await Promise.all([
    import('@papercusp/db-org'), import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const { sql } = getOrgPg();
  const proof = recoveryProofSchema.parse(artifact.capacityRecoveryProof);
  const receiptId = (ref: string, prefix: string) => {
    if (!ref.startsWith(prefix) || !/^[1-9][0-9]*$/.test(ref.slice(prefix.length))) throw new Error('invalid-native-reference:' + ref);
    const id = Number(ref.slice(prefix.length));
    if (!Number.isSafeInteger(id)) throw new Error('invalid-native-reference:' + ref);
    return id;
  };
  const operations: import('../packages/operator-core/lib/fleet/capacity-recovery-evidence').NativeCapacityRecoveryOperation[] = [];
  for (const r of proof.recoveries) {
    const control = await nativeToolReceipt(receiptId(r.control.receiptRef, 'tool-invocation:'));
    const claim = await nativeToolReceipt(receiptId(r.claim.receiptRef, 'tool-invocation:'));
    const [delivery] = await sql<Array<{ id: number; workspace_id: string; subscriber_id: string; event_key: string;
      source: string | null; status: string; turn_proof: string | null; created_at: Date;
      delivered_at: Date | null; turn_started_at: Date | null }>>`
      SELECT id, workspace_id, subscriber_id, event_key, source, status, turn_proof, created_at, delivered_at, turn_started_at
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = 'papercusp-workspace' AND id = ${receiptId(r.turn.id, 'event-wake-delivery:')}`;
    const claimStart = new Date(Date.parse(claim.invokedAt) - (claim.durationMs ?? 0)).toISOString();
    const audits = await sql<Array<{ id: number; feature_id: string; claimer_pubkey: string; outcome: string; attempt_ts: Date; detail: string | null }>>`
      SELECT id, feature_id, claimer_pubkey, outcome, attempt_ts, detail FROM harness_shared.claim_audit
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
         AND feature_id = ${r.claim.workItemId} AND claimer_pubkey = ${r.memberId} AND outcome = 'won'
         AND attempt_ts >= ${claimStart}::timestamptz AND attempt_ts <= ${claim.invokedAt}::timestamptz
       ORDER BY id LIMIT 2`;
    if (!delivery || audits.length !== 1) throw new Error('native-recovery-join-missing-or-ambiguous:' + r.memberId);
    const audit = audits[0];
    const writers = await sql<Array<{ id: number; coord_owner_id: string | null }>>`
      SELECT id, coord_owner_id FROM harness_shared.tool_invocations
       WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND goal_ref = ${r.claim.workItemId}
         AND invoked_at >= ${audit.attempt_ts.toISOString()}::timestamptz AND invoked_at <= ${artifact.finishedAt}::timestamptz
         AND status = 'ok' AND (tool_name IN ('work_items:checkpoint', 'work_items:complete', 'capability:edit', 'capability:write', 'capability:multi_edit', 'Edit', 'Write', 'MultiEdit')
           OR tool_name IN ('activity:report', 'activity_report') AND args_json->>'tool_name' IN ('Edit', 'Write', 'MultiEdit', 'apply_patch')
             AND args_json->>'status' = 'ok')
       ORDER BY id LIMIT 1001`;
    operations.push({ memberId: r.memberId, control, claim,
      controlSourceMatches: await matchesMeasuredSource(root, row, control.servingBuildSha),
      claimSourceMatches: await matchesMeasuredSource(root, row, claim.servingBuildSha),
      delivery: { id: Number(delivery.id), workspaceId: delivery.workspace_id, subscriberId: delivery.subscriber_id,
        eventKey: delivery.event_key, source: delivery.source, status: delivery.status, turnProof: delivery.turn_proof,
        createdAt: delivery.created_at.toISOString(), deliveredAt: delivery.delivered_at?.toISOString() ?? null,
        turnStartedAt: delivery.turn_started_at?.toISOString() ?? null },
      claimAudit: { id: Number(audit.id), workItemId: audit.feature_id, memberId: audit.claimer_pubkey, outcome: audit.outcome,
        takenAt: audit.attempt_ts.toISOString(), detail: audit.detail ? JSON.parse(audit.detail) : null },
      writers: writers.map(w => ({ id: Number(w.id), actorId: w.coord_owner_id })) });
  }
  const capture = capacityBriefCaptureSchema.parse(artifact.capacityLeaderAfterCapture);
  const native = await nativeToolReceipt(capture.invocationId);
  return validateCapacityRecoveryOperations(proof, operations,
    { capture, native, sourceMatches: await matchesMeasuredSource(root, row, native.servingBuildSha) },
    { now: new Date().toISOString(), startedAt: artifact.startedAt, finishedAt: artifact.finishedAt });
}

async function readNativeLlmRuns(root: string, testRunId: number, scenarioId: string, passed: number) {
  const [{ getOrgPg }, { parseTestRunExecutionDetails }, { validateCapacityNativeLlmRun }] = await Promise.all([
    import('@papercusp/db-org'), import('@papercusp/test-config/execution-details'),
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const { sql } = getOrgPg();
  const [ledger] = await sql<Array<{ execution_details: unknown; started_at: Date; finished_at: Date }>>`
    SELECT execution_details, started_at, finished_at FROM harness_shared.test_runs
     WHERE id = ${testRunId} AND framework = 'llm-test' AND status = 'pass'
       AND worktree_dirty = false AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'`;
  const execution = parseTestRunExecutionDetails(ledger?.execution_details);
  const runIds = execution?.llmRunIds;
  if (!ledger || !execution || execution.filePath !== S42_PATH || execution.scenarioId !== scenarioId
    || execution.passed !== passed || execution.failed !== 0 || !runIds?.length || runIds.length !== passed)
    throw new Error('native-llm-custody-missing:' + testRunId);
  const runs = await sql<Array<Record<string, unknown>>>`
    SELECT id, scenario_id, scenario_version, scenario_hash, identity_hash, persona_id, persona_traits_json,
           rubric_version, sut_model, judge_model, status, started_at, finished_at, transcript_norm_json, transcript_raw_zstd
      FROM harness_shared.llm_test_runs WHERE id = ANY(${runIds})`;
  if (runs.length !== runIds.length) throw new Error('native-llm-report-missing:' + testRunId);
  const [{ SU_S42_DRAIN_WATCH_RECHECK }, { BRIEF_ADMIN }, { decompressTranscript }, su, { isCodexResponsesModel }] = await Promise.all([
    import('../packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck'),
    import('@papercusp/testing-shell/llm'), import('../packages/operator-core/lib/llm-testing/storage'),
    import('../packages/operator-core/lib/llm-testing/targets/su'),
    import('../packages/operator-core/lib/llm-testing/targets/codex-responses-tool-loop'),
  ]);
  const scenario = SU_S42_DRAIN_WATCH_RECHECK.find(s => s.id === scenarioId);
  if (!scenario) throw new Error('unrelated-native-scenario');
  const playbook = su.SU_PLAYBOOK_FRAMING + await su.loadPlaybookBody(['auto']);
  const starts: number[] = [], finishes: number[] = [];
  for (const row of runs) {
    const run = { id: row.id, scenarioId: row.scenario_id, scenarioVersion: row.scenario_version,
      scenarioHash: row.scenario_hash, identityHash: row.identity_hash, personaId: row.persona_id,
      personaTraits: row.persona_traits_json, rubricVersion: row.rubric_version, sutModel: row.sut_model,
      judgeModel: row.judge_model, status: row.status, turns: row.transcript_norm_json,
      rawEvents: decompressTranscript(row.transcript_raw_zstd as Buffer) } as NativeCapacityLlmRun;
    const provider = isCodexResponsesModel(run.sutModel) ? 'codex' : 'anthropic';
    const verdict = validateCapacityNativeLlmRun(run, { scenarioId, scenarioVersion: scenario.version,
      scenarioHash: sha256(readFileSync(join(root, S42_PATH))), personaId: BRIEF_ADMIN.id,
      personaTraits: BRIEF_ADMIN.traits, rubricVersion: scenario.rubric.version, provider,
      systemSha256: provider === 'codex' ? [sha256(JSON.stringify(playbook))]
        : [false, true].map(cache => sha256(JSON.stringify(su.buildSuSystemBlocks(playbook, cache)))) });
    if (verdict.status !== 'pass') throw new Error(run.id + ':' + verdict.violations.join(','));
    starts.push(new Date(row.started_at as string).getTime());
    finishes.push(new Date(row.finished_at as string).getTime());
  }
  if (Math.min(...starts) !== new Date(ledger.started_at).getTime()
    || Math.max(...finishes) !== new Date(ledger.finished_at).getTime()) throw new Error('native-llm-window-mismatch');
  return runIds;
}

async function main() {
const [root, phase] = process.argv.slice(2);
const result: { scope: string; phase: string; status: string; bindingIds: number[]; violations: string[] } =
  { scope: 'luna-capacity-semantic-v1', phase, status: 'unknown', bindingIds: [], violations: [] };
try {
  if (!root || !['recovery', 'shipment', 'diagnostic', 'continuation'].includes(phase)) throw new Error('invalid-instrument-scope');
  // Reject invalid scopes before loading DB accessors and the scenario graph.
  const [{ listSpecEvidence, repoFilesEvidenceMeasurementSchema, expandRepoFilesEvidenceSourcePathsAtRoot },
    { listSpecClauses }, { computeSpecSetHash }, { getAcceptanceRubricsForPlan },
    { inspectCommittedOperationalEvidence }, { LUNA_CAPACITY_PLAN, validateCapacityRecoveryProof,
      validateCapacityShipmentProof, validateCapacityDiagnosticProof, validateCapacityContinuationProof,
      validateCapacityContractProof }] = await Promise.all([
    import('../packages/operator-core/lib/agent-tools/plans/spec-evidence-store'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-clauses-store'),
    import('../packages/operator-core/lib/agent-tools/plans/spec-clause-compiler'),
    import('../packages/operator-core/lib/rubrics'),
    import('../packages/operator-core/lib/agent-tools/testing/record-run'),
    import('../packages/operator-core/lib/fleet/capacity-recovery-evidence'),
  ]);
  const [clauses, rubrics] = await Promise.all([
    listSpecClauses({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', planSlug: LUNA_CAPACITY_PLAN, limit: 101 }),
    getAcceptanceRubricsForPlan(LUNA_CAPACITY_PLAN, { harnessSlug: 'papercusp', strict: true, limit: 2 }),
  ]);
  if (!clauses.length || clauses.length > 100 || rubrics.length !== 1 || !rubrics[0].barSetHash
    || rubrics[0].readCompat || !rubrics[0].barContract) throw new Error('canonical-contract-missing-or-ambiguous');
  const specSetHash = computeSpecSetHash(clauses.filter(c => ['draft', 'active', 'accepted', 'exempt'].includes(c.lifecycleStatus)));
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
      native.worktreeDirty !== false || !/^[a-f0-9]{40}$/.test(native.commitSha ?? '')) throw new Error('missing-native-success:' + row.id);
    const measurement = row.serverMeasurement;
    if (measurement?.status !== 'measured' || !('current' in measurement)) throw new Error('native-measurement-missing:' + row.id);
    const sourceFingerprint = measurement.current.sourceFingerprint;
    if (phase === 'continuation') {
      const recipe = repoFilesEvidenceMeasurementSchema.parse(row.details?.currentMeasurement);
      const paths = await expandRepoFilesEvidenceSourcePathsAtRoot(root, recipe);
      for (const path of [S42_PATH, 'packages/operator-core/lib/llm-testing/targets/su.ts',
        'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
        'libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md']) {
        if (!paths.includes(path)) throw new Error('native-prompt-source-not-measured:' + path);
      }
      const nativeRunIds = execution.testLayer === 'llm'
        ? await readNativeLlmRuns(root, row.testRunId, execution.scenarioId ?? '', execution.passed) : undefined;
      nativeContinuations.push({ bindingId: row.id, testRunId: row.testRunId, currentness: row.currentness.overall,
        status: execution.status, failed: execution.failed, passed: execution.passed,
        collectionFailed: execution.collectionFailed, testLayer: execution.testLayer, filePath: execution.filePath,
        sourceFingerprint, ...(nativeRunIds ? { nativeRunIds } : {}),
        ...(execution.scenarioId ? { scenarioId: execution.scenarioId } : {}),
        ...(execution.passedCaseTitles ? { passedCaseTitles: execution.passedCaseTitles } : {}) });
      continue;
    }
    // The expected bytes come from the native run's immutable commit, not from
    // binder-authored details. The canonical reader also requires HEAD equality.
    const bytes = execFileSync('git', ['show', native.commitSha + ':' + native.filePath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const artifact = await inspectCommittedOperationalEvidence(root, native.filePath, createHash('sha256').update(bytes).digest('hex'));
    if (artifact.artifact.exitCode !== 0 || artifact.artifact.assertions.some(a => !a.passed)) throw new Error('failed-operational-artifact');
    if (phase === 'recovery' || phase === 'diagnostic') {
      result.violations.push(...(await readBriefProof(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    }
    if (phase === 'recovery') {
      result.violations.push(...(await readAdmissionProof(root, row, artifact.artifact)).map(v => row.id + ':' + v));
      result.violations.push(...(await readRecoveryOperations(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    }
    if (phase === 'diagnostic') result.violations.push(...(await readDiagnosticOutputs(root, row, artifact.artifact)).violations.map(v => row.id + ':' + v));
    result.violations.push(...validateCapacityContractProof(artifact.artifact.capacityRecoveryProof,
      { specSetHash, barSetHash: rubrics[0].barSetHash, sourceFingerprint }).violations.map(v => row.id + ':' + v));
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
