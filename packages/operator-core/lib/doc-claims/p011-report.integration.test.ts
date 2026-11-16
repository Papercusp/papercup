/**
 * P011 report-native reconciliation of the identity-redacted dated report copy.
 * Reuses docs/evidence artifacts and the maintained doc-claims test family.
 * Recounts the retained complete candidate population without running measure.py.
 * Original selected-claim judgments are observations, not independent semantic
 * acceptance. This is P011's mechanical R-15 contribution; live credit also
 * requires the declared actual configuration and separate independent recount
 * and judgment evidence. It proves neither a coherent freeze nor shipment.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '@papercusp/hash-chain';

interface Sample { id: string; cls: string; outcome: string; finding: string; limits: string }
interface Artifact {
  reportId: string; bodySha256: string; body_md: string; seed: string; sampleHash: string;
  publicBodySha256: string;
  bodyRepresentation: { kind: string; serializer: string; originalReportPath: string;
    originalSourcePath: string; hashMeaning: string };
  sourceArtifacts: Record<string, { path: string; sha256: string }>;
  sourceVector: { registry_snapshot: string; registry_captured_at: string;
    file_manifest_sha256: string; entry_manifest_sha256: string; files: number;
    repositories: { path: string; head: string; tree: string }[] };
  sample: Sample[]; strata: Record<string, number>;
  population: { path: string; compressedSha256: string; uncompressedSha256: string; count: number };
}
const root = resolve(import.meta.dirname, '../../../..');
const publicArtifact: Artifact = JSON.parse(readFileSync(resolve(root,
  'docs/evidence/p011-corpus-count-sample-2026-11-15.json'), 'utf8'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const actual = process.env.PAPERCUSP_DOCUMENTATION_PROOF_MODE === 'actual';
interface Entry { cls: string; id: string; eligible: boolean }
interface Inventory {
  seed: string; sample_hash: string; sample_ids: string[]; entries: Entry[]; files: unknown[];
  source_vector: Artifact['sourceVector'];
  six_candidate_strata: Record<string, { count: number }>;
}
/** Actual mode reads the original retained measurement, never the public copy.
 * Missing or altered inputs throw before collection; there is no fixture fallback.
 * These dated inputs are not a rescan, a coherent edition or semantic acceptance.
 */
function originalMeasurement() {
  const directory = process.env.PAPERCUSP_P011_MATERIALIZATION_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error('Actual P011 requires an absolute materialization directory');
  const inputs: Record<string, Buffer> = {};
  for (const [name, source] of Object.entries(publicArtifact.sourceArtifacts)) {
    const bytes = readFileSync(resolve(directory, name));
    if (hash(bytes) !== source.sha256) throw new Error(`Actual P011 source identity mismatch: ${name}`);
    inputs[name] = bytes;
  }
  const body = readFileSync(resolve(directory, 'report.md'), 'utf8');
  if (hash(body) !== publicArtifact.bodySha256) throw new Error('Actual P011 original report identity mismatch');
  const inventory = JSON.parse(inputs['inventory.json']!.toString('utf8')) as Inventory;
  const sampled = JSON.parse(inputs['sample.json']!.toString('utf8')) as (Entry & Record<string, unknown>)[];
  const review = JSON.parse(inputs['review.json']!.toString('utf8')) as {
    judgments: { id: string; class: string; outcome: string; finding: string; limits: string }[];
  };
  const recount = JSON.parse(inputs['recount.json']!.toString('utf8')) as { sample_count: number; unique_entries: number };
  if (hash(canonicalJson(inventory.entries)) !== inventory.source_vector.entry_manifest_sha256
    || hash(canonicalJson(inventory.files)) !== inventory.source_vector.file_manifest_sha256
    || hash(canonicalJson(sampled.map(({ body: _body, ...entry }) => entry))) !== inventory.sample_hash
    || recount.sample_count !== sampled.length || recount.unique_entries !== inventory.entries.length
    || JSON.stringify(sampled.map(row => row.id)) !== JSON.stringify(inventory.sample_ids))
    throw new Error('Actual P011 measurement/recount identity mismatch');
  return { inventory, artifact: {
    ...publicArtifact, body_md: body, seed: inventory.seed, sampleHash: inventory.sample_hash,
    sourceVector: inventory.source_vector,
    strata: Object.fromEntries(Object.entries(inventory.six_candidate_strata).map(([key, value]) => [key, value.count])),
    sample: review.judgments.map(row => ({ ...row, cls: row.class })),
  } };
}
const original = actual ? originalMeasurement() : null;
const artifact = original?.artifact ?? publicArtifact;
const compressed = readFileSync(resolve(root, publicArtifact.population.path));
const bytes = gunzipSync(compressed);
const population = original?.inventory.entries ?? bytes.toString('utf8').trimEnd().split('\n').map(line => {
  const cells = line.split('\t');
  if (cells.length !== 3 || !['0', '1'].includes(cells[2]!)) throw new Error('invalid population row');
  return { cls: cells[0]!, id: cells[1]!, eligible: cells[2] === '1' };
});
// Declare the measurement's source taxonomy independently of its output. A
// missing category must remain a required report row, including an honest zero.
// Registry documents/parts/notes/prompts and repository guides, delivered agent
// instructions, history, native comments, envelopes and untracked text all count.
const classes = [
  'registry-code-note', 'registry-composed-parent', 'registry-composed-part',
  'registry-fresh-document', 'registry-other-document', 'registry-prompt-override',
  'registry-saved-prompt', 'repo-delivered-projection', 'repo-guide-document',
  'repo-history-document', 'repo-native-source-envelope', 'repo-other-document',
  'repo-prompt-source', 'repo-rust-doc-candidate', 'repo-typescript-doc-candidate',
  'repo-unsupported-source-envelope', 'repo-untracked-text',
];
const stratumKeys = ['authored:rust', 'authored:typescript', 'composed:rust',
  'composed:typescript', 'native:rust', 'native:typescript'];
const representationCounts = new Map(classes.map(cls => [cls, 0]));
for (const row of population) {
  const count = representationCounts.get(row.cls);
  if (count === undefined) throw new Error('Undeclared P011 source class: ' + row.cls);
  representationCounts.set(row.cls, count + 1);
}
const outcomes = ['consistent', 'contradicted', 'historical', 'not-applicable', 'unresolved'];
const groups = new Map(classes.map(cls => [cls, population.filter(row => row.cls === cls && row.eligible)
  .map(row => ({ ...row, rank: hash(artifact.seed + '\0' + row.id) }))
  .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)]));
const selected: string[] = [];
for (let round = 0; selected.length < Math.min(50, population.filter(row => row.eligible).length); round++) {
  for (const cls of classes) {
    const row = groups.get(cls)![round];
    if (row && selected.length < 50) selected.push(row.id);
  }
}

beforeAll(async () => {
  if (!actual) return;
  const origin = process.env.OPERATOR_E2E_BASE_URL;
  const expected = process.env.OPERATOR_REPORT_BUILD_SHA;
  if (!origin || !expected || !/^[a-f0-9]{7,40}$/.test(expected))
    throw new Error('Actual P011 requires explicit operator origin and build identity');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Actual P011 requires a local operator origin');
  const client = process.env.PAPERCUSP_SID;
  if (!client || url.protocol !== 'http:')
    throw new Error('Actual P011 report read requires an attributed session and local HTTP operator');
  const health = async () => {
    const response = await fetch(url.origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Actual P011 runtime HTTP ${response.status}`);
    const value = await response.json() as { ok?: boolean; sha?: string; bundleStale?: boolean };
    if (value.ok !== true || !value.sha || value.bundleStale
      || !(expected.startsWith(value.sha) || value.sha.startsWith(expected)))
      throw new Error('Actual P011 serving build differs from its declared runtime');
    return value.sha;
  };
  const before = await health();
  const { stdout } = await promisify(execFile)(process.execPath,
    // The maintained named-call helper avoids a full tools/list bootstrap on
    // every probe phase. Keep the same bounded read and explicit runtime pin.
    [resolve(root, 'scripts/mcp-call.mjs'), 'reports:get', JSON.stringify({
      id: artifact.reportId, projection: { pick: ['ok', 'results[].ok', 'results[].id',
        'results[].report.report_id', 'results[].report.workspace_id', 'results[].report.visibility',
        'results[].report.path', 'results[].report.body_sha256', 'results[].report.body_bytes'] },
    }), '--client', client, '--workspace', 'papercusp-workspace', '--harness', 'papercusp',
      '--port', url.port || '80'],
    { cwd: root, env: process.env, timeout: 45_000, maxBuffer: 2_000_000 });
  const receipt = JSON.parse(stdout) as { ok: boolean; results: { ok: boolean; id: string; report: {
    report_id: string; workspace_id: string; visibility: string; path: string; body_sha256: string; body_bytes: number;
  } }[] };
  expect(receipt.ok).toBe(true);
  expect(receipt.results).toHaveLength(1);
  expect(receipt.results[0]).toMatchObject({ ok: true, id: artifact.reportId, report: {
    report_id: artifact.reportId, workspace_id: 'papercusp-workspace', visibility: 'workspace',
    path: `/reports?sel=${artifact.reportId}`, body_sha256: hash(artifact.body_md),
    body_bytes: Buffer.byteLength(artifact.body_md, 'utf8'),
  } });
  const after = await health();
  expect(after).toBe(before);
  console.log('P011_ACTUAL_REPORT_IDENTITY=' + JSON.stringify({ reportId: artifact.reportId,
    bodySha256: hash(artifact.body_md), origin: url.origin, before, after,
    sourceVector: artifact.sourceVector, sampleHash: artifact.sampleHash,
    scope: 'dated original materialization; no coherent freeze, rescan or semantic self-certification' }));
}, 75_000);

function section(body: string, heading: string): string {
  return body.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
}
function table(body: string, heading: string): string[][] {
  return section(body, heading).split('\n').filter(line => line.startsWith('| '))
    .slice(1).map(line => line.slice(2, -2).split(' | '));
}
const plainId = (cell: string | undefined) => cell?.replace(/^`|`$/g, '') ?? '';
const countHeading = 'Counts and per-class sample results';
const sampleHeading = 'Exact sample and recorded judgments';
const strataHeading = 'Six proposed pilot strata';
const limitClauses = [
  'not a globally atomic frozen edition',
  'whole-source-vector pre/post stability proof has not been established',
  'Other extensions (6,880 file entries)',
  'Rust /// and //! grouping omits block doc-comment forms',
  '21 consistent results cover named claims, not full-document certification',
  'not release-operator shipment evidence',
];

/** No whole-report hash shortcut: a control must reach its specific refusal. */
function violations(body: string): string[] {
  const reasons: string[] = [];
  const countRows = table(body, countHeading);
  if (new Set(countRows.map(row => row[0])).size !== countRows.length) reasons.push('duplicate-class');
  for (const cls of classes) {
    const rows = countRows.filter(row => row[0] === cls);
    if (rows.length !== 1) { reasons.push(`class-missing:${cls}`); continue; }
    const expectedSample = artifact.sample.filter(row => row.cls === cls);
    const expected = [representationCounts.get(cls), groups.get(cls)!.length,
      expectedSample.length, ...outcomes.map(outcome => expectedSample.filter(row => row.outcome === outcome).length)];
    if (JSON.stringify(rows[0]!.slice(1).map(Number)) !== JSON.stringify(expected))
      reasons.push(`class-count-mismatch:${cls}`);
  }
  if (countRows.some(row => !classes.includes(row[0]!))) reasons.push('extra-class');
  const sampleRows = table(body, sampleHeading);
  const actualIds = sampleRows.map(row => plainId(row[2]));
  if (JSON.stringify(actualIds) !== JSON.stringify(selected)) reasons.push('sample-population-mismatch');
  for (const cls of classes) {
    if (groups.get(cls)!.length && !sampleRows.some(row => row[1] === cls)) reasons.push(`unsampled-class:${cls}`);
  }
  for (const sample of artifact.sample) {
    const rows = sampleRows.filter(row => plainId(row[2]) === sample.id);
    if (rows.length !== 1) continue;
    if (rows[0]![1] !== sample.cls) reasons.push(`sample-class-mismatch:${sample.id}`);
    if (rows[0]![3] !== sample.outcome) reasons.push(`judgment-mismatch:${sample.id}`);
    if (!rows[0]![4]?.trim()) reasons.push(`judgment-evidence-missing:${sample.id}`);
  }
  const strata = table(body, strataHeading);
  for (const key of stratumKeys) {
    const count = artifact.strata[key];
    if (!Number.isSafeInteger(count) || count! < 0) reasons.push(`stratum-source-missing:${key}`);
    const rows = strata.filter(row => row[0] === key);
    if (rows.length !== 1) reasons.push(`stratum-missing:${key}`);
    else if (Number(rows[0]![1]) !== count) reasons.push(`stratum-count-mismatch:${key}`);
  }
  if (strata.some(row => !stratumKeys.includes(row[0]!))) reasons.push('extra-stratum');
  const sampling = section(body, 'Deterministic sampling procedure');
  if (!sampling.includes(artifact.seed)) reasons.push('sampling-seed-missing');
  if (!sampling.includes('SHA-256(seed + NUL + stable scoped id)')
    || !sampling.includes('sorted class-name order')) reasons.push('sampling-method-missing');
  if (!sampling.includes(artifact.sampleHash)) reasons.push('sample-identity-missing');
  const vector = section(body, 'Source vector and scope');
  for (const value of [artifact.sourceVector.registry_snapshot, artifact.sourceVector.registry_captured_at,
    artifact.sourceVector.file_manifest_sha256, artifact.sourceVector.entry_manifest_sha256]) {
    if (!vector.includes(value)) reasons.push(`source-identity-missing:${value}`);
  }
  const limits = section(body, 'Limits and pending acceptance');
  for (const clause of limitClauses) if (!limits.includes(clause)) reasons.push(`limit-missing:${clause}`);
  return reasons;
}

function replaceCell(body: string, heading: string, row: number, column: number, value: string): string {
  const cells = table(body, heading)[row]!;
  const original = '| ' + cells.join(' | ') + ' |';
  const altered = [...cells]; altered[column] = value;
  if (!body.includes(original)) throw new Error('control row unavailable');
  return body.replace(original, '| ' + altered.join(' | ') + ' |');
}
function omitRow(body: string, heading: string, predicate: (row: string[]) => boolean): string {
  const row = table(body, heading).find(predicate);
  if (!row) throw new Error('control row unavailable');
  return body.replace('| ' + row.join(' | ') + ' |\n', '');
}

// Keep each causal baseline as its own execution identity. A baseline assertion
// inside a falsifier test cannot supply a second case-role observation. These
// remain mechanical report checks, not independent semantic acceptance.
const reportControls = [
  ...classes.map((cls, row) => ({
    family: 'contradictory-class-count', id: cls,
    altered: replaceCell(artifact.body_md, countHeading, row, 1,
      String(Number(table(artifact.body_md, countHeading)[row]![1]) + 1)),
    reason: `class-count-mismatch:${cls}`,
  })),
  ...artifact.sample.map((sample, index) => ({
    family: 'contradictory-sampled-judgment', id: sample.id,
    altered: replaceCell(artifact.body_md, sampleHeading, index, 3,
      sample.outcome === 'contradicted' ? 'consistent' : 'contradicted'),
    reason: `judgment-mismatch:${sample.id}`,
  })),
  ...classes.map(cls => ({
    family: 'missing-class-or-limits', id: `class:${cls}`,
    altered: omitRow(artifact.body_md, countHeading, row => row[0] === cls),
    reason: `class-missing:${cls}`,
  })),
  ...classes.filter(cls => groups.get(cls)!.length > 0).map(cls => {
    let altered = artifact.body_md;
    for (const sample of artifact.sample.filter(row => row.cls === cls))
      altered = omitRow(altered, sampleHeading, row => plainId(row[2]) === sample.id);
    return { family: 'omitted-nonempty-class-sample', id: cls, altered, reason: `unsampled-class:${cls}` };
  }),
  ...stratumKeys.map(key => ({
    family: 'missing-stratum-existence-field', id: key,
    altered: omitRow(artifact.body_md, strataHeading, row => row[0] === key),
    reason: `stratum-missing:${key}`,
  })),
  ...limitClauses.map(clause => ({
    family: 'missing-class-or-limits', id: `limit:${clause}`,
    altered: artifact.body_md.replace(clause, ''), reason: `limit-missing:${clause}`,
  })),
  ...[
    [artifact.seed, 'sampling-seed-missing'],
    ['SHA-256(seed + NUL + stable scoped id)', 'sampling-method-missing'],
    [artifact.sampleHash, 'sample-identity-missing'],
    ...[artifact.sourceVector.registry_snapshot, artifact.sourceVector.registry_captured_at,
      artifact.sourceVector.file_manifest_sha256, artifact.sourceVector.entry_manifest_sha256]
      .map(value => [value, `source-identity-missing:${value}`]),
  ].map(([value, reason]) => ({
    family: 'missing-sampling-identity', id: reason!,
    altered: artifact.body_md.replace(value!, ''), reason: reason!,
  })),
  {
    family: 'reproducible-count-sample', id: 'duplicate-sampled-identity',
    altered: replaceCell(artifact.body_md, sampleHeading, 1, 2,
      table(artifact.body_md, sampleHeading)[0]![2]!),
    reason: 'sample-population-mismatch',
  },
  {
    family: 'reproducible-count-sample', id: 'extra-sampled-identity',
    altered: (() => {
      const row = '| ' + table(artifact.body_md, sampleHeading)[0]!.join(' | ') + ' |';
      return artifact.body_md.replace(row, row + '\n' + row);
    })(),
    reason: 'sample-population-mismatch',
  },
];

function expectReproduction() {
    expect(artifact.reportId).toBe('rpt_120bd45f-696a-485e-b576-aeb904308ad5');
    expect(artifact.bodySha256).toBe('5f3a484fe1b0f0cbaaa42fb73763129af69581b327eebf9aae87b56111ad1029');
    expect(publicArtifact.bodyRepresentation.kind).toBe('identity-redacted-public-copy');
    expect(artifact.bodyRepresentation.originalReportPath).toBe(`/reports?sel=${artifact.reportId}`);
    expect(artifact.bodyRepresentation.originalSourcePath).toBe('.papercusp/scratch/p011-census-20261115/report.md');
    expect(artifact.bodyRepresentation.hashMeaning).toContain('bodySha256 identifies the immutable original report');
    expect(artifact.publicBodySha256).toBe('3947a507b15a008c1917c81e6a54a34d8da3a71c7459a4986e6264921841e922');
    expect(hash(artifact.body_md)).toBe(actual ? artifact.bodySha256 : artifact.publicBodySha256);
    expect(artifact.publicBodySha256).not.toBe(artifact.bodySha256);
    expect(hash(compressed)).toBe(artifact.population.compressedSha256);
    expect(hash(bytes)).toBe(artifact.population.uncompressedSha256);
    expect(population).toHaveLength(artifact.population.count);
    expect(Object.keys(artifact.strata).sort()).toEqual([...stratumKeys].sort());
    expect(new Set(population.map(row => row.id)).size).toBe(population.length);
    expect(selected).toEqual(artifact.sample.map(row => row.id));
    expect(artifact.sample).toHaveLength(50);
    expect(violations(artifact.body_md)).toEqual([]);
}

describe(`P011 ${actual ? 'original materialization and live report' : 'public copy'} mechanical integration and causal report controls`, () => {
  it('pins the immutable original reference, public copy and complete measured candidate population', () => {
    expectReproduction();
  });

  it('keeps the entire public evidence artifact clean under the sanctioned identity serializer', () => {
    expect(publicArtifact.bodyRepresentation.serializer)
      .toBe('scripts/lib/identity-leak-patterns.mjs#serializeIdentitySafeJson');
    const serialized = execFileSync(process.execPath,
      [resolve(root, 'scripts/lib/identity-leak-patterns.mjs'), '--serialize-json'],
      { input: JSON.stringify(publicArtifact), encoding: 'utf8' });
    expect(JSON.parse(serialized)).toEqual(publicArtifact);
  });

  it('keeps every collected baseline and falsifier execution identity distinct', ({ task }) => {
    const identities = task.suite!.tasks.filter(child => child.type === 'suite')
      .flatMap(suite => suite.tasks.filter(child => child.type === 'test')
        .map(child => suite.name + ' > ' + child.name));
    expect(identities).toHaveLength(reportControls.length * 2);
    expect(new Set(identities).size).toBe(identities.length);
  });

  // Vitest truncates interpolated long ids. The pinned ordinal preserves native
  // case identity even when two sampled source ids share the displayed prefix.
  describe.each(reportControls.map((control, index) => ({ ...control, ordinal: index + 1 })))(
    '$family #$ordinal: $id', control => {
    it('[plan:language-neutral-code-documentation-integration-2026-11-12][R-15][baseline] accepts the complete original report', () => {
      if (control.family === 'reproducible-count-sample') expectReproduction();
      expect(violations(artifact.body_md)).toEqual([]);
    });

    it('[plan:language-neutral-code-documentation-integration-2026-11-12][R-15][falsifier] rejects the named alteration', () => {
      expect(control.altered).not.toBe(artifact.body_md);
      expect(violations(control.altered)).toContain(control.reason);
    });
  });
});
