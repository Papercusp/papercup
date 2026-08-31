/**
 * testing:verdict_diff — plan `test-verdict-diff-2026-08-31` P-002/P-003/P-005.
 *
 * The bucket logic is tested purely in ../../testing-verdict-diff.test.ts. What
 * is asserted HERE is what only the tool can get wrong: the population it reads
 * (D-004), the sha it is willing to name (P-005), the boundedness of its
 * aggregates (P-003), and its refusal to answer vacuously.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool, { isAsymmetricSelection, resolveJudgedSha } from './verdict-diff';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

type Bucket = { count: number; files: Array<{ filePath: string }>; truncatedByLimit: boolean; omitted: number };
type DiffData = {
  ok: boolean;
  error?: string;
  role?: string;
  baseline?: { runGroupId: string; commitSha: string | null; commitShaCount: number; commitShaAmbiguous: boolean };
  candidate?: { runGroupId: string; commitSha: string | null; commitShaCount: number; commitShaAmbiguous: boolean };
  newlyFailing?: Bucket;
  newlyPassing?: Bucket;
  stillFailing?: Bucket;
  onlyInCandidate?: Bucket;
  onlyInBaseline?: Bucket;
  notMeasured?: Bucket;
  unchangedPassing?: number;
  totals?: { baselineFiles: number; candidateFiles: number; baselineRed: number; candidateRed: number };
  warnings?: string[];
};

const group = (id: string, shaCount: string, oneSha: string | null, files = '3') => ({
  id,
  first_start: '2026-08-31T10:00:00.000Z',
  last_finish: '2026-08-31T11:00:00.000Z',
  rows: files,
  files,
  sha_count: shaCount,
  one_sha: oneSha,
});

const verdict = (runGroupId: string, filePath: string, status: string, outputTail: string | null = null) => ({
  run_group_id: runGroupId,
  file_path: filePath,
  status,
  output_tail: outputTail,
});

const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let groupsFixture: ReturnType<typeof group>[] = [];
let verdictFixture: ReturnType<typeof verdict>[] = [];

function renderSql(call: { strings: string[]; values: unknown[] }): string {
  return call.strings
    .map((part, index) => {
      const value = call.values[index] as { strings?: string[]; values?: unknown[] } | undefined;
      const nested = value && Array.isArray(value.strings) ? renderSql(value as never) : '';
      return `${part}${nested}`;
    })
    .join('');
}

async function run(args: Record<string, unknown> = {}): Promise<DiffData> {
  const result = (await tool.handler(args as never, {} as never)) as {
    data?: DiffData;
    content?: Array<{ text: string }>;
  };
  return result.data ?? (JSON.parse(result.content?.[0]?.text ?? '{}') as DiffData);
}

beforeEach(() => {
  sqlCalls.length = 0;
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = { strings: Array.from(strings), values };
    sqlCalls.push(call);
    const text = call.strings.join(' ');
    if (text.includes('run_group_id AS id')) return Promise.resolve(groupsFixture);
    if (text.includes('WITH filtered')) return Promise.resolve(verdictFixture);
    return call; // a composed WHERE fragment
  });

  groupsFixture = [group('run-new', '1', 'aaaaaaaaaaaa'), group('run-old', '1', 'bbbbbbbbbbbb')];
  verdictFixture = [
    verdict('run-old', 'a.test.ts', 'pass'),
    verdict('run-old', 'b.test.ts', 'fail'),
    verdict('run-old', 'c.test.ts', 'pass'),
    verdict('run-new', 'a.test.ts', 'fail', 'AssertionError: expected 1 to be 2'),
    verdict('run-new', 'b.test.ts', 'fail'),
    verdict('run-new', 'c.test.ts', 'pass'),
  ];
});

describe('D-004 — default population is CI and not dirty', () => {
  it('filters to source ci with worktree_dirty=false unless told otherwise', async () => {
    await run();
    const population = sqlCalls.find((c) => c.strings.some((p) => p.includes('run_group_id IS NOT NULL')));
    expect(population).toBeDefined();
    expect(renderSql(population!)).toContain('worktree_dirty = false');
    // A dirty CI run "proves nothing about any sha" — the source value must be
    // bound as ci, not left unscoped where local rows join the verdict.
    expect(population!.values).toContain('ci');
    expect(population!.values).toContain(false);
  });

  it('passes includeDirty through as the escape hatch', async () => {
    await run({ includeDirty: true });
    const population = sqlCalls.find((c) => c.strings.some((p) => p.includes('run_group_id IS NOT NULL')));
    expect(population!.values).toContain(true);
  });

  it('honours an explicit source', async () => {
    const data = await run({ source: 'local' });
    const population = sqlCalls.find((c) => c.strings.some((p) => p.includes('run_group_id IS NOT NULL')));
    expect(population!.values).toContain('local');
    expect(data).toMatchObject({ source: 'local' });
  });
});

describe('D-001 — the diff unit is the run group', () => {
  it('picks the two most recent groups by FIRST-SEEN and orders candidate/baseline', async () => {
    const data = await run();
    const groupsQuery = sqlCalls.find((c) => c.strings.some((p) => p.includes('run_group_id AS id')));
    expect(renderSql(groupsQuery!)).toContain('ORDER BY min(started_at) DESC');
    expect(data.candidate?.runGroupId).toBe('run-new');
    expect(data.baseline?.runGroupId).toBe('run-old');
  });

  it('collapses to the latest attempt per file within each group', async () => {
    await run();
    const census = sqlCalls.find((c) => c.strings.some((p) => p.includes('WITH filtered')));
    const text = renderSql(census!);
    expect(text).toContain('DISTINCT ON (run_group_id, file_path)');
    expect(text).toContain('finished_at DESC NULLS LAST');
  });
});

describe('P-005 — never present one arbitrary sha as "the sha this judged"', () => {
  it('reports commitSha NULL when the group spans several shas', async () => {
    groupsFixture = [group('run-new', '15', 'aaaaaaaaaaaa'), group('run-old', '1', 'bbbbbbbbbbbb')];
    const data = await run();

    expect(data.candidate).toMatchObject({
      commitSha: null,
      commitShaCount: 15,
      commitShaAmbiguous: true,
    });
    // Stronger than the field check: the arbitrary member must not appear
    // ANYWHERE in the payload, where a reader would take it for the candidate.
    expect(JSON.stringify(data)).not.toContain('aaaaaaaaaaaa');
    expect(data.warnings?.join(' ')).toContain('spans 15 commit shas');
  });

  it('names the sha only when the group holds exactly one', async () => {
    const data = await run();
    expect(data.candidate).toMatchObject({ commitSha: 'aaaaaaaaaaaa', commitShaCount: 1, commitShaAmbiguous: false });
    expect(data.warnings).toEqual([]);
  });

  it('resolveJudgedSha refuses 0 and >1, permits exactly 1', () => {
    expect(resolveJudgedSha(1, 'abc')).toBe('abc');
    expect(resolveJudgedSha(15, 'abc')).toBeNull();
    // Every row in the group had a NULL sha — that is unknown, not "abc".
    expect(resolveJudgedSha(0, null)).toBeNull();

    // Control: the naive implementation this guard exists to prevent.
    const naive = (_count: number, oneSha: string | null) => oneSha;
    expect(naive(15, 'abc')).toBe('abc');
    expect(resolveJudgedSha(15, 'abc')).not.toBe(naive(15, 'abc'));
  });
});

describe('bucket wiring', () => {
  it('decomposes the candidate red into newly-failing vs inherited', async () => {
    const data = await run();
    expect(data.newlyFailing).toMatchObject({ count: 1, files: [{ filePath: 'a.test.ts' }] });
    expect(data.stillFailing).toMatchObject({ count: 1, files: [{ filePath: 'b.test.ts' }] });
    expect(data.newlyPassing?.count).toBe(0);
    expect(data.unchangedPassing).toBe(1);
    expect(data.totals).toMatchObject({ baselineRed: 1, candidateRed: 2 });
  });

  it('flags an asymmetric selection instead of letting presence buckets read as blast radius', async () => {
    verdictFixture = [
      verdict('run-old', 'a.test.ts', 'pass'),
      ...Array.from({ length: 30 }, (_, i) => verdict('run-new', `f${i}.test.ts`, 'pass')),
    ];
    const data = await run();
    expect(data.onlyInCandidate?.count).toBe(30);
    expect(data.newlyFailing?.count).toBe(0);
    expect(data.warnings?.join(' ')).toContain('asymmetric');
  });

  it('isAsymmetricSelection only fires on a real imbalance', () => {
    expect(isAsymmetricSelection(1, 30)).toBe(true);
    expect(isAsymmetricSelection(6636, 6650)).toBe(false);
    expect(isAsymmetricSelection(0, 0)).toBe(false);
  });
});

describe('P-003 — a capped list never reads as a total', () => {
  it('keeps bucket counts at the census while capping the listed files', async () => {
    verdictFixture = [
      ...Array.from({ length: 12 }, (_, i) => verdict('run-old', `f${i}.test.ts`, 'pass')),
      ...Array.from({ length: 12 }, (_, i) => verdict('run-new', `f${i}.test.ts`, 'fail')),
    ];
    const data = await run({ limit: 3 });

    expect(data.newlyFailing?.count).toBe(12); // the aggregate ignores `limit`
    expect(data.newlyFailing?.files).toHaveLength(3);
    expect(data.newlyFailing?.truncatedByLimit).toBe(true);
    expect(data.newlyFailing?.omitted).toBe(9);
    // An untruncated bucket must say so, so an empty one is a real zero.
    expect(data.newlyPassing).toMatchObject({ count: 0, truncatedByLimit: false, omitted: 0 });
  });
});

describe('refusals — never answer vacuously', () => {
  it('refuses when only one run group exists in the population', async () => {
    groupsFixture = [group('run-only', '1', 'aaaaaaaaaaaa')];
    const data = await run();
    expect(data).toMatchObject({ ok: false, error: 'insufficient_run_groups', found: 1 });
    expect(data.newlyFailing).toBeUndefined();
  });

  it('refuses a named group that has no rows under the population filter', async () => {
    groupsFixture = [group('run-new', '1', 'aaaaaaaaaaaa')];
    const data = await run({ candidate: 'run-new', baseline: 'run-missing' });
    // An empty side would render EVERY candidate file as onlyInCandidate and
    // read as an enormous blast radius.
    expect(data).toMatchObject({ ok: false, error: 'group_not_measured', role: 'baseline', runGroupId: 'run-missing' });
  });

  it('refuses to diff a group against itself', async () => {
    groupsFixture = [group('run-new', '1', 'aaaaaaaaaaaa')];
    const data = await run({ candidate: 'run-new', baseline: 'run-new' });
    expect(data).toMatchObject({ ok: false, error: 'insufficient_run_groups' });
  });
});
