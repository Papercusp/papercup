/**
 * corpus-digest-flow-recurrence.test.ts — the friction lane counts FLOW, not just STOCK
 * (EI-20587312505064997).
 *
 * Two independent defects made observation recurrence inert, and fixing either alone
 * leaves the lane nearly as blind as before — so both are pinned here:
 *
 *  1. STOCK COUNTING. Dedup collapses a repeat onto its canonical row and appends to
 *     `work_item_occurrences`, so a friction reported 79× is ONE work_items row.
 *     `findLikelyDuplicates` only ever emits clusters of ≥2 rows, so such a friction is
 *     never emitted as a cluster at all. (Scoring/surfacing is pinned in
 *     corpus-digest.test.ts; this file pins the DEPS wiring that feeds it.)
 *
 *  2. THE RECENCY WINDOW. `friction()` reads `limit ?? 500` — the newest 500 of each
 *     lane. A row accrues repeats over TIME, so it ages out of the newest-N before it
 *     becomes interesting. Measured on the live box 2026-09-06: inside that window the
 *     largest flow is 4, while the corpus holds 618 canonicals at ≥3 and one at 364.
 *     Without the ledger-keyed read below, flow-counting is nearly a no-op in
 *     production — which is exactly the shape of fix that looks shipped and is not.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scout/corpus-digest-flow-recurrence.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: string[] = [];
let recurringIdRows: { id: string }[] = [];
let occurrenceRows: { id: string; n: string }[] = [];
let ledgerThrows = false;

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        sqlCalls.push(text);
        if (ledgerThrows) return Promise.reject(new Error('ledger unavailable'));
        // The two ledger reads are told apart by their projection: the id-only
        // "which rows recur" read vs the "how many times" count read.
        if (text.includes('count(*)::text')) return Promise.resolve(occurrenceRows);
        return Promise.resolve(recurringIdRows);
      },
      { begin: vi.fn() },
    ),
  }),
}));

vi.mock('../harness/improvements/read-items', async (orig) => ({
  ...(await orig<typeof import('../harness/improvements/read-items')>()),
  readImprovementItems: vi.fn(),
  readObservationItems: vi.fn(),
}));
vi.mock('../rubrics', async (orig) => ({
  ...(await orig<typeof import('../rubrics')>()),
  listRubrics: vi.fn(async () => []),
}));

import { readImprovementItems, readObservationItems } from '../harness/improvements/read-items';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { buildStateOfHiveReaders } from './corpus-digest-deps';

const improvementsM = vi.mocked(readImprovementItems);
const observationsM = vi.mocked(readObservationItems);

const row = (id: string, title = `friction ${id}`): ImprovementCandidate =>
  ({ id, kind: 'bug', scope: 'operator', title, state: 'open', updatedAt: '2026-09-01T00:00:00.000Z' }) as ImprovementCandidate;

beforeEach(() => {
  sqlCalls.length = 0;
  recurringIdRows = [];
  occurrenceRows = [];
  ledgerThrows = false;
  improvementsM.mockReset();
  observationsM.mockReset();
});

describe('corpus-digest-deps — flow recurrence (EI-20587312505064997)', () => {
  it('mines ledger-recurring rows that fell OUTSIDE the newest-500 recency window', async () => {
    recurringIdRows = [{ id: 'EI-OLD' }];
    // The recency window (no issueIds) sees only the fresh row; the by-id read reaches
    // the old, repeatedly-reported one that the window can never show.
    improvementsM.mockImplementation(async (opts) => (opts?.issueIds ? [row('EI-OLD')] : [row('EI-FRESH')]));
    observationsM.mockResolvedValue([]);

    const friction = await buildStateOfHiveReaders({ workspaceId: 'ws-test' }).friction();

    expect(friction.map((c) => c.id).sort()).toEqual(['EI-FRESH', 'EI-OLD']);
  });

  it('requests the recurring rows BY ID, with a limit that cannot re-truncate them', async () => {
    // Regression guard: forwarding the id set while leaving `limit` at its 500 default
    // would silently re-impose the very window this read exists to escape.
    recurringIdRows = [{ id: 'EI-A' }, { id: 'EI-B' }];
    improvementsM.mockResolvedValue([]);
    observationsM.mockResolvedValue([]);

    await buildStateOfHiveReaders({ workspaceId: 'ws-test' }).friction();

    const byId = improvementsM.mock.calls.map(([o]) => o).find((o) => o?.issueIds);
    expect(byId?.issueIds).toEqual(['EI-A', 'EI-B']);
    expect(byId?.limit).toBe(2);
  });

  it('dedupes a recurring row that is ALSO inside the window, so it cannot double its own stock count', async () => {
    recurringIdRows = [{ id: 'EI-DUP' }];
    improvementsM.mockResolvedValue([row('EI-DUP')]); // returned by BOTH reads
    observationsM.mockResolvedValue([]);

    const friction = await buildStateOfHiveReaders({ workspaceId: 'ws-test' }).friction();

    expect(friction.filter((c) => c.id === 'EI-DUP')).toHaveLength(1);
  });

  it('degrades to the recency window when the ledger read fails — never loses the lane', async () => {
    ledgerThrows = true;
    improvementsM.mockImplementation(async (opts) => (opts?.issueIds ? [] : [row('EI-FRESH')]));
    observationsM.mockResolvedValue([]);

    const friction = await buildStateOfHiveReaders({ workspaceId: 'ws-test' }).friction();

    expect(friction.map((c) => c.id)).toEqual(['EI-FRESH']);
  });

  it('occurrences() maps ledger counts by id, and asks nothing of an empty id set', async () => {
    occurrenceRows = [
      { id: 'EI-A', n: '79' },
      { id: 'EI-B', n: '3' },
    ];
    const readers = buildStateOfHiveReaders({ workspaceId: 'ws-test' });

    const counts = await readers.occurrences!(['EI-A', 'EI-B']);
    expect(counts.get('EI-A')).toBe(79);
    expect(counts.get('EI-B')).toBe(3);
    // An id the ledger has never seen is ABSENT, not zero — the consumer floors a
    // missing id at one report, and a stored 0 would rank a real row below that floor.
    expect(counts.get('EI-NONE')).toBeUndefined();

    sqlCalls.length = 0;
    expect((await readers.occurrences!([])).size).toBe(0);
    expect(sqlCalls).toEqual([]);
  });

  it('drops an unparseable ledger count rather than letting NaN poison the ranking', async () => {
    occurrenceRows = [
      { id: 'EI-A', n: 'not-a-number' },
      { id: 'EI-B', n: '5' },
    ];
    const counts = await buildStateOfHiveReaders({ workspaceId: 'ws-test' }).occurrences!(['EI-A', 'EI-B']);
    expect(counts.has('EI-A')).toBe(false);
    expect(counts.get('EI-B')).toBe(5);
  });
});
