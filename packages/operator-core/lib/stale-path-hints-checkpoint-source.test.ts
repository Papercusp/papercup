/**
 * EI-19464910043764424 — a checkpoint can cite files that no longer exist, and nothing
 * flagged it. The measured case: a 22.7-day-old checkpoint read as a verified done-list
 * ending in "Then: complete WI-4243", and cited `build-windows-on-vm.sh`, which had been
 * deleted 8 days AFTER the checkpoint was written. Both failure directions were live —
 * close on its word and ship a dropped fix, or distrust it and redo 22 days of work.
 *
 * The port already resolved prose-cited dead paths; it simply never SAW checkpoint text.
 * These tests pin the input, the source split, and — the part that is easy to get wrong —
 * the two DIFFERENT reasons for silence.
 */

import { describe, expect, it } from 'vitest';
import {
  getStalePathRefsBySourceForSubjects,
  staleCheckpointPathsNote,
} from './stale-path-hints-claim-port';

// A path that exists (this very file's neighbour) and one that certainly does not.
const LIVE = 'packages/operator-core/lib/stale-path-hints-claim-port.ts';
const DEAD = 'packages/operator-core/lib/no-such-file-EI-19464910043764424.ts';

describe('checkpoint-cited paths reach the stale-path port', () => {
  it('reports a dead path cited ONLY in the checkpoint body', async () => {
    const bySource = await getStalePathRefsBySourceForSubjects([
      { id: 'a', title: 'unrelated', summary: 'unrelated', checkpoint: `next: patch ${DEAD}` },
    ]);
    expect(bySource.a.checkpoint).toContain(DEAD);
    // Attribution matters: the warning's whole value is naming the CHECKPOINT as the
    // source, so a checkpoint-cited path must not be laundered into the prose bucket.
    expect(bySource.a.prose).toEqual([]);
  });

  it('does not double-report a path cited in BOTH prose and checkpoint', async () => {
    const bySource = await getStalePathRefsBySourceForSubjects([
      { id: 'a', summary: `see ${DEAD}`, checkpoint: `still working on ${DEAD}` },
    ]);
    expect(bySource.a.prose).toContain(DEAD);
    expect(bySource.a.checkpoint).not.toContain(DEAD);
  });

  it('stays silent when the checkpoint cites paths that all resolve', async () => {
    const bySource = await getStalePathRefsBySourceForSubjects([
      { id: 'a', checkpoint: `edited ${LIVE}` },
    ]);
    expect(bySource.a.checkpoint).toEqual([]);
    expect(bySource.a.checkpointCitedTotal).toBe(1);
    expect(staleCheckpointPathsNote(bySource.a)).toBeNull();
  });

  it('stays silent when the checkpoint cites NO paths at all', async () => {
    // The filing called this out explicitly: a checkpoint naming no files must never
    // grow a spurious warning. Note this is a DIFFERENT silence from the case above —
    // citedTotal 0 vs 1 — which is why the count is tracked rather than inferred.
    const bySource = await getStalePathRefsBySourceForSubjects([
      { id: 'a', checkpoint: 'talked to the owner, waiting on a decision' },
    ]);
    expect(bySource.a.checkpointCitedTotal).toBe(0);
    expect(staleCheckpointPathsNote(bySource.a)).toBeNull();
  });

  it('leaves the legacy title/summary behaviour untouched when no checkpoint is passed', async () => {
    const bySource = await getStalePathRefsBySourceForSubjects([{ id: 'a', summary: `see ${DEAD}` }]);
    expect(bySource.a.prose).toContain(DEAD);
    expect(bySource.a.checkpoint).toEqual([]);
    expect(bySource.a.checkpointCitedTotal).toBe(0);
  });
});

describe('staleCheckpointPathsNote', () => {
  it('renders N of M and names the offending path', () => {
    const note = staleCheckpointPathsNote({
      prose: [],
      checkpoint: [DEAD],
      checkpointCitedTotal: 3,
    });
    expect(note).toContain('1 of 3');
    expect(note).toContain(DEAD);
    expect(note).toContain('CHECKPOINT');
  });

  it('frames the finding as a question, not a verdict that the work was dropped', () => {
    // The measured case ended well: the file was RENAMED and the fix had been carried
    // forward. A warning that reads as "this work was lost" would have sent that reader
    // to redo 22 days of committed work — the exact second failure direction the filing
    // named. Both readings must stay open in the wording.
    const note = staleCheckpointPathsNote({ prose: [], checkpoint: [DEAD], checkpointCitedTotal: 1 })!;
    expect(note).toMatch(/what replaced/i);
    expect(note).toMatch(/renamed/i);
  });

  it('returns null for an empty/absent split rather than an empty warning', () => {
    expect(staleCheckpointPathsNote(null)).toBeNull();
    expect(
      staleCheckpointPathsNote({ prose: [DEAD], checkpoint: [], checkpointCitedTotal: 0 }),
    ).toBeNull();
  });
});
