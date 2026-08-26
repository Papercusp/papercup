/**
 * The grader-liveness I/O seam — the surface the sweep's correctness rests on and
 * the one its 75 green tests could not see.
 * plan: acceptance-grading-stall-sweep-2026-08-26 · EI-21555395534019608
 *
 * The decision core was already covered thoroughly; the ADAPTER was pinned only by
 * source text. A wrong-field read therefore passed every suite while making the probe
 * blind on every row in production. These tests call the seam directly, so that class
 * of defect fails here instead of degrading silently for weeks.
 */
import { describe, expect, it } from 'vitest';
import {
  GRADER_TASK_SCAN_LIMIT,
  graderTaskLabel,
  observeAcceptanceGrader,
  type GraderTaskFilter,
  type GraderTaskLike,
} from './acceptance-grading-sweep-observe';

/** Shaped exactly like the real `acceptanceGraderLabelPrefix` output, `_` included —
 *  that character is a LIKE wildcard, which is why the pushdown uses starts_with. */
const RUBRIC = 'acceptance-my_plan.v2-2026-08-26';
const PREFIX = `acceptance-grader:${RUBRIC}:`;
const labelPrefix = (rubricRef: string) => `acceptance-grader:${rubricRef}:`;

/** A ledger row as `toRow` actually produces one: the label lives in `detail`. */
const task = (over: Partial<GraderTaskLike> & { label?: string } = {}): GraderTaskLike => {
  const { label, ...rest } = over;
  return {
    detail: label === undefined ? {} : { label, headless: true },
    startedAt: '2026-08-26T22:00:00.000Z',
    endedAt: null,
    ...rest,
  };
};

function recordingLister(rows: readonly GraderTaskLike[]) {
  const filters: GraderTaskFilter[] = [];
  const list = async (filter: GraderTaskFilter) => {
    filters.push(filter);
    return rows;
  };
  return { list, filters };
}

describe('graderTaskLabel reads the ONE place a label is stored', () => {
  it('reads detail.label — the field scorecards:emit reaps by', () => {
    expect(graderTaskLabel(task({ label: `${PREFIX}abc123` }))).toBe(`${PREFIX}abc123`);
  });

  it('REGRESSION: a TOP-LEVEL `label` is not a label — task_ledger has no such column', () => {
    // The original defect. `toRow` maps no `label`, so the old top-level read was
    // undefined on every row and the prefix match was false on every row. If someone
    // ever "simplifies" this back to `task.label`, this is the test that fails.
    const topLevelOnly = { label: `${PREFIX}abc123`, detail: {} } as unknown as GraderTaskLike;
    expect(graderTaskLabel(topLevelOnly)).toBe('');
  });

  it('CALIBRATION: the pre-fix read really does come up empty on these exact fixtures', () => {
    // Falsifiability, proven rather than asserted. A regression test is only worth its
    // line count if the bug it names would actually trip it, and for an imported
    // module the way to show that is to keep the wrong implementation here as a
    // control. This is the read the adapter used to perform, verbatim.
    const preFixRead = (t: unknown) => String((t as { label?: unknown }).label ?? '');
    const row = task({ label: `${PREFIX}e5bbe9989f15` });

    expect(preFixRead(row)).toBe(''); // ← blind on every row, which is what shipped
    expect(graderTaskLabel(row)).toBe(`${PREFIX}e5bbe9989f15`);
    // And so the prefix match — the thing the probe actually branches on — inverts.
    expect(preFixRead(row).startsWith(PREFIX)).toBe(false);
    expect(graderTaskLabel(row).startsWith(PREFIX)).toBe(true);
  });

  it('survives a detail bag that arrived undecoded or absent', () => {
    expect(graderTaskLabel({ detail: undefined })).toBe('');
    expect(graderTaskLabel({ detail: '{"label":"x"}' })).toBe('');
    expect(graderTaskLabel({ detail: { label: 42 } })).toBe('');
  });
});

describe('observeAcceptanceGrader — the observation the cooling window depends on', () => {
  it('REGRESSION: finds a live grader by its detail.label', async () => {
    // Against the pre-fix implementation this returned { live: false, lastDispatchMs: null }
    // for this exact input — which is what lost the cooling window every tick.
    const { list } = recordingLister([task({ label: `${PREFIX}e5bbe9989f15` })]);
    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: true,
      lastDispatchMs: Date.parse('2026-08-26T22:00:00.000Z'),
    });
  });

  it('pushes the prefix DOWN into the query rather than filtering after a capped list', async () => {
    // The filed defect: post-filtering a capped window silently misses matching rows
    // that fell outside it. Pinning the filter is what keeps the fix from regressing
    // into a raised limit that only moves the cliff.
    const { list, filters } = recordingLister([]);
    await observeAcceptanceGrader({ rubricRef: RUBRIC, workspaceId: 'ws-1' }, { listTasks: list, labelPrefix });

    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      labelPrefix: PREFIX,
      workspaceId: 'ws-1',
      includeEnded: true,
      limit: GRADER_TASK_SCAN_LIMIT,
    });
  });

  it('counts only un-ended tasks as live, but dates the last dispatch from ended ones too', async () => {
    // "When did we last try" is what governs re-dispatch cooling, so an ended grader
    // still has to date it — otherwise every tick re-dispatches.
    const { list } = recordingLister([
      task({ label: `${PREFIX}old`, startedAt: '2026-08-26T20:00:00.000Z', endedAt: '2026-08-26T20:30:00.000Z' }),
      task({ label: `${PREFIX}new`, startedAt: '2026-08-26T22:07:31.088Z', endedAt: '2026-08-26T22:13:17.864Z' }),
    ]);

    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: false,
      lastDispatchMs: Date.parse('2026-08-26T22:07:31.088Z'),
    });
  });

  it('never reports a STRANGER as this plan re-checked locally, even if the pushdown is lost', async () => {
    // The asymmetry the double-filter exists for. Under-matching costs one idempotent
    // re-dispatch; over-matching claims another plan's grader is this one's and the
    // stall never heals. This lister ignores labelPrefix, simulating exactly that
    // regression, and the local re-check must still refuse the row.
    const { list } = recordingLister([task({ label: 'acceptance-grader:acceptance-some-other-plan-2026-08-01:zz' })]);
    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: false,
      lastDispatchMs: null,
    });
  });

  it('a task with no label at all is not this plan grader', async () => {
    const { list } = recordingLister([task(), task({ label: '' })]);
    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: false,
      lastDispatchMs: null,
    });
  });

  it('without a rubricRef it does not query at all', async () => {
    const { list, filters } = recordingLister([task({ label: `${PREFIX}x` })]);
    await expect(observeAcceptanceGrader({ rubricRef: null }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: false,
      lastDispatchMs: null,
    });
    expect(filters).toHaveLength(0);
  });

  it('a failed listing degrades toward re-dispatch, never toward declaring a dead grader alive', async () => {
    const list = async () => {
      throw new Error('ledger unavailable');
    };
    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: false,
      lastDispatchMs: null,
    });
  });

  it('an unparseable startedAt is skipped rather than poisoning the max', async () => {
    const { list } = recordingLister([
      task({ label: `${PREFIX}bad`, startedAt: 'not-a-date' }),
      task({ label: `${PREFIX}good`, startedAt: '2026-08-26T21:00:00.000Z' }),
    ]);
    await expect(observeAcceptanceGrader({ rubricRef: RUBRIC }, { listTasks: list, labelPrefix })).resolves.toEqual({
      live: true,
      lastDispatchMs: Date.parse('2026-08-26T21:00:00.000Z'),
    });
  });
});
