import { beforeEach, describe, expect, it, vi } from 'vitest';

const listIssues = vi.fn();
const countIssues = vi.fn();
vi.mock('../issues-engineer', () => ({
  listIssues: (...args: unknown[]) => listIssues(...args),
  countIssues: (...args: unknown[]) => countIssues(...args),
}));
vi.mock('../harness/improvements/read-items', () => ({
  // P-006/D-031: the observation population is selected by the `lane` COLUMN. The
  // topic constant stays exported (capture still writes the tag as a LABEL), so it is
  // mocked too — but nothing in this resolver reads it any more.
  OBSERVATION_TOPIC: 'papercusp-observation',
  OBSERVATION_LANE: 'observation',
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { computeLearningObservations } from './learning-observations-read';
import { readListTotal } from './list-meta';
import { assertShapeMatchesRecordedVersion } from '../derived-reads/shape-fingerprint';

const issue = (id: string, createdAt: string) => ({
  id,
  title: `Observation ${id}`,
  body: `Body ${id}`,
  scope: 'operator',
  createdAt,
  payload: {
    sourceRole: 'worker',
    observation: { kind: 'friction', confidence: 'high', refs: ['plan:test'] },
  },
});

beforeEach(() => {
  listIssues
    .mockReset()
    .mockResolvedValue([issue('EI-2', '2026-07-11T12:00:00.000Z'), issue('EI-1', '2026-07-10T12:00:00.000Z')]);
  countIssues.mockReset().mockResolvedValue(725);
});

describe('learning.observations — Work Queue pagination contract', () => {
  // Since phase2 P-005 the compute lives in the shared computeLearningObservations
  // (the default view is served from a precomputed snapshot; see
  // learning-observations-queries.test.ts for the resolver gate). Pin the
  // total/sort/args contract against that function directly.
  it('is registered', () => {
    expect(knownQueryNamesV2()).toContain('learning.observations');
  });

  it('carries the authoritative store total on the flat row list, newest-first', async () => {
    const rows = await computeLearningObservations({ limit: 200 });

    // D-003/P-004 (observation-lane-scorecard-classification-2026-08-16): the pane is a
    // RAW-observation feed — rubric-graded scorecards are excluded in SQL, and the
    // count carries the SAME predicate so the total can never disagree with the list.
    expect(listIssues).toHaveBeenCalledWith({ lane: 'observation', excludeRubricGraded: true, limit: 200 });
    expect(countIssues).toHaveBeenCalledWith({ lane: 'observation', excludeRubricGraded: true });
    expect(readListTotal(rows as unknown as Array<Record<string, unknown>>)).toBe(725);
    expect((rows as Array<{ id: string }>).map((row) => row.id)).toEqual(['EI-2', 'EI-1']);
  });

  // ── WI-7303: the wire shape ──
  //
  // Both halves are pinned here, plus the COLUMN COUNT — without the count a
  // re-added always-null column reads as "fine" (the whole 9,600 B this fixed).

  it('omits null-valued keys rather than sending "k":null (D-025)', async () => {
    // The measured live shape: no observation.kind/confidence/scope, no
    // sourceRole, no filedByRole — 9,600 B of literal nulls on 200 rows.
    listIssues.mockResolvedValue([
      { id: 'EI-1', title: 'T', body: null, scope: null, createdAt: '2026-08-03T00:00:00.000Z', payload: {} },
    ]);
    const [row] = (await computeLearningObservations({})) as unknown as Array<Record<string, unknown>>;

    // Assert KEY ABSENCE, not toBeNull() — `toBeNull()` passes on `"k":null`,
    // which is exactly the bytes this removes.
    for (const k of ['body', 'kind', 'scope', 'confidence', 'sourceRole']) {
      expect(Object.prototype.hasOwnProperty.call(row, k), `${k} must be absent, not null`).toBe(false);
    }
    // The required keys survive (+ _meta, which row[0] always carries).
    expect(Object.keys(row).sort()).toEqual(['_meta', 'createdAt', 'id', 'refs', 'title']);
  });

  it('resolves sourceRole from payload.filedByRole when payload.sourceRole is absent (WI-7303)', async () => {
    // The dominant observation filer is turn-end reflection via
    // checkpoint-harvest.ts, which stamps filedByRole and never sourceRole —
    // measured 0 of the newest 200 rows carrying sourceRole, 200/200 filedByRole.
    listIssues.mockResolvedValue([
      {
        id: 'EI-1',
        title: 'T',
        body: 'B',
        scope: 'harness:papercusp',
        createdAt: '2026-08-03T00:00:00.000Z',
        payload: { filedByRole: 'su' },
      },
    ]);
    const [row] = (await computeLearningObservations({})) as unknown as Array<{ sourceRole?: string }>;
    expect(row.sourceRole).toBe('su');
  });

  it('payload.sourceRole still WINS over filedByRole when both are present (negative control)', async () => {
    listIssues.mockResolvedValue([
      {
        id: 'EI-1',
        title: 'T',
        body: 'B',
        scope: 'harness:papercusp',
        createdAt: '2026-08-03T00:00:00.000Z',
        payload: { sourceRole: 'worker', filedByRole: 'su' },
      },
    ]);
    const [row] = (await computeLearningObservations({})) as unknown as Array<{ sourceRole?: string }>;
    expect(row.sourceRole).toBe('worker');
  });

  it('a fully-populated row carries EXACTLY the 9 read-set columns — no more', async () => {
    // Pin the count so a column added to the payload cannot silently re-inflate
    // this read. Uses row[1] so `_meta` (row[0] only) is out of the way.
    const full = (id: string) => ({
      id,
      title: 'T',
      body: 'B',
      scope: 'operator',
      createdAt: '2026-08-03T00:00:00.000Z',
      payload: {
        sourceRole: 'worker',
        filedByRole: 'su',
        observation: { kind: 'friction', confidence: 'high', scope: 'harness:papercusp', refs: ['plan:test'] },
      },
    });
    listIssues.mockResolvedValue([full('EI-2'), full('EI-1')]);
    const rows = (await computeLearningObservations({})) as unknown as Array<Record<string, unknown>>;
    expect(Object.keys(rows[1]).sort()).toEqual([
      'body',
      'confidence',
      'createdAt',
      'id',
      'kind',
      'refs',
      'scope',
      'sourceRole',
      'title',
    ]);
  });

  it('clamps an over-large window instead of rejecting the query (non-default → inline)', async () => {
    // A state filter makes this a NON-default view → the resolver takes the live
    // inline path AND applies the argsSchema clamp (50000 → 2000) before compute.
    await resolveNamedQueryV2('learning.observations', { state: 'open', limit: 50_000 });
    expect(listIssues).toHaveBeenCalledWith({
      lane: 'observation',
      excludeRubricGraded: true,
      state: 'open',
      limit: 2000,
    });
    expect(countIssues).toHaveBeenCalledWith({ lane: 'observation', excludeRubricGraded: true, state: 'open' });
  });

  // ── WI-7289 shape guard ──────────────────────────────────────────────────
  //
  // The column-count pin above (WI-7303) protects the read-set from silent
  // drift, but nothing tied it to the `learning.observations` derived-read
  // producer's registered `producerVersion` in producers.ts — the exact gap
  // that shipped this fix inert once already. This ties them: fingerprint a
  // REAL row set (through computeLearningObservations's actual mapper, not a
  // stand-in) and require it to match the shape recorded for the producer's
  // LIVE registered version — see shape-fingerprint.ts's module doc.
  it('shape-guard: the real observation-row shape matches the shape recorded for its LIVE registered producerVersion (WI-7289)', async () => {
    const full = (id: string) => ({
      id,
      title: 'T',
      body: 'B',
      scope: 'operator',
      createdAt: '2026-08-03T00:00:00.000Z',
      payload: {
        sourceRole: 'worker',
        filedByRole: 'su',
        observation: { kind: 'friction', confidence: 'high', scope: 'harness:papercusp', refs: ['plan:test'] },
      },
    });
    listIssues.mockResolvedValue([full('EI-2'), full('EI-1')]);
    const rows = await computeLearningObservations({});

    const registry = await import('../derived-reads/registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('../derived-reads/producers');
    const producer = registry.listDerivedReadProducers().find((p) => p.key === 'learning.observations');
    if (!producer) throw new Error('learning.observations producer not registered');

    assertShapeMatchesRecordedVersion({
      key: 'learning.observations',
      producerVersion: producer.producerVersion,
      sample: rows,
      expectedByVersion: {
        // Captured from a real computeLearningObservations() call against the
        // `full()` fixture above (not hand-typed) — regenerate after a
        // DELIBERATE shape change, per shape-fingerprint.ts's module doc.
        2: 'arr<obj{_meta:obj{total:number},body:string,confidence:string,createdAt:string,id:string,kind:string,refs:arr<string>,scope:string,sourceRole:string,title:string}|obj{body:string,confidence:string,createdAt:string,id:string,kind:string,refs:arr<string>,scope:string,sourceRole:string,title:string}>',
      },
    });
  });
});
