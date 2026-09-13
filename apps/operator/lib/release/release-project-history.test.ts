import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertProjectHistoryDocument } from '@papercusp/plan-parser/project-history';
import { buildReleaseHistoryAssets, normalizeReleaseHistoryAssets, releaseHistoryStem, releaseProjectHistory } from './release-project-history';
import { gateSite } from './gate-release-site';
import { renderIndexHtml, renderProjectHistoryPage, type HydratedRelease } from './release-history-page';

const release: HydratedRelease = {
  row: {
    version: '1.2.3', channel: 'alpha', cutAt: new Date('2026-09-01T00:00:00Z'),
    publishedAt: null, changelogMd: null, workItemIds: ['WI-1', 'WI-2'], planSlugs: ['demo'],
    artifacts: [], gitSha: 'a'.repeat(40), cutBy: null, notes: null,
  },
  items: [
    { id: 'WI-1', title: 'Fix update discovery', planSlug: 'demo', kind: 'bug', state: 'done',
      closedAt: '2026-08-31T00:00:00Z', completionAuthority: 'work-item-ledger',
      terminalCompletionEvidence: { summary: 'Discovery retries work', testsRun: 'updater suite', testResult: 'passed' } },
    { id: 'WI-2', title: 'Unplanned correction', planSlug: null },
    { id: 'WI-3', title: 'Future work', planSlug: 'demo' },
  ],
  plans: [{ slug: 'demo', title: 'Updater', status: 'active', itemCount: 1,
    content: '---\nslug: demo\ntitle: Updater\nstatus: active\n---\n## Work\n- **P-001** `done` Discovery (WI-1)\n- **P-002** `done` Future work (WI-3)\n\n## Decisions\n### D-001 — Retry failures\nPreserve useful error messages.\n' }],
  internalCount: 0,
};
const scope = { workspaceId: 'test-workspace', harnessSlug: 'papercusp' };

describe('release Project History adapter', () => {
  it('uses schema v2 and canonical plan structure, retaining real completion evidence', () => {
    const history = releaseProjectHistory(release, scope, []);
    expect(assertProjectHistoryDocument(history)).toBe(history);
    expect(history.plans[0].decisions[0].id).toBe('D-001');
    expect(history.plans[0].items.map((item) => item.id)).toEqual(['P-001', 'P-002']);
    expect(history.plans[0].completedItems[0]).toMatchObject({
      id: 'WI-1', completionAuthority: 'work-item-ledger',
      completionEvidence: { testsRun: 'updater suite', testResult: 'passed' }, commits: [],
    });
  });

  it('excludes later inferred completions and preserves work without a plan', () => {
    const history = releaseProjectHistory(release, scope, []);
    expect(history.plans.flatMap((plan) => plan.completedItems.map((item) => item.id)).sort()).toEqual(['WI-1', 'WI-2']);
    expect(history.plans.find((plan) => plan.slug === 'release-unplanned-work')?.completedItems[0].id).toBe('WI-2');
  });

  it('scrubs every public field and leaves valid JSON', () => {
    const dirty = structuredClone(release);
    const fakeHome = path.join(path.sep, 'home', 'jane');
    dirty.items[0].title = `Jane Example fixed ${fakeHome}/update`;
    dirty.items[0].terminalCompletionEvidence!.summary = 'Verified by Jane Example';
    const json = JSON.stringify(releaseProjectHistory(dirty, scope, [{ value: 'Jane Example', kind: 'git-name' }]));
    expect(json).not.toContain('Jane Example');
    expect(json).not.toContain(fakeHome);
    expect(() => assertProjectHistoryDocument(JSON.parse(json))).not.toThrow();
  });

  it('supports empty recorded releases and rejects unsafe output paths', () => {
    expect(releaseProjectHistory({ ...release, items: [], plans: [] }, scope, []).plans).toEqual([]);
    expect(() => releaseHistoryStem('../escape', 'alpha')).toThrow();
  });

  it('does not attribute an item to a different plan merely mentioning its id', () => {
    const other = { ...release.plans[0], slug: 'other', content: '---\nslug: other\ntitle: Other\n---\n- **P-001** `done` Mention (WI-1)' };
    const history = releaseProjectHistory({ ...release, row: { ...release.row, planSlugs: ['demo', 'other'] }, plans: [...release.plans, other] }, scope, []);
    expect(history.plans.find((plan) => plan.slug === 'other')?.completedItems).toEqual([]);
  });

  it('packages executable assets without development comments and preserves JSON dictionaries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-'));
    try {
      fs.writeFileSync(path.join(directory, 'runtime.js'), '// developer@example.invalid\nglobalThis.result = 1 + 2;');
      fs.writeFileSync(path.join(directory, 'dictionary.js'), '{"locale":"en"}');
      normalizeReleaseHistoryAssets(directory);
      const code = fs.readFileSync(path.join(directory, 'runtime.js'), 'utf8');
      expect(code).not.toContain('developer@example.invalid');
      expect(code).toContain('globalThis.result=3');
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'dictionary.js'), 'utf8'))).toEqual({ locale: 'en' });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('replaces old asset output and builds a self-hosted, privacy-clean renderer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-build-'));
    try {
      fs.mkdirSync(path.join(directory, 'assets'));
      fs.writeFileSync(path.join(directory, 'assets', 'stale.js.map'), 'old development source');
      await buildReleaseHistoryAssets(directory);
      expect(fs.existsSync(path.join(directory, 'assets', 'stale.js.map'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'assets', 'project-history.js'))).toBe(true);
      expect(fs.existsSync(path.join(directory, 'assets', 'vditor/dist/js/lute/lute.min.js'))).toBe(true);
      expect(gateSite(directory, [])).toEqual([]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('links downloads to shared history and retains static work-item navigation', () => {
    const options = { generatedAt: new Date(), analytics: null, redact: [] };
    const index = renderIndexHtml([release], options);
    expect(index).toContain('href="changes/desktop-v1.2.3-alpha.html"');
    const page = renderProjectHistoryPage(release, options);
    expect(page).toContain('data-document="desktop-v1.2.3-alpha.json"');
    expect(page).toContain('src="../assets/project-history.js"');
    expect(page).toContain('href="../work-items/WI-1.html"');
    expect(page).toContain('href="../plans/demo.html"');
    expect(page).toContain('release-history-fallback');
  });
});
