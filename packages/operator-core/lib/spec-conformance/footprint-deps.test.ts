import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcilePlanFootprint, type OutOfPlanFiling } from './footprint';
import { readFootprintCommitWindow } from './footprint-log';
import type { GitRunner } from '../harness/docs/subject-ref';

const fixture = {
  root: '',
  failSkip: null as number | null,
  calls: [] as string[][],
  afterPage: null as (() => void) | null,
};
const runGit: GitRunner = async (args, cwd) => {
      fixture.calls.push([...args]);
      if (fixture.failSkip !== null && args.includes(`--skip=${fixture.failSkip}`)) {
        return { code: 1, stdout: '', stderr: 'injected interrupted census page' };
      }
      const result = { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8' }), stderr: '' };
      const afterPage = fixture.afterPage;
      fixture.afterPage = null;
      afterPage?.();
      return result;
};

const planContent = '## Conformance\n\n```conformance\n{"footprint":{"paths":["src/**"]}}\n```\n';
const input = { planSlug: 'census', harnessSlug: 'fixture', planContent, sinceSha: null };
const deps = () => ({
  listCommitsSince: async (sinceSha: string | null) => {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim();
    const range = sinceSha ? [`${sinceSha}..${headSha}`] : ['--since=2020-01-01T00:00:00Z', headSha];
    return readFootprintCommitWindow({ root: fixture.root, headSha, range }, runGit);
  },
});

function history(count: number, permutedDates = false): string[] {
  fixture.root = mkdtempSync(join(tmpdir(), 'footprint-census-'));
  execFileSync('git', ['init', '--quiet', fixture.root]);
  const records: string[] = [];
  for (let i = 0; i < count; i++) {
    const date = 1735689600 + (permutedDates ? (i * 17) % count : i);
    const path = i === 0 ? 'src/decisive.ts' : 'docs/noise.txt';
    records.push(`commit refs/heads/main\nmark :${i + 1}\nauthor Census <census@example.test> ${date} +0000\ncommitter Census <census@example.test> ${date} +0000\ndata 1\nx\n${i ? `from :${i}\n` : ''}M 100644 inline ${path}\ndata 1\nx\n\n`);
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: fixture.root, input: records.join('') });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: fixture.root });
  return execFileSync('git', ['rev-list', '--reverse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim().split('\n');
}

function consumer(filings: OutOfPlanFiling[]) {
  return {
    ...deps(),
    readPlanCoverage: async () => ({ filesChanged: [], heldLocks: [] }),
    resolvePlanDriver: async () => 'driver',
    upsertOutOfPlanFinding: async (filing: OutOfPlanFiling) => {
      filings.push(filing);
      return { id: 'finding', created: true };
    },
  };
}

afterEach(() => {
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
  fixture.root = '';
  fixture.calls = [];
  fixture.failSkip = null;
  fixture.afterPage = null;
  vi.unstubAllEnvs();
});

describe('footprint census drains the complete pinned history (WI-6554700010063959)', () => {
  it.each([499, 500, 501])('reconciles all %i commits, including the oldest decisive path', async (count) => {
    vi.stubEnv('PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR', '0');
    const shas = history(count);
    const filings: OutOfPlanFiling[] = [];
    const result = await reconcilePlanFootprint(input, consumer(filings));
    expect(result).toMatchObject({ ok: true, commitsScanned: count, headSha: shas.at(-1), uncovered: [{ path: 'src/decisive.ts', commits: [shas[0]] }] });
    expect(filings).toHaveLength(1);
    expect(filings[0]?.uncovered).toEqual([{ path: 'src/decisive.ts', commits: [shas[0]] }]);
    expect(fixture.calls.filter(args => args[0] === 'log').every(args => args.includes('--max-count=500'))).toBe(true);
    if (count >= 500) expect(fixture.calls.some(args => args.includes('--skip=500'))).toBe(true);
  });

  it('drains many pages in stable ancestry order despite permuted commit dates', async () => {
    vi.stubEnv('PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR', '0');
    const shas = history(2001, true);
    const result = await deps().listCommitsSince(null);
    expect(result.commits.map(commit => commit.sha)).toEqual(shas);
    expect(fixture.calls.filter(args => args[0] === 'log')).toHaveLength(5);
    expect(result.commits[0]?.paths).toEqual(['src/decisive.ts']);
  });

  it('publishes no partial finding or watermark when a page fails; a restarted consumer recovers the oldest path', async () => {
    vi.stubEnv('PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR', '0');
    const shas = history(1001, true);
    const filings: OutOfPlanFiling[] = [];
    fixture.failSkip = 500;
    await expect(reconcilePlanFootprint(input, consumer(filings))).rejects.toThrow('interrupted census page');
    expect(filings).toEqual([]);
    fixture.failSkip = null;
    // Reconstruct the adapter/consumer, retaining the durable pre-census watermark.
    const restarted = await reconcilePlanFootprint(input, consumer(filings));
    expect(restarted).toMatchObject({ ok: true, headSha: shas.at(-1), commitsScanned: shas.length, uncovered: [{ path: 'src/decisive.ts', commits: [shas[0]] }] });
    expect(filings).toHaveLength(1);
  });

  it('pins every page to the original HEAD while new commits arrive', async () => {
    vi.stubEnv('PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR', '0');
    const shas = history(501);
    fixture.afterPage = () => {
      execFileSync('git', ['-c', 'user.name=Census', '-c', 'user.email=census@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'arrived during census'], { cwd: fixture.root });
    };
    const result = await deps().listCommitsSince(null);
    expect(result.headSha).toBe(shas.at(-1));
    expect(result.commits.map(commit => commit.sha)).toEqual(shas);
    expect(fixture.calls.filter(args => args[0] === 'log').every(args => args.at(-1) === shas.at(-1))).toBe(true);
    const next = await deps().listCommitsSince(result.headSha);
    expect(next.commits).toHaveLength(1);
    expect(next.headSha).not.toBe(result.headSha);
  });
});
