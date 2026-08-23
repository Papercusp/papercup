/**
 * goal-package-store — write→read roundtrip, the reader's strict refusals, and
 * the live-state boundary (tripwire `current` never survives a read)
 * (work-on-everything-goal-2026-08-23 P-006).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOAL_PACKAGE_MANIFEST,
  readGoalPackageDirForInstall,
  writeGoalPackageDir,
  type GoalPackageExport,
} from './goal-package-store';

const scratch = () => mkdtempSync(join(tmpdir(), 'pcv-goal-store-'));

const EXPORT: GoalPackageExport = {
  title: 'Keep the tree green',
  body: 'Duties: watch the gate, fix the reds.',
  standing: true,
  killCriterion: 'The owner retires the duty',
  tripwires: [{ metric: 'spend_usd', label: 'Spend', threshold: 500, unit: 'usd' }],
  budgetCents: 50_000,
  budgetWindowSec: 604_800,
  launchSettings: { maxAgents: 3 },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: {} },
  description: 'A standing stewardship goal package',
  requiresRubrics: [{ rubricRef: 'quality-bar' }],
};

/** Hand-assemble a package dir (the shape a mirror repo would carry). */
function writeManifest(root: string, ref: string, manifest: unknown, listing?: unknown): string {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GOAL_PACKAGE_MANIFEST), JSON.stringify(manifest), 'utf8');
  if (listing !== undefined) {
    writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing), 'utf8');
  }
  return dir;
}

describe('writeGoalPackageDir → readGoalPackageDirForInstall roundtrip', () => {
  it('preserves the full shape, standing flag and budget window included', () => {
    const root = scratch();
    const written = writeGoalPackageDir(EXPORT, { ref: 'keep-green', targetDir: root });
    const pkg = readGoalPackageDirForInstall(written.dir, 'keep-green');
    expect(pkg).not.toBeNull();
    expect(pkg).toMatchObject({
      ref: 'keep-green',
      title: EXPORT.title,
      body: EXPORT.body,
      standing: true,
      killCriterion: EXPORT.killCriterion,
      budgetCents: 50_000,
      budgetWindowSec: 604_800,
      launchSettings: { maxAgents: 3 },
      inputSchema: { type: 'object' },
      version: '0.1.0',
      source: 'exported',
      layer: 'user',
    });
    expect(pkg!.tripwires).toEqual([{ metric: 'spend_usd', label: 'Spend', threshold: 500, unit: 'usd' }]);
    // The listing echo is the declaration the installer trusts (no derivation for goals).
    expect(pkg!.requiresRubrics).toMatchObject([{ rubricRef: 'quality-bar' }]);
  });

  it('omits requires_rubrics from listing.json entirely when none are declared', () => {
    const root = scratch();
    const written = writeGoalPackageDir({ ...EXPORT, requiresRubrics: [] }, { ref: 'no-rubrics', targetDir: root });
    const listing = JSON.parse(readFileSync(written.listingPath, 'utf8')) as Record<string, unknown>;
    expect('requires_rubrics' in listing).toBe(false);
    expect(listing).toMatchObject({ kind: 'goal', id: 'no-rubrics' });
  });

  it('refuses an unsafe ref rather than writing outside the store', () => {
    const root = scratch();
    expect(() => writeGoalPackageDir(EXPORT, { ref: '../evil', targetDir: root })).toThrow(/unsafe/);
  });
});

describe('the reader is a live-state boundary', () => {
  it('DROPS tripwire `current` readings — a package carries defaults, never telemetry', () => {
    const root = scratch();
    const dir = writeManifest(root, 'with-current', {
      title: 'x',
      tripwires: [{ metric: 'm', label: 'L', threshold: 3, current: 2, unit: 'usd' }],
    });
    const pkg = readGoalPackageDirForInstall(dir, 'with-current');
    expect(pkg).not.toBeNull();
    expect(pkg!.tripwires).toEqual([{ metric: 'm', label: 'L', threshold: 3, unit: 'usd' }]);
    expect(pkg!.tripwires![0]).not.toHaveProperty('current');
  });
});

describe('the reader refuses malformed substantive fields (never degrades)', () => {
  const cases: Array<[string, unknown]> = [
    ['missing title', {}],
    ['non-boolean standing', { title: 'x', standing: 'yes' }],
    ['zero budgetWindowSec', { title: 'x', budgetWindowSec: 0 }],
    ['negative budgetWindowSec', { title: 'x', budgetWindowSec: -5 }],
    ['fractional budgetWindowSec', { title: 'x', budgetWindowSec: 1.5 }],
    ['fractional-cent budget', { title: 'x', budgetCents: 10.5 }],
    ['tripwire missing label', { title: 'x', tripwires: [{ metric: 'm', threshold: 1 }] }],
    ['tripwires not an array', { title: 'x', tripwires: { metric: 'm' } }],
    ['inputSchema an array', { title: 'x', inputSchema: [] }],
    ['outputSchema a string', { title: 'x', outputSchema: 'nope' }],
    ['launchSettings a string', { title: 'x', launchSettings: 'nope' }],
    ['non-string body', { title: 'x', body: 42 }],
  ];
  for (const [label, manifest] of cases) {
    it(`refuses: ${label}`, () => {
      const root = scratch();
      const dir = writeManifest(root, 'bad', manifest);
      expect(readGoalPackageDirForInstall(dir, 'bad')).toBeNull();
    });
  }

  it('accepts the minimal manifest and applies the documented defaults', () => {
    const root = scratch();
    const dir = writeManifest(root, 'minimal', { title: 'Just a title' });
    const pkg = readGoalPackageDirForInstall(dir, 'minimal');
    expect(pkg).toMatchObject({
      title: 'Just a title',
      body: null,
      standing: false,
      killCriterion: null,
      tripwires: null,
      budgetCents: null,
      budgetWindowSec: null,
      launchSettings: null,
      inputSchema: null,
      outputSchema: null,
      requiresRubrics: [],
      version: '0.1.0',
      source: 'installed',
    });
  });
});
