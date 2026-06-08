/**
 * scout-archive-port.test.ts — Scout P-012 Scout→archive adapter.
 * Pins the async→sync bridge over a fake ArchiveAPI: snapshot load, empty-cell
 * admission, occupied-cell rejection, in-cycle de-dup, and flush→upsertElite.
 */
import { describe, it, expect } from 'vitest';
import { buildScoutArchivePort } from './scout-archive-port';
import type { ArchiveAPI, ArchiveCandidate } from '../gym/qd/archive';
import type { ArchiveElite } from '../gym/qd/niche';
import type { ArchiveSeedEntry } from './gym-bridge';

function elite(scope: 'local' | 'module' | 'cross-cutting' | 'architectural', domain: string, risk: 'low' | 'medium' | 'high'): ArchiveElite {
  const coords = { scope, domain, risk };
  return {
    nicheKey: `${scope}|${domain.toLowerCase()}|${risk}`,
    coords,
    candidateId: `gym-${scope}-${domain}`,
    fitness: 0.7,
    descriptor: { coords, features: [0.7, 0.5] },
    source: 'gym',
    updatedAt: 0,
  };
}

function seedEntry(scope: 'local' | 'module' | 'cross-cutting' | 'architectural', domain: string, risk: 'low' | 'medium' | 'high'): ArchiveSeedEntry {
  const coords = { scope, domain, risk };
  return { candidateId: `scout-${scope}-${domain}`, descriptor: { coords, features: [0.9, 0.2] }, rationale: 'leap' };
}

function fakeApi(initial: ArchiveElite[]): { api: ArchiveAPI; upserts: { candidateId: string; source?: string }[] } {
  const upserts: { candidateId: string; source?: string }[] = [];
  const api = {
    async listElites() {
      return initial;
    },
    async upsertElite(c: ArchiveCandidate) {
      upserts.push({ candidateId: c.candidateId, source: c.source });
      return { admitted: true, reason: 'new-niche', nicheKey: 'k', isNewNiche: true, novelty: 1, elite: {} as ArchiveElite };
    },
    async getElite() {
      return null;
    },
    async noveltyScore() {
      return 1;
    },
    async coverage() {
      return { filled: initial.length, total: 100, fraction: initial.length / 100 };
    },
    async steppingStones() {
      return initial;
    },
  } as unknown as ArchiveAPI;
  return { api, upserts };
}

describe('buildScoutArchivePort (P-012 Scout→archive)', () => {
  it('snapshots existing elites into a sync listElites view', async () => {
    const { api } = fakeApi([elite('module', 'sync', 'low'), elite('local', 'ui', 'high')]);
    const port = await buildScoutArchivePort({ workspaceId: 'w', harnessSlug: 'h', api });
    const views = port.listElites();
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.nicheKey).sort()).toEqual(['local|ui|high', 'module|sync|low']);
    expect(views[0].source).toBe('gym');
  });

  it('admits a seed into an EMPTY cell, rejects one into an OCCUPIED cell', async () => {
    const { api } = fakeApi([elite('module', 'sync', 'low')]);
    const port = await buildScoutArchivePort({ workspaceId: 'w', harnessSlug: 'h', api });
    // Empty cell (different niche) → admitted.
    const a = port.seed(seedEntry('architectural', 'planning', 'high'));
    expect(a).toEqual({ admitted: true, nicheKey: 'architectural|planning|high' });
    // Occupied cell (matches the existing gym elite) → not admitted.
    const b = port.seed(seedEntry('module', 'sync', 'low'));
    expect(b).toEqual({ admitted: false, nicheKey: 'module|sync|low' });
  });

  it('a second seed into the same (now-filled) cell this cycle does not double-admit', async () => {
    const { api } = fakeApi([]);
    const port = await buildScoutArchivePort({ workspaceId: 'w', harnessSlug: 'h', api });
    expect(port.seed(seedEntry('local', 'docs', 'low')).admitted).toBe(true);
    expect(port.seed(seedEntry('local', 'docs', 'low')).admitted).toBe(false);
    // The admitted seed shows in the live snapshot.
    expect(port.listElites().some((v) => v.nicheKey === 'local|docs|low' && v.source === 'scout')).toBe(true);
  });

  it('flush persists buffered scout seeds via upsertElite (source=scout, fitness 0)', async () => {
    const { api, upserts } = fakeApi([]);
    const port = await buildScoutArchivePort({ workspaceId: 'w', harnessSlug: 'h', api });
    port.seed(seedEntry('architectural', 'planning', 'high'));
    port.seed(seedEntry('cross-cutting', 'coord', 'medium'));
    port.seed(seedEntry('architectural', 'planning', 'high')); // dup — not buffered again
    await port.flush();
    expect(upserts).toHaveLength(2);
    expect(upserts.every((u) => u.source === 'scout')).toBe(true);
    // Flush clears the buffer (a second flush is a no-op).
    await port.flush();
    expect(upserts).toHaveLength(2);
  });
});
