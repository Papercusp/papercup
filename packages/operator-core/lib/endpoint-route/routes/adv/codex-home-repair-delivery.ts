/** Read-only delivery detector. Packets select earlier canonical proof; they
 * cannot supply ledger rows, accepted bytes, runtime observations or a verdict. */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from '@papercusp/hash-chain';

const ADV = 'packages/operator-core/lib/endpoint-route/routes/adv/';
export const REPAIR_SOURCE_PATHS = [
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts', ADV + 'sessions.ts',
] as const;
export const REPAIR_PREREQUISITE_CASE = 'validates the frozen repair delivery packet against canonical receipts and both runtime artifacts';
export const REPAIR_FINAL_CASE = 'validates independent verification of the exact frozen operational delivery binding';
export const REPAIR_REQUIRED_CASES = [
  { file: ADV + 'sessions-ensure-codex-home.test.ts',
    testName: 'observes a pending repair and replays its terminal receipt without repeating writes', layer: 'unit' },
  { file: 'packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts',
    testName: 'retains pending and finalized Codex home repair receipts across expiry and sweep', layer: 'integration' },
] as const;
const text = z.string().trim().min(1).max(2000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().safe();
const runtimeSchema = z.object({ host: z.enum(['port-3170', 'port-3070']), processId: text, buildSha: text,
  artifact: z.object({ status: z.literal('measured'), sourceSha: gitSha, bundleSha256: sha256,
    manifestSha256: sha256, sourceBlobs: z.record(z.string(), gitSha), evidenceRef: text }) });
const pinSchema = z.object({ id, specId: text, specRevision: id, specFingerprint: sha256,
  sourceFingerprint: text, environmentFingerprint: text }).strict();
const packetSchema = z.object({ schemaVersion: z.literal(1), workspaceId: text, harnessSlug: text,
  planSlug: z.literal('codex-home-repair-receipt-lifecycle-2026-11-17'), implementerId: text,
  acceptedCommit: gitSha, frozenAt: z.string().datetime(),
  sourceFiles: z.array(z.object({ path: z.enum(REPAIR_SOURCE_PATHS), sha256, gitBlob: gitSha }).strict()).length(2),
  runtimes: z.object({ 'staging-operator': runtimeSchema, 'release-operator': runtimeSchema }).strict(),
  operational: pinSchema, tests: z.array(pinSchema).min(2).max(32), independentVerificationId: id.optional(),
}).strict();
export type RepairDeliveryPacket = z.infer<typeof packetSchema>;
export type RepairRuntime = z.infer<typeof runtimeSchema>;
type Pin = z.infer<typeof pinSchema>;
type Plane = keyof RepairDeliveryPacket['runtimes'];
const rowSchema = z.object({ id, planSlug: text, specId: text, specRevision: id, specFingerprint: sha256,
  evidenceKind: text, evidenceRef: text, createdBy: text, createdAt: z.string().datetime(), observedAt: z.string().datetime(),
  fingerprints: z.object({ sourceFingerprint: text, environmentFingerprint: text }),
  currentness: z.object({ overall: z.literal('current'), provenance: z.literal('server-measured') }),
  withdrawal: z.unknown().optional(), verifiesBindingId: id.optional(), testRunId: id.nullable().optional(),
  testRunProvenance: z.object({ filePath: text, source: text, worktreeDirty: z.literal(false), commitSha: gitSha }).nullable().optional(),
  testRunExecution: z.object({ status: z.literal('pass'), passed: id, failed: z.literal(0),
    skipped: z.number().int().nonnegative(), collectionFailed: z.literal(false), filePath: text, testLayer: text,
    startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
    cases: z.array(z.object({ caseKey: text, occurrence: id, status: z.enum(['pass', 'fail', 'skip']) })).min(1),
  }).nullable().optional(), details: z.record(z.string(), z.unknown()),
});
export interface RepairDeliveryReads {
  /** Resolve exact IDs within the supplied workspace/harness/plan. */
  bindings(packet: RepairDeliveryPacket, ids: number[]): Promise<unknown[]>;
  committedBytes(commit: string, path: string): Promise<Buffer>;
  runtime(plane: Plane, commit: string, path: string, hash: string): Promise<unknown>;
  related(first: string, second: string, workspaceId: string): Promise<boolean>;
}
export type RepairDeliveryVerdict = { ok: true; packetSha256: string; bindingIds: number[] }
  | { ok: false; reason: string };
function proof(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function same(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
function hash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function blob(bytes: Buffer) { return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'); }
function matchesCase(key: string, title: string) {
  return key === title || key.endsWith(' > ' + title) || key.endsWith(' ' + title);
}
/** IDs and later detector receipts are outside this acyclic frozen subject. */
export function repairDeliverySubject(p: RepairDeliveryPacket) {
  return { schemaVersion: p.schemaVersion, workspaceId: p.workspaceId, harnessSlug: p.harnessSlug,
    planSlug: p.planSlug, implementerId: p.implementerId, acceptedCommit: p.acceptedCommit,
    sourceFiles: p.sourceFiles, runtimes: p.runtimes };
}
export async function validateRepairDelivery(input: unknown, mode: 'prerequisite' | 'final',
  reads: RepairDeliveryReads, detectorStartedAt: string): Promise<RepairDeliveryVerdict> {
  try {
    const p = packetSchema.parse(input), started = Date.parse(detectorStartedAt);
    proof(Number.isFinite(started) && Date.parse(p.frozenAt) < started, 'packet must precede detector');
    proof(new Set(p.sourceFiles.map(f => f.path)).size === 2, 'source population');
    proof(p.runtimes['staging-operator'].host === 'port-3170'
      && p.runtimes['release-operator'].host === 'port-3070', 'runtime plane substitution');
    for (const f of p.sourceFiles) {
      const bytes = await reads.committedBytes(p.acceptedCommit, f.path);
      proof(hash(bytes) === f.sha256 && blob(bytes) === f.gitBlob, 'accepted source bytes: ' + f.path);
      for (const plane of ['staging-operator', 'release-operator'] as const) {
        const expected = p.runtimes[plane];
        const actual = z.object({ acceptedSource: z.object({ expectedSha256: sha256, observedSha256: sha256,
          matches: z.literal(true), runtimeContainment: z.record(z.string(), z.boolean().nullable()) }),
          observingRuntime: runtimeSchema }).parse(await reads.runtime(plane, p.acceptedCommit, f.path, f.sha256));
        proof(actual.acceptedSource.expectedSha256 === f.sha256 && actual.acceptedSource.observedSha256 === f.sha256
          && actual.acceptedSource.runtimeContainment[plane] === true, 'runtime accepted containment: ' + plane);
        // The serving read projects only the requested boot blob. Compare the
        // process/artifact identity independently of that per-file subset.
        const { sourceBlobs: _expectedBlobs, ...wantedArtifact } = expected.artifact;
        const { sourceBlobs: actualBlobs, ...actualArtifact } = actual.observingRuntime.artifact;
        proof(same(actualArtifact, wantedArtifact) && actual.observingRuntime.host === expected.host
          && actual.observingRuntime.processId === expected.processId && actual.observingRuntime.buildSha === expected.buildSha
          && expected.artifact.sourceSha.startsWith(expected.buildSha)
          && expected.artifact.sourceBlobs[f.path] === f.gitBlob && actualBlobs[f.path] === f.gitBlob,
        'runtime artifact identity: ' + plane);
      }
    }
    const ids = [p.operational.id, ...p.tests.map(t => t.id), ...(mode === 'final' ? [p.independentVerificationId!] : [])];
    proof(ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length, 'missing or repeated binding ID');
    const rows = (await reads.bindings(p, ids)).map(row => rowSchema.parse(row));
    proof(rows.length === ids.length && new Set(rows.map(r => r.id)).size === ids.length
      && rows.every(r => ids.includes(r.id)), 'exact canonical binding population');
    for (const r of rows) {
      proof(!r.withdrawal && r.planSlug === p.planSlug, 'withdrawn or foreign binding');
      proof(Date.parse(r.createdAt) < started && Date.parse(r.observedAt) < started, 'self-referential or future detector receipt');
    }
    const pinned = (pin: Pin, kind: string) => {
      const r = rows.find(r => r.id === pin.id)!;
      proof(r.evidenceKind === kind && r.specId === pin.specId && r.specRevision === pin.specRevision
        && r.specFingerprint === pin.specFingerprint && same(r.fingerprints,
        { sourceFingerprint: pin.sourceFingerprint, environmentFingerprint: pin.environmentFingerprint }),
      'binding clause or fingerprint substitution');
      return r;
    };
    const op = pinned(p.operational, 'operational');
    proof(Date.parse(op.createdAt) <= Date.parse(p.frozenAt) && op.createdBy === p.implementerId
      && same(op.details.codexHomeRepairDelivery, repairDeliverySubject(p)), 'frozen operational subject');
    const tests = p.tests.map(pin => pinned(pin, 'test'));
    for (const r of tests) {
      const e = r.testRunExecution;
      proof(r.testRunId && e && r.testRunProvenance && r.testRunProvenance.source !== 'mutation-probe'
        && r.testRunProvenance.commitSha === p.acceptedCommit && e.filePath === r.testRunProvenance.filePath
        && Date.parse(e.startedAt) <= Date.parse(e.finishedAt) && Date.parse(e.finishedAt) <= Date.parse(p.frozenAt)
        && e.cases.length === e.passed + e.skipped && e.cases.filter(c => c.status === 'pass').length === e.passed
        && e.cases.filter(c => c.status === 'skip').length === e.skipped, 'missing or unexecuted canonical test census');
      proof(!e.cases.some(c => matchesCase(c.caseKey, REPAIR_PREREQUISITE_CASE)
        || matchesCase(c.caseKey, REPAIR_FINAL_CASE)), 'detector cannot cite itself');
    }
    for (const required of REPAIR_REQUIRED_CASES) {
      proof(tests.some(r => r.testRunExecution?.filePath === required.file && r.testRunExecution.testLayer === required.layer
        && r.testRunExecution.cases.some(c => c.status === 'pass' && c.occurrence === 1
          && matchesCase(c.caseKey, required.testName))), 'required passing exact case: ' + required.testName);
    }
    if (mode === 'final') {
      const iv = rows.find(r => r.id === p.independentVerificationId)!;
      proof(iv.evidenceKind === 'independent-verification' && iv.verifiesBindingId === op.id, 'IV must cite exact operational binding');
      proof(iv.specId === op.specId && iv.specRevision === op.specRevision && iv.specFingerprint === op.specFingerprint
        && same(iv.fingerprints, op.fingerprints) && same(iv.details.codexHomeRepairDelivery, repairDeliverySubject(p))
        && Date.parse(iv.createdAt) > Date.parse(op.createdAt) && Date.parse(iv.observedAt) > Date.parse(op.observedAt),
      'IV frozen subject or order');
      proof(!await reads.related(iv.createdBy, p.implementerId, p.workspaceId)
        && !await reads.related(iv.createdBy, op.createdBy, p.workspaceId), 'IV related lineage');
    }
    return { ok: true, packetSha256: hash(Buffer.from(canonicalJson(p))), bindingIds: ids };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/** Use the inherited attributed session on the existing read-only pipeline verb. */
function readServingPipeline(plane: Plane, p: RepairDeliveryPacket, args: object): Promise<unknown> {
  proof(process.env.PAPERCUSP_SID, 'live reader requires inherited attributed session');
  return new Promise((resolve, reject) => {
    const child = spawn('ptool', ['dev:pipeline_position', '--json', '-', '--workspace=' + p.workspaceId,
      '--harness=' + p.harnessSlug, '--url=http://127.0.0.1:' + (plane === 'staging-operator' ? '3170' : '3070')],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('canonical runtime read timed out')); }, 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill(); reject(new Error('runtime read exceeds explicit 1 MiB transport bound')); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        proof(code === 0, 'canonical runtime read failed');
        let value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (let depth = 0; depth < 8; depth++) {
          proof(value && !value.isError && value.ok !== false && !value._partial && !value._projection?.truncated,
            'unavailable canonical runtime read');
          if (value.acceptedSource && value.observingRuntime) return resolve(value);
          if (value.structuredContent) value = value.structuredContent;
          else if (Array.isArray(value.content)) {
            const json = value.content.find((b: { type: string; text?: string }) => b.type === 'text' && b.text?.trim().startsWith('{'));
            proof(json, 'runtime read missing JSON'); value = JSON.parse(json.text);
          } else value = value.data ?? value.result;
        }
        reject(new Error('runtime read missing exact observation'));
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify(args));
  });
}
export async function runLiveRepairDelivery(mode: 'prerequisite' | 'final') {
  const startedAt = new Date().toISOString();
  proof(process.env.PAPERCUSP_CODEX_HOME_REPAIR_LIVE === '1', 'explicit live admission required');
  const file = process.env.PAPERCUSP_CODEX_HOME_REPAIR_PACKET;
  proof(file, 'frozen delivery packet path required');
  const bytes = await readFile(file);
  proof(bytes.length <= 128 * 1024, 'delivery packet exceeds explicit 128 KiB validation bound');
  const p = packetSchema.parse(JSON.parse(bytes.toString('utf8')));
  proof(p.workspaceId === (process.env.PAPERCUSP_TEST_RUN_WORKSPACE ?? process.env.PAPERCUSP_WORKSPACE)
    && p.harnessSlug === (process.env.PAPERCUSP_TEST_RUN_HARNESS ?? process.env.PAPERCUSP_HARNESS_SLUG), 'live execution scope');
  const [{ listSpecEvidence }, { areAcceptanceLineageRelated }] = await Promise.all([
    import('../../../agent-tools/plans/spec-evidence-store'), import('../../../acceptance-author-identity'),
  ]);
  const git = promisify(execFile), { stdout: root } = await git('git', ['rev-parse', '--show-toplevel']);
  return validateRepairDelivery(p, mode, {
    bindings: (packet, bindingIds) => listSpecEvidence({ workspaceId: packet.workspaceId, harnessSlug: packet.harnessSlug,
      planSlugs: [packet.planSlug], bindingIds, includeCaseEvidence: true, limit: bindingIds.length }),
    committedBytes: async (commit, path) => (await git('git', ['cat-file', 'blob', commit + ':' + path],
      { cwd: root.trim(), encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout,
    runtime: (plane, commit, path, expectedSourceSha256) => readServingPipeline(plane, p,
      { path, sha: commit, expectedSourceSha256, sourceRuntimeOnly: true, payloadTier: 'full' }),
    related: (a, b, workspaceId) => areAcceptanceLineageRelated(a, b, { workspaceId }),
  }, startedAt);
}
