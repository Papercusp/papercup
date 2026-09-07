import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { sinkDreamInsight, type DreamSinkDeps, type SinkCapabilityDreamInput } from './dream-sink';
import { capabilityReviewEvidenceHash } from './capability-review';
import { dreamCapabilityRun } from './dream-run-provenance';
import type { DreamRun } from './dream-run-store';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const f = await createDreamCapabilityFixture(); roots.push(f.root);
  const artifacts = new Map<string, { id: string; candidateHash: string; evidenceHash: string }>();
  const routed = new Map<string, unknown>();
  const capture = vi.fn(async (input) => {
    const dream = input.payloadExtra.dream;
    const value = { id: 'EI-CAPTURED', candidateHash: dream.candidateHash, evidenceHash: dream.evidenceHash };
    artifacts.set(input.watchdogKey, value);
    return { ok: true as const, created: true, possibleDuplicates: [], issue: value };
  });
  const recordRoutedIdea = vi.fn(async (value) => { routed.set(value.ideaId, value); });
  const deps: DreamSinkDeps = {
    capture: capture as DreamSinkDeps['capture'], recordRoutedIdea, now: () => 1788790200000,
    withRunLock: async <T>(_sql: Sql, _input: unknown, action: (sql: Sql, run: DreamRun) => Promise<T>) => action({} as Sql, f.run),
    findCaptured: async (_sql, run) => artifacts.get('dream:' + run.runId) ?? null,
    saveRouted: async (_sql, run, ref) => { run.routedRef = ref; },
  };
  const input: SinkCapabilityDreamInput = { kind: 'capability', sql: {} as Sql, workspaceId: f.scope.workspaceId, dreamRunId: f.run.runId, rootPath: f.root, manifest: f.manifest, sources: f.sources };
  return { ...f, input, deps, capture, recordRoutedIdea, artifacts, routed };
}
describe('capability Dream admission and original-identity replay', () => {
  it('replays a completed run as one ordinary idea with original source provenance', async () => {
    const f = await fixture();
    const first = await sinkDreamInsight(f.input, f.deps);
    f.run.status = 'accepted';
    const retry = await sinkDreamInsight(f.input, f.deps);
    expect(first).toMatchObject({ sunk: true, ideaId: 'dream:fixture-run', created: true });
    expect(retry).toMatchObject({ sunk: true, ideaId: 'dream:fixture-run', workItemId: 'EI-CAPTURED', created: false });
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.artifacts.size).toBe(1); expect(f.routed.size).toBe(1);
    expect(f.capture.mock.calls[0]![0].payloadExtra.dream.provenance).toEqual(f.provenance);
    expect(f.capture.mock.calls[0]![0].body).toContain('Review does not approve a plan');
  });
  it('recovers a capture-success / routing-failure crash without inserting again', async () => {
    const f = await fixture();
    f.recordRoutedIdea.mockRejectedValueOnce(new Error('crash after insert'));
    await expect(sinkDreamInsight(f.input, f.deps)).rejects.toThrow('crash after insert');
    expect(f.run.routedRef).toBeNull();
    expect(await sinkDreamInsight(f.input, f.deps)).toMatchObject({ sunk: true, created: false });
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.artifacts.size).toBe(1); expect(f.routed.size).toBe(1);
  });
  it.each(['rejected', 'abstained', 'malformed', 'duplicate', 'error'] as const)('counterexample: %s runs never enter the sink', async (status) => {
    const f = await fixture(); f.run.status = status;
    expect(await sinkDreamInsight(f.input, f.deps)).toEqual({ sunk: false, reason: 'review-rejected' });
    expect(f.capture).not.toHaveBeenCalled(); expect(f.recordRoutedIdea).not.toHaveBeenCalled();
  });
  it('counterexample: changed source bytes after review refuse capture', async () => {
    const f = await fixture(); await writeFile(join(f.root, 'evidence/A.ts'), 'export function A() { return "changed"; }');
    expect(await sinkDreamInsight(f.input, f.deps)).toMatchObject({ sunk: false, reason: 'source-unverified' });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('counterexample: a changed candidate cannot borrow an accepted review', async () => {
    const f = await fixture(); f.candidate.behavior = 'A different, unreviewed behavior.';
    expect(await sinkDreamInsight(f.input, f.deps)).toMatchObject({ sunk: false, reason: 'source-unverified' });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('counterexample: stale prior art, missing accounting and a changed manifest fail closed', async () => {
    const f = await fixture();
    expect(await sinkDreamInsight({ ...f.input, sources: { ...f.sources, readCurrent: async () => null } }, f.deps)).toMatchObject({ sunk: false });
    f.provenance.calls[0]!.status = 'reserved' as never; f.provenance.calls[0]!.usage = null as never;
    expect(await sinkDreamInsight(f.input, f.deps)).toMatchObject({ sunk: false });
    f.provenance.calls[0]!.status = 'settled'; f.provenance.calls[0]!.usage = { model: 'dreamer', costUsd: 0.01, inputTokens: 100, outputTokens: 10 };
    expect(await sinkDreamInsight({ ...f.input, manifest: { ...f.manifest, revision: 'changed' } }, f.deps)).toMatchObject({ sunk: false });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('preserves evidence binding through a JSONB-style object-key reorder', async () => {
    const f = await fixture();
    function reorder(value: unknown): unknown {
      return Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
    }
    f.run.outcome = reorder(f.run.outcome) as DreamRun['outcome']; f.run.review = reorder(f.run.review) as DreamRun['review'];
    const stored = dreamCapabilityRun(f.run)!;
    if (stored.sampling?.status !== 'selected') throw new Error('Missing selection');
    expect(capabilityReviewEvidenceHash(stored.sampling.selection)).toBe(f.review.evidenceHash);
    expect(await sinkDreamInsight(f.input, f.deps)).toMatchObject({ sunk: true });
  });
});
