import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_SELECTION_CENSUS, WORK_SELECTION_SEED_ROWS } from './work-selection-census';

// Repo root = packages/operator-core/lib/../../..
const ROOT = resolve(__dirname, '..', '..', '..');

describe('work-selection census (enterprise-data-sources P-007)', () => {
  it('every census row points at a file that still contains its kind-decider anchor', () => {
    const stale = WORK_SELECTION_CENSUS.filter((row) => {
      const path = resolve(ROOT, row.file);
      return !existsSync(path) || !readFileSync(path, 'utf8').includes(row.anchor);
    }).map((row) => `${row.id}: ${row.file} no longer contains ${JSON.stringify(row.anchor)}`);
    // A failure here means a decider moved or changed: update the census row (and re-check its
    // admits/reachesNonWork verdict) rather than deleting the row.
    expect(stale).toEqual([]);
  });

  it('census ids are unique and every selection path names its discriminators or evidence', () => {
    const ids = WORK_SELECTION_CENSUS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of WORK_SELECTION_CENSUS.filter((r) => r.role === 'selection')) {
      expect(row.discriminators.length, row.id).toBeGreaterThan(0);
    }
  });

  it('records the paths a non-work instance reaches today, so P-009 cannot close with one left', () => {
    const reaching = WORK_SELECTION_CENSUS.filter((r) => r.reachesNonWork === 'yes').map((r) => r.id);
    expect(reaching).toEqual(expect.arrayContaining(['by-id-claim', 'list-search-count', 'drain-mode']));
  });

  it('seed rows cover every nature with work_items instances plus human-audience work, and only agent work is claimable', () => {
    const natures = new Set(WORK_SELECTION_SEED_ROWS.map((r) => r.nature));
    for (const n of ['work', 'record', 'internal-excluded', 'retired'] as const) expect(natures.has(n), n).toBe(true);
    expect(WORK_SELECTION_SEED_ROWS.some((r) => r.nature === 'work' && r.audience === 'human')).toBe(true);
    for (const row of WORK_SELECTION_SEED_ROWS) {
      const agentWork = row.nature === 'work' && row.audience === 'agent';
      expect(row.expectAgentClaimable, `${row.itemKind} ${JSON.stringify(row.payload)}`).toBe(agentWork);
    }
  });
});
