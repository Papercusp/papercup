/**
 * File-index cap probe tests (memory-backend-benchmark P-010, D-004).
 *
 * The simulation must mirror memory-compact.mjs exactly — the last
 * describe block pins that against the REAL script (skipped where the
 * script doesn't exist, e.g. CI).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeFileMemoryBackend } from '@papercusp/memory';
import { generateSyntheticCorpus, seedCorpus } from '@papercusp/memory/bench';

import {
  DEFAULT_PROJECTOR_SCRIPT,
  SOFT_CAP_KB,
  collectProjectionEntries,
  pickHook,
  probeIndexCap,
  renderIndexCapMarkdown,
  runRealProjectorDryRun,
  simulateIndexProjection,
  type ProjectionEntry,
} from './index-cap';

const NOW = Date.UTC(2026, 5, 5);

function entry(over: Partial<ProjectionEntry> & { file: string }): ProjectionEntry {
  return {
    name: over.file.replace(/\.md$/, ''),
    description: 'a sufficiently long description that pickHook keeps as the index hook line',
    type: 'project',
    mtimeMs: NOW,
    body: `body of ${over.file}`,
    ...over,
  };
}

describe('pickHook', () => {
  it('keeps a substantive description', () => {
    expect(pickHook('a description comfortably past the forty-char weak threshold', 'body line')).toMatch(/forty-char/);
  });
  it('falls back to the first body line when the description is weak', () => {
    expect(pickHook('weak', '# heading\n\nThe **real** hook line.\n')).toBe('The real hook line.');
  });
});

describe('simulateIndexProjection', () => {
  it('small store: everything indexed, no eviction, fraction 1', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry({ file: `project_p${i}.md`, mtimeMs: NOW - i * 1000 }));
    const r = simulateIndexProjection(entries, NOW);
    expect(r.indexed).toBe(20);
    expect(r.archivedOverflow).toBe(0);
    expect(r.indexedFraction).toBe(1);
    expect(r.overSoftCap).toBe(false);
    expect(r.searchableAfterCompaction).toBe(20);
  });

  it('over the soft cap: sheds OLDEST project entries until the index fits', () => {
    // ~110 bytes/line → need >190 entries to pass 20 KB.
    const entries = Array.from({ length: 400 }, (_, i) =>
      entry({ file: `project_p${i}.md`, mtimeMs: NOW - i * 60_000 }),
    );
    const r = simulateIndexProjection(entries, NOW);
    expect(r.archivedOverflow).toBeGreaterThan(0);
    expect(r.indexed).toBeLessThan(400);
    expect(r.indexBytes).toBeLessThanOrEqual(SOFT_CAP_KB * 1024);
    expect(r.overSoftCap).toBe(false);
    expect(r.indexedFraction).toBeLessThan(1);
    // Newest survive: p0 (newest) indexed, p399 (oldest) evicted.
    expect(r.indexed + r.archivedOverflow).toBe(400);
  });

  it('durable entries are NEVER evicted, even when they alone exceed the cap', () => {
    const entries = Array.from({ length: 400 }, (_, i) =>
      entry({ file: `feedback_f${i}.md`, type: 'feedback', mtimeMs: NOW - i * 60_000 }),
    );
    const r = simulateIndexProjection(entries, NOW);
    expect(r.archivedOverflow).toBe(0);
    expect(r.indexed).toBe(400);
    expect(r.overSoftCap).toBe(true); // nothing mechanical left to shed
    expect(r.overHardCap).toBe(true);
  });

  it('derivable project entries older than 30d are stale-archived', () => {
    const derivableDesc = 'SHIPPED via plan some-plan-2026-06-01 with 12 tests green su-abcdef';
    const entries = [
      entry({ file: 'project_old_state.md', description: derivableDesc, mtimeMs: NOW - 40 * 86400000 }),
      entry({ file: 'project_fresh_state.md', description: derivableDesc, mtimeMs: NOW - 1000 }),
      entry({ file: 'project_old_durable_fact.md', mtimeMs: NOW - 40 * 86400000 }), // not derivable → kept
    ];
    const r = simulateIndexProjection(entries, NOW);
    expect(r.archivedStale).toBe(1);
    expect(r.indexed).toBe(2);
  });

  it('exact-dup bodies dedupe to the newest copy', () => {
    const entries = [
      entry({ file: 'project_a.md', body: 'same body', mtimeMs: NOW - 5000 }),
      entry({ file: 'project_b.md', body: 'same body', mtimeMs: NOW }),
      entry({ file: 'project_c.md', body: 'unique body' }),
    ];
    const r = simulateIndexProjection(entries, NOW);
    expect(r.totalFiles).toBe(2);
    expect(r.indexed).toBe(2);
  });
});

describe('probeIndexCap (temp-dir stores through the seam)', () => {
  it('records cap behavior across sizes; bigger stores index a smaller fraction', async () => {
    // A tiny "real corpus" of durable entries + synthetic project distractors.
    const corpus = Array.from({ length: 10 }, (_, i) => ({
      key: `real_${i}`,
      text: `Durable fact ${i}: the marker token is held in xylophone-${i}.`,
      kind: 'feedback',
      description: `Durable fact ${i} about marker xylophone-${i} for the cap probe fixture set`,
    }));
    const report = await probeIndexCap({
      corpus,
      sizes: [400],
      projectorScript: null, // pure-simulation path; the real script is pinned below
    });
    expect(report.sizes).toEqual([10, 400]);
    const [baseline, scaled] = report.points;
    expect(baseline.indexed).toBe(10);
    expect(baseline.indexedFraction).toBe(1);
    expect(scaled.totalFiles).toBe(400);
    expect(scaled.archivedOverflow).toBeGreaterThan(0);
    expect(scaled.indexedFraction).toBeLessThan(1);
    expect(scaled.durableIndexed).toBe(10); // durables survive
    expect(scaled.indexBytes).toBeLessThanOrEqual(SOFT_CAP_KB * 1024);
    expect(report.markdown).toContain('| 400 |');
    expect(report.notes.some((n) => n.includes('PHYSICALLY ARCHIVES'))).toBe(true);
  }, 60_000);
});

describe('renderIndexCapMarkdown', () => {
  it('renders one row per point + the notes', () => {
    const r = simulateIndexProjection([entry({ file: 'project_x.md' })], NOW);
    const md = renderIndexCapMarkdown([{ size: 1, ...r }], ['note-a']);
    expect(md).toContain('| store size |');
    expect(md).toContain('| 1 |');
    expect(md).toContain('- note-a');
  });
});

// ---- fidelity pin against the real projector --------------------------------

const realScript = fs.existsSync(DEFAULT_PROJECTOR_SCRIPT);

describe.skipIf(!realScript)('simulation matches the real memory-compact.mjs', () => {
  it('agrees on indexed count and size for an over-cap store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-cap-pin-'));
    try {
      const backend = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
      // Durable floor + enough project distractors to force overflow eviction.
      await seedCorpus(
        backend,
        Array.from({ length: 25 }, (_, i) => ({
          key: `real_${i}`,
          text: `Durable fact ${i}: the marker token is held in xylophone-${i}.`,
          kind: 'feedback',
          description: `Durable fact ${i} about marker xylophone-${i} for the cap probe fixture set`,
        })),
        { scope: 'bench', concurrency: 16 },
      );
      await seedCorpus(backend, generateSyntheticCorpus(375, 99), { scope: 'bench', concurrency: 16 });

      const sim = simulateIndexProjection(collectProjectionEntries(dir));
      const real = runRealProjectorDryRun(dir);
      expect(real).not.toBeNull();
      expect(sim.indexed).toBe(real!.indexed);
      // The script reports KB at one decimal; allow that rounding.
      expect(Math.abs(sim.indexBytes / 1024 - real!.indexKb)).toBeLessThanOrEqual(0.06);
      // Dry-run must not have moved or written anything.
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'archive'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
