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

  it('cuts a long multi-word title at a dash (word) boundary, never mid-word (EI-18121665970916886)', () => {
    // A realistic long title made of real words joined by kebab-casing — the
    // historical bug (.slice(0, 60)) produced ids ending mid-word, e.g.
    // "...-work-items-prob" (chopping "problem"/"problematic" in half).
    const title =
      'The hive re-mounts a full escalation cascade work items problematic for downstream consumers';
    const id = candidateItemId(title, new Set());
    expect(id.length).toBeLessThanOrEqual(60);
    // the id must be a PREFIX of the full kebab-cased title up to a dash —
    // i.e. every char before the cut point matches, and the cut lands exactly
    // on a dash boundary (no trailing partial word).
    const fullKebab = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    expect(fullKebab.startsWith(id)).toBe(true);
    expect(fullKebab.length).toBeGreaterThan(id.length); // it really was cut
    // the char immediately after the cut in the full string is a dash (word
    // boundary), i.e. we did not stop mid-word
    expect(fullKebab[id.length]).toBe('-');
  });

  it('falls back to a hard cut only when there is no dash to cut on within budget', () => {
    const id = candidateItemId(`${'x'.repeat(100)}`, new Set());
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id).toBe('x'.repeat(60));
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

describe('reviewCandidateForAutoAdopt (WI-5414 automated review + P-001 transferability bar)', () => {
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

  /** A distiller that judges pass and rewrites the draft to `lesson`. */
  const passDistiller = (title: string, lesson: string) =>
    vi.fn(async () => ({ text: JSON.stringify({ verdict: 'pass', title, lesson }), costUsd: 0 }));

  it('passes a transferable candidate when the fleet-lessons pack does not exist yet, carrying the DISTILLED lesson', async () => {
    const empty = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-review-empty-'));
    const distiller = passDistiller('Lock before concurrent edits', 'Acquire the file lock before editing shared files.');
    const verdict = await reviewCandidateForAutoAdopt(draft('New lesson', 'Some new draft text.'), {
      packsRoot: empty,
      distiller,
    });
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'transferable; fleet-lessons pack is empty — nothing to conflict with (knowledge-pack sweep scoring)',
      distilled: { title: 'Lock before concurrent edits', text: 'Acquire the file lock before editing shared files.' },
    });
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('fails at stage 1 when the transferability judge rejects the draft — the conflict judge never runs', async () => {
    const distiller = vi.fn(async () => ({
      text: '{"verdict":"fail","reason":"raw incident report bound to a specific log hash"}',
      costUsd: 0,
    }));
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('[replication-liveness] log=6b29d5e853eb…', 'log=6b29d5e853eb… has NEVER attached a replicator (181s).'),
      { packsRoot: root, distiller, judge },
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('not a transferable lesson');
    expect(verdict.reason).toContain('raw incident report');
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns verdict error (stays pending, D-004) when the transferability judge is unusable — e.g. the no-API-key distiller', async () => {
    const distiller = vi.fn(async () => ({ text: '[]', costUsd: 0 }));
    const verdict = await reviewCandidateForAutoAdopt(draft('Whatever', 'Whatever text.'), {
      packsRoot: root,
      distiller,
    });
    expect(verdict.verdict).toBe('error');
  });

  it('fails at stage 2 when the conflict judge reports a contradiction with an existing item (judged on the DISTILLED text)', async () => {
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

    const distiller = passDistiller('Use SQLite for durable state', 'Write durable state to a local SQLite file.');
    const judge = vi.fn(async ({ newText, neighbors }: { newText: string; neighbors: Array<{ id: string }> }) => {
      expect(newText).toBe('Write durable state to a local SQLite file.'); // the DISTILLED text, not the raw draft
      return {
        conflicts: [{ memory_id: neighbors[0]!.id, summary: 'contradicts the existing Postgres-only lesson' }],
      };
    });
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Use SQLite for durable state', 'RAW DRAFT: sqlite kept timing out on host xyz-123.'),
      { packsRoot: root, judge, distiller },
    );
    expect(judge).toHaveBeenCalledOnce();
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('contradicts the existing Postgres-only lesson');
    expect(verdict.reason).toContain('knowledge-pack sweep scoring');
  });

  it('passes when the conflict judge reports no conflict', async () => {
    const distiller = passDistiller('Lock files first', 'Lock a file before editing it concurrently.');
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Unrelated lesson', 'Lock a file before editing it concurrently.'),
      { packsRoot: root, judge, distiller },
    );
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'transferable; no conflict with existing fleet-lessons content (knowledge-pack sweep scoring)',
      distilled: { title: 'Lock files first', text: 'Lock a file before editing it concurrently.' },
    });
  });

  it('still passes stage 2 when the conflict judge itself errors (checkConflicts fails open — stage 1 is the load-bearing bar)', async () => {
    const distiller = passDistiller('Whatever lesson', 'Whatever transferable text.');
    const judge = vi.fn(async () => {
      throw new Error('LLM timeout');
    });
    const verdict = await reviewCandidateForAutoAdopt(draft('Whatever lesson', 'Whatever text.'), {
      packsRoot: root,
      judge,
      distiller,
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

  it('adopts a passing candidate WITH the distilled overrides and dismisses a failing one, stamping the machine identity + verdict note', async () => {
    const list = vi.fn(async () => [pendingOf('a'), pendingOf('b')]);
    const review = vi.fn(async (c: KnowledgePackCandidate) =>
      c.id === 'a'
        ? {
            verdict: 'pass' as const,
            reason: 'transferable; no conflict (knowledge-pack sweep scoring)',
            distilled: { title: 'Distilled title', text: 'Distilled transferable lesson.' },
          }
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
      expect.objectContaining({
        id: 'a',
        action: 'adopt',
        by: AUTO_ADOPT_REVIEWER,
        note: expect.stringContaining('no conflict'),
        // P-001/D-003: the pack materializes the DISTILLED lesson, not the raw draft
        title: 'Distilled title',
        text: 'Distilled transferable lesson.',
      }),
    );
    expect(decide).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'b', action: 'dismiss', by: AUTO_ADOPT_REVIEWER, note: expect.stringContaining('conflicts with X') }),
    );
  });

  it('an ERRORED review (D-004) counts as failed and never calls decide — the candidate stays pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('e1'), pendingOf('e2')]);
    const review = vi.fn(async (c: KnowledgePackCandidate) =>
      c.id === 'e1'
        ? { verdict: 'error' as const, reason: 'transferability judge returned no usable verdict' }
        : { verdict: 'pass' as const, reason: 'ok', distilled: { title: 'T', text: 'L.' } },
    );
    const decide = vi.fn(async (input: { id: string; action: string }) => ({
      ok: true as const,
      action: input.action as 'adopt' | 'dismiss',
      id: input.id,
      packId: 'fleet-lessons',
      packItemId: input.id,
      packVersion: '0.0.1',
    }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review } as never);
    expect(result).toEqual({ reviewed: 2, adopted: 1, dismissed: 0, failed: 1 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2', action: 'adopt' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays pending'));
    warn.mockRestore();
  });

  it('a review that THROWS is treated as errored (stays pending), never adopt-by-default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('t')]);
    const review = vi.fn(async () => {
      throw new Error('pack fs I/O');
    });
    const decide = vi.fn();

    const result = await autoAdoptPendingCandidates({}, { list, decide, review } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 0, failed: 1 });
    expect(decide).not.toHaveBeenCalled();
    warn.mockRestore();
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
