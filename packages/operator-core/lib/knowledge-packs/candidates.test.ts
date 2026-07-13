/**
 * candidates unit tests — the pure/fs halves of the fleet→pack staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11): id/version
 * helpers, the rendered learning file ROUND-TRIPPING through the real
 * pack-format parser, and materializeCandidateIntoPack against a temp root
 * (no PG — the PG half pins in candidates.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FLEET_LESSONS_PACK_ID,
  bumpPatchVersion,
  candidateItemId,
  materializeCandidateIntoPack,
  renderCandidateLearningFile,
} from './candidates';
import { parseLearningFile } from './pack-format';
import { loadLearningPack } from './load-packs';

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
    const loaded = await loadLearningPack(FLEET_LESSONS_PACK_ID, {
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
