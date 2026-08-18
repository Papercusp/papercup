/**
 * `learning.improvements` must FALL THROUGH to the live compute when its
 * precomputed snapshot is missing — never serve an empty digest (WI-39773).
 *
 * ── The defect this pins, which was OBSERVED, not imagined ───────────────────
 * The resolver's DEFAULT branch read the snapshot through `readDerivedSnapshotRows`,
 * which flattens a MISS and a genuinely-empty payload both to `[]`. So any cold or
 * superseded key made the Learning tab's LANDING view render as "nothing here"
 * rather than as slow — a wrong answer wearing an empty answer's clothes.
 *
 * It fired for real on 2026-08-18: bumping the producer to v4 for the tierReason
 * interning (D-008) invalidated every stored v3 row, and :3170 served an empty
 * digest until the producer next ran (~2 min). It recurs on EVERY future
 * producerVersion bump and on any cold key, so it is a class, not an incident.
 *
 * The sibling hive branch already did this correctly and said why in a comment;
 * the default branch simply never inherited it. These tests hold both halves.
 *
 * This lives in its own file because it must mock `../derived-reads/registry`,
 * which the main learning-improvements suite uses for real (its shape-guard reads
 * the live producer registry).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const readDerivedSnapshot = vi.fn();
const computeLearningImprovementsSnapshot = vi.fn();

vi.mock('../derived-reads/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDerivedSnapshot,
}));
vi.mock('../derived-reads/producers', () => ({}));
vi.mock('../harness/improvements/learning-digest-snapshot', () => ({
  computeLearningImprovementsSnapshot,
}));
// Fire-and-forget exposure recording — stubbed so the test never reaches PG.
vi.mock('../owner-preference/interactions', () => ({ recordQueueExposure: vi.fn() }));

const LIVE_ROW = { humanQueue: [{ id: 'EI-live' }], total: 7, tierReasonLegend: ['because'] };
const SNAPSHOT_ROW = { humanQueue: [{ id: 'EI-snapshot' }], total: 3, tierReasonLegend: ['stored'] };

beforeEach(() => {
  readDerivedSnapshot.mockReset();
  computeLearningImprovementsSnapshot.mockReset().mockResolvedValue([LIVE_ROW]);
});

describe('learning.improvements — snapshot MISS must not serve an empty digest (WI-39773)', () => {
  it('falls through to the live compute when the snapshot is missing', async () => {
    readDerivedSnapshot.mockResolvedValue({ payload: null, meta: { missing: true } });
    const { resolveNamedQueryV2 } = await import('./index');

    const rows = (await resolveNamedQueryV2('learning.improvements', {})) as Array<
      Record<string, unknown>
    >;

    // THE ASSERTION THAT BITES: not merely "defined" — an empty array is defined,
    // and `[]` is exactly what the regression returns. Pin that the LIVE row came
    // back, which only a real fall-through can produce.
    expect(computeLearningImprovementsSnapshot).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(7);
    expect(rows).not.toEqual([]);
  });

  it('falls through when the stored payload is not an array (a superseded shape)', async () => {
    // A producerVersion bump is the common cause, but a corrupt/legacy payload
    // reaches the same branch and must not degrade to empty either.
    readDerivedSnapshot.mockResolvedValue({ payload: { notAnArray: true }, meta: { missing: false } });
    const { resolveNamedQueryV2 } = await import('./index');

    const rows = (await resolveNamedQueryV2('learning.improvements', {})) as Array<
      Record<string, unknown>
    >;

    expect(computeLearningImprovementsSnapshot).toHaveBeenCalledTimes(1);
    expect(rows[0].total).toBe(7);
  });

  it('serves the snapshot (and does NOT compute) on a hit, and stamps _meta.derivedRead', async () => {
    // The control. Without it the two tests above would also pass on a resolver
    // that had simply stopped using the snapshot at all — which would silently
    // reintroduce the 0.4-0.5s inline compute on every mount that the precompute
    // substrate exists to remove.
    const meta = { missing: false, computedAt: '2026-08-18T09:00:00.000Z' };
    readDerivedSnapshot.mockResolvedValue({ payload: [{ ...SNAPSHOT_ROW }], meta });
    const { resolveNamedQueryV2 } = await import('./index');

    const rows = (await resolveNamedQueryV2('learning.improvements', {})) as Array<
      Record<string, unknown>
    >;

    expect(computeLearningImprovementsSnapshot).not.toHaveBeenCalled();
    expect(rows[0].total).toBe(3);
    // The panel renders "as of HH:MM" from this; the readDerivedSnapshotRows helper
    // used to stamp it, so re-implementing the read had to carry it over.
    expect(rows[0]._meta).toMatchObject({ derivedRead: meta });
  });
});
