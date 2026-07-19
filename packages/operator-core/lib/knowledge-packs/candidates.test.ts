/**
 * candidates unit tests — the pure/fs halves of the fleet→pack staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11; auto-adopt
 * reversal WI-5414): id/version helpers, the rendered learning file
 * ROUND-TRIPPING through the real pack-format parser, materializeCandidateIntoPack
 * against a temp root, the automated review (fs + injected judge — no PG), and
 * the autoAdoptPendingCandidates sweep against injected deps (no PG — the PG
 * half of stage/decide pins in candidates.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_ADOPT_REVIEWER,
  FLEET_LESSONS_PACK_ID,
  autoAdoptPendingCandidates,
  bumpPatchVersion,
  candidateItemId,
  materializeCandidateIntoPack,
  renderCandidateLearningFile,
  reviewCandidateForAutoAdopt,
  type KnowledgePackCandidate,
} from './candidates';
import { parseLearningFile } from './pack-format';
import { loadKnowledgePack } from './load-packs';

describe('bumpPatchVersion', () => {
  it('bumps the patch component; degrades garbage to 0.0.1', () => {
    expect(bumpPatchVersion('0.0.0')).toBe('0.0.1');
    expect(bumpPatchVersion('1.2.9')).toBe('1.2.10');
    expect(bumpPatchVersion('not-semver')).toBe('0.0.1');
  });
});

describe('candidateItemId', () => {
  it('kebab-cases the title and dedupes with numeric suffixes', () => {
    expect(candidateItemId('Memory search keeps timing out!', new Set())).toBe(
      'memory-search-keeps-timing-out',
    );
    expect(candidateItemId('Memory search keeps timing out!', new Set(['memory-search-keeps-timing-out']))).toBe(
      'memory-search-keeps-timing-out-2',
    );
    expect(candidateItemId('???', new Set())).toBe('fleet-lesson');
    expect(candidateItemId(`${'very-'.repeat(30)}long`, new Set()).length).toBeLessThanOrEqual(60);
  });
});

describe('renderCandidateLearningFile', () => {
  it('round-trips through the real pack-format parser, provenance included', () => {
    const raw = renderCandidateLearningFile({
      itemId: 'lock-before-edit',
      title: 'Always check locks: the "hook" serializes edits',
      text: 'Find how this project serializes concurrent edits before writing.',
      kind: 'feedback',
      appliesTo: ['any'],
      signature: 'lock|edit|serialize',
      scopes: ['operator', 'harness:sheets'],
      recurrenceCount: 4,
      sourceItemIds: ['EI-1', 'EI-2'],
    });
    const { item, error } = parseLearningFile(raw, 'fallback');
    expect(error).toBeUndefined();
    expect(item).toMatchObject({
      id: 'lock-before-edit',
      // fmValue: newlines collapsed, double quotes become single
      title: `Always check locks: the 'hook' serializes edits`,
      kind: 'feedback',
      appliesTo: ['any'],
    });
    expect(item!.text).toContain('Find how this project serializes concurrent edits');
    expect(item!.text).toContain('recurred 4× across operator, harness:sheets');
    expect(item!.text).toContain('EI-1, EI-2');
  });
});

describe('materializeCandidateIntoPack', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-test-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const lesson = (title: string) => ({
    title,
    text: 'Discover how this project coordinates shared-tree edits before changing files.',
    kind: 'feedback' as const,
    appliesTo: ['any' as const],
    signature: 'shared|tree|coord',
    scopes: ['operator', 'harness:papercup'],
    recurrenceCount: 3,
    sourceItemIds: ['EI-9'],
  });

  it('first adoption creates the pack (v0.0.1); the next bumps the version and dedupes ids', async () => {
    const first = await materializeCandidateIntoPack(lesson('Coordinate shared-tree edits'), { packsRoot: root });
    expect(first).toEqual({
      packId: FLEET_LESSONS_PACK_ID,
      packItemId: 'coordinate-shared-tree-edits',
      packVersion: '0.0.1',
    });

    const second = await materializeCandidateIntoPack(lesson('Coordinate shared-tree edits'), { packsRoot: root });
    expect(second.packItemId).toBe('coordinate-shared-tree-edits-2');
    expect(second.packVersion).toBe('0.0.2');

    // The written pack is fully loadable through the normal resolution path —
    // which is what lets the EXISTING install/upgrade conflict review carry it.
    const loaded = await loadKnowledgePack(FLEET_LESSONS_PACK_ID, {
      roots: [{ dir: root, source: 'installed' }],
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.warnings).toEqual([]);
    expect(loaded!.pack.manifest.version).toBe('0.0.2');
    expect(loaded!.pack.items.map((i) => i.id).sort()).toEqual([
      'coordinate-shared-tree-edits',
      'coordinate-shared-tree-edits-2',
    ]);
  });
});

describe('reviewCandidateForAutoAdopt (WI-5414 automated review)', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-review-test-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const draft = (title: string, draftText: string): Pick<KnowledgePackCandidate, 'title' | 'draftText'> => ({
    title,
    draftText,
  });

  it('passes when the fleet-lessons pack does not exist yet (nothing to conflict with)', async () => {
    const empty = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-review-empty-'));
    const verdict = await reviewCandidateForAutoAdopt(draft('New lesson', 'Some new draft text.'), {
      packsRoot: empty,
    });
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'fleet-lessons pack is empty — nothing to conflict with (knowledge-pack sweep scoring)',
    });
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('fails the review when the judge reports a contradiction with an existing item', async () => {
    await materializeCandidateIntoPack(
      {
        title: 'Use Postgres for durable state',
        text: 'Always write new durable state to Postgres, never a flat file.',
        kind: 'feedback',
        appliesTo: ['any'],
        signature: 'storage|policy',
        scopes: ['operator', 'harness:sheets'],
        recurrenceCount: 3,
        sourceItemIds: ['EI-1'],
      },
      { packsRoot: root },
    );

    const judge = vi.fn(async ({ neighbors }: { neighbors: Array<{ id: string }> }) => ({
      conflicts: [{ memory_id: neighbors[0]!.id, summary: 'contradicts the existing Postgres-only lesson' }],
    }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Use SQLite for durable state', 'Always write new durable state to a local SQLite file.'),
      { packsRoot: root, judge },
    );
    expect(judge).toHaveBeenCalledOnce();
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('contradicts the existing Postgres-only lesson');
    expect(verdict.reason).toContain('knowledge-pack sweep scoring');
  });

  it('passes when the judge reports no conflict', async () => {
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Unrelated lesson', 'Lock a file before editing it concurrently.'),
      { packsRoot: root, judge },
    );
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'no conflict with existing fleet-lessons content (knowledge-pack sweep scoring)',
    });
  });

  it('degrades to pass when the judge itself errors (hygiene, never load-bearing)', async () => {
    const judge = vi.fn(async () => {
      throw new Error('LLM timeout');
    });
    const verdict = await reviewCandidateForAutoAdopt(draft('Whatever lesson', 'Whatever text.'), {
      packsRoot: root,
      judge,
    });
    expect(verdict.verdict).toBe('pass');
  });
});

describe('autoAdoptPendingCandidates (WI-5414 sweep, injected deps)', () => {
  const pendingOf = (id: string): KnowledgePackCandidate => ({
    id,
    signature: `sig-${id}`,
    title: `Candidate ${id}`,
    draftText: 'Draft text.',
    kind: 'feedback',
    appliesTo: ['any'],
    scopes: ['operator', 'harness:sheets'],
    recurrenceCount: 3,
    sourceItemIds: ['EI-1'],
    status: 'pending',
    createdBy: 'recurrence-escalation',
    createdAt: new Date(0).toISOString(),
  });

  it('adopts a passing candidate and dismisses a failing one, stamping the machine identity + verdict note', async () => {
    const list = vi.fn(async () => [pendingOf('a'), pendingOf('b')]);
    const review = vi.fn(async (c: KnowledgePackCandidate) =>
      c.id === 'a'
        ? { verdict: 'pass' as const, reason: 'no conflict (knowledge-pack sweep scoring)' }
        : { verdict: 'fail' as const, reason: 'conflicts with X (knowledge-pack sweep scoring)' },
    );
    const decide = vi.fn(async (input: { id: string; action: string }) => ({
      ok: true as const,
      action: input.action as 'adopt' | 'dismiss',
      id: input.id,
      ...(input.action === 'adopt' ? { packId: 'fleet-lessons', packItemId: input.id, packVersion: '0.0.1' } : {}),
    }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review } as never);
    expect(result).toEqual({ reviewed: 2, adopted: 1, dismissed: 1, failed: 0 });
    expect(decide).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'a', action: 'adopt', by: AUTO_ADOPT_REVIEWER, note: expect.stringContaining('no conflict') }),
    );
    expect(decide).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'b', action: 'dismiss', by: AUTO_ADOPT_REVIEWER, note: expect.stringContaining('conflicts with X') }),
    );
  });

  it('counts a decide() failure (e.g. the transfer bar) as `failed`, leaving the candidate for the next tick', async () => {
    const list = vi.fn(async () => [pendingOf('c')]);
    const review = vi.fn(async () => ({ verdict: 'pass' as const, reason: 'clean' }));
    const decide = vi.fn(async () => ({ ok: false as const, reason: 'transfer_bar' as const }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 0, failed: 1 });
  });

  it('maxPerRun: 0 reviews nothing', async () => {
    const list = vi.fn(async () => [pendingOf('d')]);
    const result = await autoAdoptPendingCandidates({ maxPerRun: 0 }, { list } as never);
    expect(result).toEqual({ reviewed: 0, adopted: 0, dismissed: 0, failed: 0 });
    expect(list).not.toHaveBeenCalled();
  });
});
