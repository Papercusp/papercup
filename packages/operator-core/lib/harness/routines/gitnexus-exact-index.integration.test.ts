import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeCliPath, GITNEXUS_KNOWN_SOURCE_PATH, selectiveSourceLimitKb } from './gitnexus-reindex-action';

/** The vendor walker used to silently omit an entire source file above 512 KiB. */
describe('GitNexus exact-index coverage on a disposable repository', () => {
  it('omits a known declaration at the vendor default, then indexes it at the routine-derived limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-exact-index-'));
    const source = GITNEXUS_KNOWN_SOURCE_PATH;
    const repo = `exact-index-${process.pid}`;
    const cli = analyzeCliPath();
    const env = { ...process.env, GITNEXUS_REGISTRY_PATH: join(root, 'registry.json') };
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const count = (query: string): number => {
      const output = run('cypher', '--repo', repo, query);
      const cell = /\|\s*(\d+)\s*\|/.exec(output);
      if (!cell) throw new Error(`GitNexus cypher returned no count: ${output.slice(-500)}`);
      return Number(cell[1]);
    };

    try {
      execFileSync('git', ['init', '-q', root], { timeout: 10_000 });
      mkdirSync(dirname(join(root, source)), { recursive: true });
      const declaration = 'export function claimNextIssueWorkItem() { return 1; }\n';
      const padding = `/*${'x'.repeat(525_617 - declaration.length - 5)}*/\n`;
      writeFileSync(join(root, source), declaration + padding);
      const limitKb = selectiveSourceLimitKb(root);
      expect(limitKb).toBe(514);

      run('analyze', root, '--skip-agents-md', '--name', repo, '--force', '--max-file-size', '512');
      expect(count(`MATCH (f:File) WHERE f.filePath = '${source}' RETURN count(f) AS n`)).toBe(0);

      run('analyze', root, '--skip-agents-md', '--name', repo, '--force', '--max-file-size', String(limitKb));
      expect(count(`MATCH (f:File) WHERE f.filePath = '${source}' RETURN count(f) AS n`)).toBe(1);
      expect(count("MATCH (f:Function) WHERE f.name = 'claimNextIssueWorkItem' RETURN count(f) AS n")).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
