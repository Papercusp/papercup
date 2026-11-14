/**
 * WI-6554700010048547 / WI-6554700010048618: saveTextArtifact keeps the canonical
 * copy in harness_shared.harness_text_artifacts and mirrors it to
 * `<harness>/.papercusp/<key>`. Tracking a mirror grows the repository on every
 * write (text-artifacts ~60MB/day; durable-park evidence matrices ~15 MiB per
 * daily fire), so the mirror prefixes must stay ignored. Hand-authored reports
 * beside them stay tracked.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function ignored(path: string): boolean {
  // --no-index answers from the ignore rules alone, independent of the index.
  const run = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repoRoot, encoding: 'utf8' });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore failed: ${run.stderr}`);
  return run.status === 0;
}

describe('text-artifact disk mirrors stay out of git', () => {
  it.each([
    '.papercusp/state/text-artifacts/plans/example.md',
    '.papercusp/reports/durable-parks/sched--routinesTick-2026-11-14T09-25-30-000Z-3-evidence-matrix.json',
    '.papercusp/reports/durable-parks/work-item-durable-park-audit-reconcile-tool-WI-1-abc-reconcile.json',
  ])('ignores the mirror path %s', (path) => {
    expect(ignored(path)).toBe(true);
  });

  it('keeps hand-authored reports tracked', () => {
    expect(ignored('.papercusp/reports/portal-design-iteration-2026-09-05/notes.md')).toBe(false);
  });
});
