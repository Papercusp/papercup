import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'apps', 'operator', 'prompts', 'tutorial', 'ch6', '05-p2p-git.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate p2p Git release-contract sources');
}

const root = repoRoot();
const tutorial = readFileSync(join(root, 'apps/operator/prompts/tutorial/ch6/05-p2p-git.md'), 'utf8');
const runbook = readFileSync(
  join(root, 'apps/operator-docs/src/content/docs/agent-insights/hive-git-p2p-ops-runbook-2026-07-09.mdx'),
  'utf8',
);
const readiness = readFileSync(join(root, 'shared-pot-release-testing/RELEASE-READINESS.md'), 'utf8');

describe('hive-git public release contract', () => {
  it('onboarding names all modes and keeps the signed NO-GO boundary visible', () => {
    expect(tutorial).toContain('`legacy`');
    expect(tutorial).toContain('`bridged`');
    expect(tutorial).toContain('`p2p-only`');
    expect(tutorial).toContain('NO-GO');
    expect(tutorial).not.toContain('p2p path\nexists in early form');
  });

  it('the ops runbook uses the shipping mode API and does not promote partial rig evidence', () => {
    expect(runbook).toContain('setPotGitMode');
    expect(runbook).toContain('readPotGitMode');
    expect(runbook).not.toContain('setHiveGitMode');
    expect(runbook).not.toContain('getHiveGitMode');
    expect(runbook).toContain('P-302 → P-306 → P-308');
    expect(runbook).toContain('NO-GO');
  });

  it('the signed map keeps the hive-git row red until terminal physical evidence exists', () => {
    expect(readiness).toMatch(/\| 34 \| hive-git P2P plane — LIVE legs \| 🔴 \|/);
    expect(readiness).toContain('P-302 → P-306 → P-308 → P-402');
    expect(readiness).toContain('D-044');
  });
});
