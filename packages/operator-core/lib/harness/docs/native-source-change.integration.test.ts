import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sweepHarnessDocs } from './freshness-sweep';
import type { HarnessDocRecord } from './doc-record';
import type { DriftResult } from './drift';
import type { GitRunner } from './subject-ref';

describe('native P016 documentation anchor-to-steward integration', () => {
  it('flags a real committed documented rename and delivers its scoped pinned candidate through the existing review hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-doc-change-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const runGit: GitRunner = async args => {
      try { return { code: 0, stdout: git(...args), stderr: '' }; }
      catch (error) { const e = error as { status?: number; stderr?: Buffer }; return { code: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? error) }; }
    };
    try {
      git('init', '--quiet');
      const before = 'export function readApi() { return "old"; }\n';
      const after = 'export function readApiV2() { return "new"; }\n';
      writeFileSync(join(root, 'api.ts'), before); git('add', 'api.ts'); git('commit', '--quiet', '-m', 'fixture baseline');
      const baseline = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(root, 'api.ts'), after); git('add', 'api.ts'); git('commit', '--quiet', '-m', 'fixture rename');
      const current = git('rev-parse', 'HEAD').trim();
      const doc = { docId: 'api-guide.md', source: 'manual', status: 'fresh', statusDetail: null,
        subjectRef: [{ kind: 'symbol', file: 'api.ts', name: 'readApi' }], anchorPaths: ['api.ts'],
        lastVerifiedSha: baseline, reverifyAttempts: 0, reverifyFlaggedAt: null } as HarnessDocRecord;
      let delivered: DriftResult | undefined;
      const statuses: string[] = [];
      const result = await sweepHarnessDocs({ harnessSlug: 'fixture', repoRoot: root, runGit, changedPaths: ['api.ts'],
        store: { load: async () => [doc], setStatus: async (_id, status) => { statuses.push(status); },
          touchRegen: async () => {}, touchReverify: async () => {} },
        onReverifyNeeded: (candidate, _detail, becameDrifted, drift) => {
          expect(candidate.docId).toBe('api-guide.md'); expect(becameDrifted).toBe(true); delivered = drift;
        } });
      expect(result.reverifyFlagged).toEqual(['api-guide.md']); expect(statuses).toEqual(['review']);
      expect(doc.status).toBe('fresh'); // review output never rewrites or verifies the document itself
      expect(delivered?.sourceChanges).toContainEqual(expect.objectContaining({ path: 'api.ts', status: 'measured',
        before: { commit: baseline, sha256: createHash('sha256').update(before).digest('hex') },
        after: { commit: current, sha256: createHash('sha256').update(after).digest('hex') }, removedSymbols: ['readApi'] }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
