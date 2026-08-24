/**
 * publish-goal-core — the serializer's live-state strip, the injected reader
 * seam, and the expected refusals (work-on-everything-goal-2026-08-23 P-006).
 *
 * The dir write is MOCKED (captured, not performed): the strip semantics live
 * in the EXPORT OBJECT handed to writeGoalPackageDir, and asserting on that
 * object keeps this test off the real user layer (~/.papercusp/goal-packages),
 * which a unit test must never touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalRowForExport } from './publish-goal-core';

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
}));

vi.mock('./goal-package-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeGoalPackageDir: mocks.write,
}));

import { publishGoalToCupboard } from './publish-goal-core';
import type { GoalPackageExport } from './goal-package-store';

const ROW: GoalRowForExport = {
  id: 'keep-green-3f9a1c',
  title: 'Keep the tree green',
  body: 'First duty line\nand the rest of the brief.',
  standing: true,
  killCriterion: 'The owner retires the duty',
  tripwires: [
    { metric: 'spend_usd', label: 'Spend', threshold: 500, current: 123, unit: 'usd' },
    { metric: 'days_red', label: 'Red days', threshold: 2 },
  ],
  budgetCents: 50_000,
  budgetWindowSec: 604_800,
  launchSettings: { maxAgents: 2 },
  inputSchema: { type: 'object' },
  outputSchema: null,
  propertySchema: null,
};

const reader = async (id: string) => (id === ROW.id ? ROW : null);

beforeEach(() => {
  mocks.write.mockReset();
  mocks.write.mockReturnValue({
    ref: 'keep-the-tree-green',
    dir: '/fake/keep-the-tree-green',
    manifestPath: '/fake/keep-the-tree-green/goal.json',
    listingPath: '/fake/keep-the-tree-green/listing.json',
  });
});

describe('publishGoalToCupboard (exportOnly)', () => {
  it('serializes the shape and STRIPS live state, reporting the strip', async () => {
    const result = await publishGoalToCupboard({ goalId: ROW.id, exportOnly: true }, reader);
    expect(result.ok).toBe(true);
    if (!result.ok || !('exportedOnly' in result) || result.exportedOnly !== true) throw new Error('expected exportedOnly');

    // One tripwire carried a `current` reading; the export reports it stripped.
    expect(result.export.stripped.tripwireCurrentReadings).toBe(1);
    expect(result.export.stripped.liveStateOmitted).toContain('status');
    expect(result.export.standing).toBe(true);

    // The object handed to the dir writer carries defaults only.
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const exported = mocks.write.mock.calls[0]![0] as GoalPackageExport;
    expect(exported.tripwires).toEqual([
      { metric: 'spend_usd', label: 'Spend', threshold: 500, unit: 'usd' },
      { metric: 'days_red', label: 'Red days', threshold: 2 },
    ]);
    for (const t of exported.tripwires ?? []) expect(t).not.toHaveProperty('current');
    expect(exported).toMatchObject({
      title: ROW.title,
      body: ROW.body,
      standing: true,
      killCriterion: ROW.killCriterion,
      budgetCents: 50_000,
      budgetWindowSec: 604_800,
      launchSettings: { maxAgents: 2 },
      inputSchema: { type: 'object' },
      outputSchema: null,
      propertySchema: null,
    });
    // No live-state keys exist on the export shape at all.
    expect(exported).not.toHaveProperty('status');
    expect(exported).not.toHaveProperty('inputs');
    expect(exported).not.toHaveProperty('metadata');
  });

  it('defaults the description to the duty body\'s first line and the ref to the slugified title', async () => {
    const result = await publishGoalToCupboard({ goalId: ROW.id, exportOnly: true }, reader);
    if (!result.ok) throw new Error('expected ok');
    expect(result.export.description).toBe('First duty line');
    const opts = mocks.write.mock.calls[0]![1] as { ref: string };
    expect(opts.ref).toBe('keep-the-tree-green');
  });

  it('honours title/description/listing_ref/requires_rubrics overrides', async () => {
    const result = await publishGoalToCupboard(
      {
        goalId: ROW.id,
        exportOnly: true,
        title: 'Custom Title',
        description: 'Custom description',
        listing_ref: 'custom-ref',
        requires_rubrics: [{ rubricRef: 'goal-mode-e2e' }],
      },
      reader,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.export.title).toBe('Custom Title');
    expect(result.export.description).toBe('Custom description');
    expect(result.export.requiresRubrics).toEqual([{ rubricRef: 'goal-mode-e2e' }]);
    const opts = mocks.write.mock.calls[0]![1] as { ref: string };
    expect(opts.ref).toBe('custom-ref');
  });
});

describe('publishGoalToCupboard refusals', () => {
  it('404s an unknown goal id', async () => {
    const result = await publishGoalToCupboard({ goalId: 'nope', exportOnly: true }, reader);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('400s a missing goalId', async () => {
    const result = await publishGoalToCupboard({ goalId: '   ', exportOnly: true }, reader);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('400s an unsafe listing_ref', async () => {
    const result = await publishGoalToCupboard(
      { goalId: ROW.id, exportOnly: true, listing_ref: '../evil' },
      reader,
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('requires github_url when not exportOnly (after materializing the dir)', async () => {
    const result = await publishGoalToCupboard({ goalId: ROW.id }, reader);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(String((result as { error: string }).error)).toMatch(/github_url/);
  });
});
