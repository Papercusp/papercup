/**
 * template-gym tests — app-templates-2026-07-04 P-009.
 *
 * Locks the gym's pure policy so the anti-rot loop stays honest and quiet:
 *   - diffMaterialization: the P-013 verbatim-copy invariant (missing/changed
 *     detection, repo-only exemption).
 *   - findCatalogDocDrift: the docs⇄machine-catalog check.
 *   - gymWatchdogKey stability + the EI-7254 pre-filter: a STANDING red files
 *     exactly once (an open issue with the same key suppresses re-filing).
 *   - filing classification: docs drift is a human-reviewed `change`; every
 *     other red leg is an auto-implement-eligible `bug`.
 *   - live-repo pin: the templates/ dir actually yields portable checks and
 *     the repo-only exemption names a real file (guards a silent rename).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffMaterialization, findCatalogDocDrift, REPO_ONLY_CHECKS } from './template-gym-runner';
import type { GymRunSummary } from './template-gym-runner';

const captureImprovementMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovementMock(...args),
}));
const findIssuesByWatchdogKeysMock = vi.fn().mockResolvedValue([]);
vi.mock('../../issues-engineer', () => ({
  findIssuesByWatchdogKeys: (...args: unknown[]) => findIssuesByWatchdogKeysMock(...args),
}));

// Import AFTER the mocks so the action module binds the mocked seams.
const { _testing, gymWatchdogKey } = await import('./template-gym-action');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

describe('diffMaterialization (the P-013 verbatim-copy invariant)', () => {
  const tpl = new Map([
    ['a.test.ts', 'AAA'],
    ['b.test.ts', 'BBB'],
    ['composition-integrity.test.ts', 'REPO-ONLY'],
  ]);

  it('is clean when every non-repo-only check exists byte-identical app-side', () => {
    const app = new Map([
      ['a.test.ts', 'AAA'],
      ['b.test.ts', 'BBB'],
    ]);
    expect(diffMaterialization(tpl, app, REPO_ONLY_CHECKS)).toEqual({ missing: [], changed: [] });
  });

  it('flags a template check the app never materialized', () => {
    const app = new Map([['a.test.ts', 'AAA']]);
    expect(diffMaterialization(tpl, app, REPO_ONLY_CHECKS).missing).toEqual(['b.test.ts']);
  });

  it('flags a byte-diverged copy (hand-edited app-side or template moved)', () => {
    const app = new Map([
      ['a.test.ts', 'AAA'],
      ['b.test.ts', 'BBB-hand-edited'],
    ]);
    expect(diffMaterialization(tpl, app, REPO_ONLY_CHECKS).changed).toEqual(['b.test.ts']);
  });

  it('never demands repo-only checks (composition-integrity runs template-side)', () => {
    const app = new Map([
      ['a.test.ts', 'AAA'],
      ['b.test.ts', 'BBB'],
    ]);
    const d = diffMaterialization(tpl, app, REPO_ONLY_CHECKS);
    expect(d.missing).not.toContain('composition-integrity.test.ts');
  });

  it('ignores extra app-side files (configs, DECISIONS.md are legitimate)', () => {
    const app = new Map([
      ['a.test.ts', 'AAA'],
      ['b.test.ts', 'BBB'],
      ['z-extra.test.ts', 'app-local'],
    ]);
    expect(diffMaterialization(tpl, app, REPO_ONLY_CHECKS)).toEqual({ missing: [], changed: [] });
  });
});

describe('findCatalogDocDrift (docs⇄catalog)', () => {
  it('is clean when every id is mentioned', () => {
    expect(findCatalogDocDrift(['hive-app-seam', 'hono-host'], '… `hive-app-seam` … hono-host table row …')).toEqual([]);
  });
  it('reports ids the docs page dropped, sorted', () => {
    expect(findCatalogDocDrift(['z-comp', 'a-comp', 'hive-app-seam'], 'only hive-app-seam here')).toEqual(['a-comp', 'z-comp']);
  });
});

describe('red-leg filing (EI-7254-style dedup + classification)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
    findIssuesByWatchdogKeysMock.mockResolvedValue([]);
  });

  const summary = (legs: Array<{ leg: string; ok: boolean }>): GymRunSummary => ({
    runId: 'gym-test',
    startedAt: '2026-07-04T00:00:00.000Z',
    papercupRoot: '/x/papercup',
    quartermasterRoot: '/x/quartermaster',
    legs: legs.map((l) => ({ ...l, detail: l.ok ? 'green' : 'boom', durationMs: 1 })),
    green: legs.every((l) => l.ok),
  });

  it('watchdogKey is stable per leg and never embeds live output', () => {
    expect(gymWatchdogKey('materialization')).toBe('template-gym:materialization');
    expect(gymWatchdogKey('materialization')).toBe(gymWatchdogKey('materialization'));
  });

  it('files nothing on a green run', async () => {
    await _testing.fileRedLegs(summary([{ leg: 'materialization', ok: true }, { leg: 'app-checks', ok: true }]));
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('files one item per red leg with the stable key; suite reds are bugs, docs drift is a change', async () => {
    await _testing.fileRedLegs(
      summary([
        { leg: 'materialization', ok: false },
        { leg: 'docs-catalog', ok: false },
        { leg: 'kit-suite', ok: true },
      ]),
    );
    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const calls = captureImprovementMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const mat = calls.find((c) => c.watchdogKey === 'template-gym:materialization')!;
    const docs = calls.find((c) => c.watchdogKey === 'template-gym:docs-catalog')!;
    expect(mat.kind).toBe('bug');
    expect(mat.severity).toBe('major');
    expect(docs.kind).toBe('change');
    expect(docs.severity).toBe('minor');
    expect(String(mat.title)).not.toContain('boom'); // stable title — volatile detail stays in the body
  });

  it('suppresses a standing red that already has an OPEN issue with the same key', async () => {
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { state: 'open', payload: { watchdogKey: 'template-gym:app-checks' } },
      { state: 'resolved', payload: { watchdogKey: 'template-gym:kit-suite' } }, // resolved ⇒ re-file allowed
    ]);
    await _testing.fileRedLegs(
      summary([
        { leg: 'app-checks', ok: false },
        { leg: 'kit-suite', ok: false },
      ]),
    );
    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect((captureImprovementMock.mock.calls[0]![0] as Record<string, unknown>).watchdogKey).toBe('template-gym:kit-suite');
  });

  it('filingFor: only docs-catalog is a change; unknown/new legs default to bug', () => {
    expect(_testing.filingFor('docs-catalog')).toEqual({ kind: 'change', severity: 'minor' });
    expect(_testing.filingFor('materialization')).toEqual({ kind: 'bug', severity: 'major' });
    expect(_testing.filingFor('some-future-leg')).toEqual({ kind: 'bug', severity: 'major' });
  });
});

describe('live-repo pin', () => {
  it('templates/ yields portable checks and the repo-only exemption names a real file', () => {
    const templatesDir = path.join(repoRoot, 'templates');
    expect(existsSync(templatesDir)).toBe(true);
    const checkFiles: string[] = [];
    for (const d of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const checksDir = path.join(templatesDir, d.name, 'checks');
      if (!existsSync(checksDir)) continue;
      for (const f of readdirSync(checksDir)) if (f.endsWith('.test.ts')) checkFiles.push(f);
    }
    // The 5 flagship checks as of P-007; more may be added — never fewer.
    expect(checkFiles.length).toBeGreaterThanOrEqual(5);
    for (const repoOnly of REPO_ONLY_CHECKS) {
      expect(checkFiles).toContain(repoOnly); // a renamed repo-only check must update REPO_ONLY_CHECKS
    }
  });
});
