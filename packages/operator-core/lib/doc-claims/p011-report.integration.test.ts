/**
 * P011 report-native mechanical reconciliation of the actual dated report.
 * Reuses docs/evidence artifacts and the maintained doc-claims test family.
 * Recounts the retained complete candidate population without running measure.py.
 * Original selected-claim judgments are observations, not independent semantic
 * acceptance. These tests confer no BAR credit, coherent freeze or shipment proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

interface Sample { id: string; cls: string; outcome: string; finding: string; limits: string }
interface Artifact {
  reportId: string; bodySha256: string; body_md: string; seed: string; sampleHash: string;
  sourceArtifacts: Record<string, { path: string; sha256: string }>;
  sourceVector: { registry_snapshot: string; registry_captured_at: string;
    file_manifest_sha256: string; entry_manifest_sha256: string; files: number;
    repositories: { path: string; head: string; tree: string }[] };
  sample: Sample[]; strata: Record<string, number>;
  population: { path: string; compressedSha256: string; uncompressedSha256: string; count: number };
}
const root = resolve(import.meta.dirname, '../../../..');
const artifact: Artifact = JSON.parse(readFileSync(resolve(root,
  'docs/evidence/p011-corpus-count-sample-2026-11-15.json'), 'utf8'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const compressed = readFileSync(resolve(root, artifact.population.path));
const bytes = gunzipSync(compressed);
const population = bytes.toString('utf8').trimEnd().split('\n').map(line => {
  const cells = line.split('\t');
  if (cells.length !== 3 || !['0', '1'].includes(cells[2]!)) throw new Error('invalid population row');
  return { cls: cells[0]!, id: cells[1]!, eligible: cells[2] === '1' };
});
const classes = [...new Set(population.map(row => row.cls))].sort();
const representationCounts = new Map(classes.map(cls => [cls, 0]));
for (const row of population) representationCounts.set(row.cls, representationCounts.get(row.cls)! + 1);
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
  for (const [key, count] of Object.entries(artifact.strata)) {
    const rows = strata.filter(row => row[0] === key);
    if (rows.length !== 1) reasons.push(`stratum-missing:${key}`);
    else if (Number(rows[0]![1]) !== count) reasons.push(`stratum-count-mismatch:${key}`);
  }
  if (strata.some(row => !(row[0]! in artifact.strata))) reasons.push('extra-stratum');
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

describe('P011 actual report mechanical integration and causal report controls', () => {
  it('pins the actual immutable report and complete measured candidate population', () => {
    expect(artifact.reportId).toBe('rpt_120bd45f-696a-485e-b576-aeb904308ad5');
    expect(artifact.bodySha256).toBe('5f3a484fe1b0f0cbaaa42fb73763129af69581b327eebf9aae87b56111ad1029');
    expect(hash(artifact.body_md)).toBe(artifact.bodySha256);
    expect(hash(compressed)).toBe(artifact.population.compressedSha256);
    expect(hash(bytes)).toBe(artifact.population.uncompressedSha256);
    expect(population).toHaveLength(artifact.population.count);
    expect(new Set(population.map(row => row.id)).size).toBe(population.length);
    expect(selected).toEqual(artifact.sample.map(row => row.id));
    expect(artifact.sample).toHaveLength(50);
    expect(violations(artifact.body_md)).toEqual([]);
  });

  it.each(classes)('rejects an altered class count: %s', cls => {
    const row = classes.indexOf(cls);
    const count = Number(table(artifact.body_md, countHeading)[row]![1]);
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(replaceCell(artifact.body_md, countHeading, row, 1, String(count + 1))))
      .toContain(`class-count-mismatch:${cls}`);
  });

  it.each(artifact.sample.map((sample, index) => ({ ...sample, index })))(
    'rejects an inverted sampled judgment: $id', sample => {
      expect(violations(artifact.body_md)).toEqual([]);
      const flipped = sample.outcome === 'contradicted' ? 'consistent' : 'contradicted';
      expect(violations(replaceCell(artifact.body_md, sampleHeading, sample.index, 3, flipped)))
        .toContain(`judgment-mismatch:${sample.id}`);
    });

  it.each(classes)('rejects an omitted class count: %s', cls => {
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(omitRow(artifact.body_md, countHeading, row => row[0] === cls)))
      .toContain(`class-missing:${cls}`);
  });

  it.each(classes.filter(cls => groups.get(cls)!.length > 0))('rejects omission of every sample in eligible class: %s', cls => {
    let altered = artifact.body_md;
    for (const sample of artifact.sample.filter(row => row.cls === cls))
      altered = omitRow(altered, sampleHeading, row => plainId(row[2]) === sample.id);
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(altered)).toContain(`unsampled-class:${cls}`);
  });

  it.each(Object.keys(artifact.strata))('rejects a missing stratum field, including honest zeros: %s', key => {
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(omitRow(artifact.body_md, strataHeading, row => row[0] === key)))
      .toContain(`stratum-missing:${key}`);
  });

  it.each(limitClauses)('rejects an omitted report limitation: %s', clause => {
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(artifact.body_md.replace(clause, ''))).toContain(`limit-missing:${clause}`);
  });

  it.each([
    [artifact.seed, 'sampling-seed-missing'],
    ['SHA-256(seed + NUL + stable scoped id)', 'sampling-method-missing'],
    [artifact.sampleHash, 'sample-identity-missing'],
    ...[artifact.sourceVector.registry_snapshot, artifact.sourceVector.registry_captured_at,
      artifact.sourceVector.file_manifest_sha256, artifact.sourceVector.entry_manifest_sha256]
      .map(value => [value, `source-identity-missing:${value}`]),
  ])('rejects omitted source/sampling identity: %s', (value, reason) => {
    expect(violations(artifact.body_md)).toEqual([]);
    expect(violations(artifact.body_md.replace(value!, ''))).toContain(reason);
  });

  it('rejects a duplicate sampled identity and an additional sampled row', () => {
    const rows = table(artifact.body_md, sampleHeading);
    expect(violations(replaceCell(artifact.body_md, sampleHeading, 1, 2, rows[0]![2]!)))
      .toContain('sample-population-mismatch');
    const extra = '| ' + rows[0]!.join(' | ') + ' |';
    expect(violations(artifact.body_md.replace(extra, extra + '\n' + extra)))
      .toContain('sample-population-mismatch');
  });
});
