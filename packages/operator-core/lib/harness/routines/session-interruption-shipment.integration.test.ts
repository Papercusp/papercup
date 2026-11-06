/** R-6: ordinary CI exercises refusal controls. Only the explicit final-release
 * case supplies shipment evidence; its fixture contains identifiers, not outcomes.
 * Reuses the canonical independent-binding ledger, source containment reader,
 * boot artifact identity and green pipeline receipts. Never runs or deploys a gate.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { areAcceptanceLineageRelated } from '../../acceptance-author-identity';
import type { AcceptedSourceContainment } from '../../git-pipeline-position';
import { resolveScriptPgUrl } from '../../../../../scripts/lib/pg-url.mjs';

const plan = 'active-agent-session-recovery-2026-11-02';
const workspace = 'papercusp-workspace';
const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const baseline = [
  'packages/operator-core/lib/harness/routines/session-interruption-recovery.ts',
  'packages/operator-core/lib/harness/routines/session-interruption-runtime.ts',
  'packages/operator-core/lib/dbos/session-interruption-workflow.ts',
  'packages/operator-core/lib/agent-tools/capability/launch-agent.ts',
  'apps/operator/scripts/psu-pty-host.mjs',
];
type Json = Record<string, any>;
type File = { path: string; sha256: string; bindings: number[] };
type Binding = { id: number; author: string; originalAuthor: string; verified: number;
  source: string; originalSource: string; pin: { files: Array<{
    path: string; dimension: string; sha256: string; clean: boolean;
  }>; repos: Array<{ repo: string; head: string }> } };
type Runtime = { host: string; processId: string; buildSha: string;
  artifact: { status: string; sourceSha: string; bundleSha256: string;
    manifestSha256: string; evidenceRef: string } };
type Proof = { acceptedRevision: string; files: File[]; runtime: Runtime; runtimeAfter: Runtime;
  containment: Array<{ path: string; acceptedSource: AcceptedSourceContainment | null;
    runtime: Runtime; runtimeIds: string[] | null }>;
  promotion: { id: string; sourceSha: string; at: string } | null;
  deployment: { id: string; sourceSha: string; at: string } | null };
function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error('Recovery shipment unproven: ' + reason);
}
function acceptedFiles(rows: Binding[], revision: string): File[] {
  requireProof(revisionPattern.test(revision) && rows.length > 0, 'missing independent source revision');
  const files = new Map<string, File>();
  for (const row of rows) {
    requireProof(row.id > 0 && row.verified > 0 && row.author && row.originalAuthor &&
      row.author !== row.originalAuthor && row.source === row.originalSource,
    'missing or conflicting independent verification');
    requireProof(row.pin?.repos.some(repo => repo.repo === '.' && repo.head === revision),
      'binding does not pin the accepted revision');
    for (const file of row.pin.files.filter(file => file.dimension === 'source')) {
      requireProof(file.clean === true && digestPattern.test(file.sha256) && !isAbsolute(file.path) &&
        !file.path.includes('\\') && file.path.split('/').every(part => part && part !== '.' && part !== '..'),
      'unmeasured or unsafe accepted path');
      const previous = files.get(file.path);
      requireProof(!previous || previous.sha256 === file.sha256, 'conflicting accepted source hashes');
      files.set(file.path, { path: file.path, sha256: file.sha256,
        bindings: [...new Set([...(previous?.bindings ?? []), row.id])].sort((a, b) => a - b) });
    }
  }
  requireProof(baseline.every(path => files.has(path)), 'incomplete recovery source population');
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function verify(proof: Proof) {
  const runtime = proof.runtime;
  requireProof(runtime.host === 'port-3070' && runtime.processId && revisionPattern.test(runtime.artifact.sourceSha) &&
    runtime.artifact.status === 'measured' && runtime.artifact.sourceSha.startsWith(runtime.buildSha) &&
    digestPattern.test(runtime.artifact.bundleSha256) && digestPattern.test(runtime.artifact.manifestSha256) &&
    runtime.artifact.evidenceRef, 'unknown loaded release artifact');
  requireProof(isDeepStrictEqual(runtime, proof.runtimeAfter), 'release changed during measurement');
  requireProof(proof.promotion?.sourceSha === runtime.artifact.sourceSha && proof.promotion.id &&
    proof.deployment?.sourceSha === runtime.artifact.sourceSha && proof.deployment.id &&
    Number.isFinite(Date.parse(proof.promotion.at)) && Number.isFinite(Date.parse(proof.deployment.at)) &&
    Date.parse(proof.promotion.at) <= Date.parse(proof.deployment.at),
  'missing normal green promotion or deployment');
  requireProof(proof.files.length >= baseline.length && baseline.every(path => proof.files.some(file => file.path === path)) &&
    proof.containment.length === proof.files.length &&
    new Set(proof.containment.map(row => row.path)).size === proof.files.length,
  'incomplete containment population');
  for (const file of proof.files) {
    const row = proof.containment.find(row => row.path === file.path);
    const source = row?.acceptedSource;
    requireProof(isDeepStrictEqual(row?.runtime, runtime) && source?.expectedSha256 === file.sha256 &&
      source.observedSha256 === file.sha256 && source.matches === true && source.deployedContains === true &&
      Array.isArray(row!.runtimeIds) && (!baseline.includes(file.path) || row!.runtimeIds.length > 0) &&
      isDeepStrictEqual([...row!.runtimeIds].sort(), Object.keys(source.runtimeContainment).sort()) &&
      row!.runtimeIds.every(id => source.runtimeContainment[id] === true) &&
      Object.values(source.runtimeContainment).every(value => value === true),
    'accepted source absent, unknown or mismatched: ' + file.path);
  }
}
function tool(name: string, args: Json): Json {
  const raw = execFileSync('ptool', [name, '--url=http://127.0.0.1:3070', '--json', '-'], {
    input: JSON.stringify({ ...args, payloadTier: 'full' }), encoding: 'utf8', timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = JSON.parse(raw);
  requireProof(result.ok !== false && !result.error && result.state !== 'incomplete' && !result._partial &&
    !result._shapeNote && !result._projection?.truncated, 'partial or refused ' + name);
  return result;
}
function runtimeIdentity(value: Json): Runtime {
  // sourceRuntimeOnly projects sourceBlobs to the requested path. Those bytes
  // belong to per-path containment, not the stable process/artifact identity.
  const artifact = value?.artifact;
  return { host: value?.host, processId: value?.processId, buildSha: value?.buildSha,
    artifact: { status: artifact?.status, sourceSha: artifact?.sourceSha,
      bundleSha256: artifact?.bundleSha256, manifestSha256: artifact?.manifestSha256,
      evidenceRef: artifact?.evidenceRef } };
}
type Fixture = { acceptedRevision: string; evidencePath: string };
async function collect(fixture: Fixture): Promise<Proof> {
  requireProof(isAbsolute(fixture.evidencePath), 'external evidence path required');
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, onnotice: () => {}, connect_timeout: 10,
    connection: { statement_timeout: 30_000 } });
  try {
    // The complete current independent population is read from its writer's
    // ledger. A caller cannot omit inconvenient bindings through the fixture.
    const rows = await sql<Binding[]>`SELECT v.id::int, v.created_by AS author,
      b.created_by AS "originalAuthor", b.id::int AS verified, v.source_fingerprint AS source,
      b.source_fingerprint AS "originalSource", v.details->'measurementPin' AS pin
      FROM harness_shared.spec_evidence_bindings v
      JOIN harness_shared.spec_evidence_bindings b ON b.id=v.verifies_binding_id
        AND b.workspace_id=v.workspace_id AND b.harness_slug=v.harness_slug AND b.plan_slug=v.plan_slug
        AND b.spec_id=v.spec_id AND b.spec_revision=v.spec_revision AND b.spec_fingerprint=v.spec_fingerprint
      JOIN harness_shared.plan_spec_clauses c ON c.workspace_id=v.workspace_id AND c.harness_slug=v.harness_slug
        AND c.plan_slug=v.plan_slug AND c.spec_id=v.spec_id AND c.current_revision=v.spec_revision
      WHERE v.workspace_id=${workspace} AND v.harness_slug='papercusp' AND v.plan_slug=${plan}
        AND v.evidence_kind='independent-verification' AND v.retracted_at IS NULL AND b.retracted_at IS NULL
      ORDER BY v.id`;
    for (const row of rows) requireProof(!await areAcceptanceLineageRelated(row.author, row.originalAuthor,
      { sql, workspaceId: workspace }), 'reviewer shares implementer lineage');
    const files = acceptedFiles(rows, fixture.acceptedRevision);
    const read = (file: File) => tool('dev:pipeline_position', { path: file.path,
      expectedSourceSha256: file.sha256, sourceRuntimeOnly: true });
    const first = read(files[0]!);
    const runtime = runtimeIdentity(first.observingRuntime);
    const containment = files.map((file, index) => {
      const result = index === 0 ? first : read(file);
      return { path: file.path, acceptedSource: result.acceptedSource ?? null,
        runtime: runtimeIdentity(result.observingRuntime),
        runtimeIds: Array.isArray(result.servingRuntimes)
          ? result.servingRuntimes.map((row: Json) => row.runtime as string) : null };
    });
    const source = runtime?.artifact?.sourceSha;
    requireProof(revisionPattern.test(source ?? ''), 'missing deployed artifact revision');
    const [deployment] = await sql`SELECT id::text, created_at::text AS at FROM harness_shared.pipeline_events
      WHERE workspace_id IN (${workspace}, '*') AND install_slug='papercusp' AND kind='deploy' AND status='ok'
        AND detail->>'fullTargetSha'=${source} ORDER BY id DESC LIMIT 1`;
    const [promotion] = deployment ? await sql`SELECT id::text, created_at::text AS at FROM harness_shared.pipeline_events
      WHERE workspace_id IN (${workspace}, '*') AND install_slug='papercusp' AND kind='green_checkpoint'
        AND status IN ('advanced','advanced-prefix','up-to-date')
        AND length(COALESCE(detail->>'advancedTo',detail->>'candidate')) >= 12
        AND ${source} LIKE COALESCE(detail->>'advancedTo',detail->>'candidate') || '%'
        AND created_at <= ${deployment.at}::timestamptz
      ORDER BY id DESC LIMIT 1` : [];
    const proof: Proof = { acceptedRevision: fixture.acceptedRevision, files, runtime, containment,
      runtimeAfter: runtimeIdentity(read(files[0]!).observingRuntime),
      promotion: promotion ? { id: promotion.id, sourceSha: source, at: promotion.at } : null,
      deployment: deployment ? { id: deployment.id, sourceSha: source, at: deployment.at } : null };
    writeFileSync(fixture.evidencePath, JSON.stringify({ bindings: rows, proof }, null, 2), { flag: 'wx', mode: 0o600 });
    return proof;
  } finally { await sql.end({ timeout: 5 }); }
}
function control(): Proof {
  const source = 'a'.repeat(40), sha256 = 'b'.repeat(64);
  const runtime: Runtime = { host: 'port-3070', processId: 'fixture-process', buildSha: source,
    artifact: { status: 'measured', sourceSha: source, bundleSha256: sha256, manifestSha256: sha256,
      evidenceRef: 'fixture-only' } };
  const files = baseline.map(path => ({ path, sha256, bindings: [1] }));
  return { acceptedRevision: source, files, runtime, runtimeAfter: structuredClone(runtime),
    promotion: { id: '1', sourceSha: source, at: '2026-11-06T00:00:00Z' },
    deployment: { id: '2', sourceSha: source, at: '2026-11-06T00:01:00Z' },
    containment: files.map(file => ({ path: file.path, runtime: structuredClone(runtime), runtimeIds: ['release-operator'],
      acceptedSource: { expectedSha256: sha256, observedSha256: sha256, matches: true,
        deployedContains: true, runtimeContainment: { 'release-operator': true } } })) };
}
describe('session recovery exact green shipment', () => {
  it('accepts the complete control while allowing a later deployed commit that preserves accepted bytes', () => {
    const proof = control(); proof.acceptedRevision = 'c'.repeat(40);
    expect(() => verify(proof)).not.toThrow();
  });
  it.each(['missing-file', 'unknown-runtime', 'extra-unknown-runtime', 'wrong-bytes', 'missing-green',
    'deployment-before-green', 'wrong-deployed-revision', 'changed-process', 'unknown-artifact'] as const)('refuses %s', fault => {
    const proof = control();
    if (fault === 'missing-file') proof.containment.pop();
    if (fault === 'unknown-runtime') proof.containment[0]!.acceptedSource!.runtimeContainment['release-operator'] = null;
    if (fault === 'extra-unknown-runtime') proof.containment[0]!.runtimeIds!.push('psu-pty-host');
    if (fault === 'wrong-bytes') proof.containment[0]!.acceptedSource!.observedSha256 = 'd'.repeat(64);
    if (fault === 'missing-green') proof.promotion = null;
    if (fault === 'deployment-before-green') proof.deployment!.at = '2026-11-05T00:00:00Z';
    if (fault === 'wrong-deployed-revision') proof.deployment!.sourceSha = 'd'.repeat(40);
    if (fault === 'changed-process') proof.runtimeAfter.processId = 'replacement';
    if (fault === 'unknown-artifact') proof.runtime.artifact.status = 'unknown';
    expect(() => verify(proof)).toThrow(/Recovery shipment unproven/);
  });
  it('refuses an empty independent manifest and conflicting or partial accepted populations', () => {
    expect(() => acceptedFiles([], 'a'.repeat(40))).toThrow(/independent source revision/);
    const row: Binding = { id: 1, author: 'reviewer', originalAuthor: 'implementer', verified: 2,
      source: 'fingerprint', originalSource: 'fingerprint', pin: { repos: [{ repo: '.', head: 'a'.repeat(40) }],
        files: baseline.map(path => ({ path, sha256: 'b'.repeat(64), dimension: 'source', clean: true })) } };
    expect(acceptedFiles([row], 'a'.repeat(40))).toHaveLength(baseline.length);
    const conflicting = structuredClone(row); conflicting.id = 3; conflicting.pin.files[0]!.sha256 = 'c'.repeat(64);
    expect(() => acceptedFiles([row, conflicting], 'a'.repeat(40))).toThrow(/conflicting accepted source hashes/);
    row.pin.files.pop();
    expect(() => acceptedFiles([row], 'a'.repeat(40))).toThrow(/incomplete recovery source population/);
  });
  it('compares a stable boot identity across per-path source projections', () => {
    const runtime = control().runtime;
    expect(runtimeIdentity({ ...runtime, artifact: { ...runtime.artifact, sourceBlobs: { a: 'hash-a' } } }))
      .toEqual(runtimeIdentity({ ...runtime, artifact: { ...runtime.artifact, sourceBlobs: { b: 'hash-b' } } }));
  });
  it.skipIf(!process.env.PAPERCUSP_SESSION_RECOVERY_RELEASE_FIXTURE)(
    'verifies the independent accepted manifest on the exact normally promoted and executing release', async () => {
      requireProof(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE ===
        'packages/operator-core/test/fixtures/session-recovery-release.live-profile.json' &&
        process.env.PAPERCUSP_TEST_RUN_HARNESS === 'papercusp' && process.env.PAPERCUSP_TEST_RUN_WORK_ITEM,
      'maintained final-release profile and canonical attribution required');
      verify(await collect(JSON.parse(readFileSync(process.env.PAPERCUSP_SESSION_RECOVERY_RELEASE_FIXTURE!, 'utf8'))));
    }, 600_000);
});
