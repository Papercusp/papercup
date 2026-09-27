/**
 * LIVE end-to-end proof for goal-agent-behavior-feedback-2026-09-06 AUTO-BAR-R-8-P-004:
 * "Each original-plan shipment claim cites a deployed generation containing the feature."
 *
 * The ship gate's `probeCitationDeployment` answers "is the cited code deployed?" through
 * `citationDeploymentForPaths` → `gitPipelinePosition().positions.deployed`, whose deployed
 * sha comes from the release CHECKOUT (`devDeployState`). This test runs that real,
 * unmocked chain against the live host and judges it with an INDEPENDENT oracle: the
 * serving process's own `/api/health` build sha plus `git merge-base --is-ancestor`.
 * Falsifier: the claimed deployed runtime omits the feature (the chain says deployed:true
 * for a commit the serving build does not contain), or the cited generation is not the
 * one actually serving.
 *
 * Skips (never passes vacuously) when no live release operator answers /api/health.
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { citationDeploymentForPaths } from './deployment-position';

const HEALTH_URL = process.env.DEPLOY_CONTAINMENT_HEALTH_URL ?? 'http://127.0.0.1:3070/api/health';
const HERE = dirname(fileURLToPath(import.meta.url));

function git(args: string[], cwd = ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const ROOT = (() => {
  const superproject = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
    cwd: HERE,
    encoding: 'utf8',
  }).trim();
  return superproject || execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim();
})();

async function servingSha(): Promise<string | null> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: unknown };
    if (typeof body.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(body.sha)) return null;
    return git(['rev-parse', '--verify', `${body.sha}^{commit}`]);
  } catch {
    return null;
  }
}

const SERVING = await servingSha();

describe.skipIf(!SERVING)('LIVE: shipment citation deployment containment (AUTO-BAR-R-8-P-004)', () => {
  const serving = SERVING as string;
  const libPrefix = 'packages/operator-core/lib/';
  const changedSinceServing = git(['diff', '--name-only', serving, 'HEAD', '--', libPrefix])
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('/agent-tools/'));
  const tracked = git(['ls-files', '--', `${libPrefix}*.ts`])
    .split('\n')
    .filter((p) => !p.endsWith('.test.ts') && !p.slice(libPrefix.length).includes('/'));
  const deployedCandidate = ['packages/operator-core/lib/deployment-position.ts', ...tracked].find(
    (p) => !changedSinceServing.includes(p),
  );
  const undeployedCandidate = changedSinceServing.find((p) => {
    try {
      git(['cat-file', '-e', `HEAD:${p}`]);
      return true;
    } catch {
      return false;
    }
  });

  it('probe runs (no fail-soft swallow hides the measurement)', async () => {
    const { gitPipelinePosition } = await import('./git-pipeline-position');
    const r = await gitPipelinePosition({ path: deployedCandidate as string });
    expect(r.deployedSha).toBeTruthy();
  });

  it('cites the generation that is actually SERVING, and never calls omitted code deployed', async () => {
    expect(deployedCandidate, 'positive control: some lib file must be unchanged since the serving build').toBeTruthy();
    const paths = [deployedCandidate as string, ...(undeployedCandidate ? [undeployedCandidate] : [])];
    const result = await citationDeploymentForPaths(paths);
    expect(result.paths.map((p) => p.path).sort()).toEqual([...paths].sort());

    for (const entry of result.paths) {
      // The cited deployed generation must be the build the live runtime reports.
      if (entry.deployedSha) expect(git(['rev-parse', entry.deployedSha])).toBe(serving);
      if (!entry.targetSha) continue;
      const contained = isAncestor(entry.targetSha, serving);
      if (entry.positions?.deployed === true) {
        expect(contained, `${entry.path}@${entry.targetSha} claimed deployed but ${serving} omits it`).toBe(true);
      }
      if (result.undeployedPaths.includes(entry.path)) {
        expect(contained, `${entry.path} reported undeployed but ${serving} contains it`).toBe(false);
      }
    }

    // Non-vacuity: the deployed control must be MEASURED deployed, not unknown/absent.
    const control = result.paths.find((p) => p.path === deployedCandidate);
    expect(control?.deployedSha, 'deployed sha must be measured').toBeTruthy();
    expect(control?.positions?.deployed).toBe(true);
  });

  it.skipIf(!undeployedCandidate)('reports code committed after the serving build as NOT deployed', async () => {
    const result = await citationDeploymentForPaths([undeployedCandidate as string]);
    const entry = result.paths[0];
    expect(entry?.targetSha).toBeTruthy();
    expect(isAncestor(entry?.targetSha as string, serving)).toBe(false);
    expect(entry?.positions?.deployed).not.toBe(true);
  });
});
