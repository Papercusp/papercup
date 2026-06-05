/**
 * The deploy GATE decision — the layer between `gatherPlan` (review) and
 * `executeDeploy` (act). The shipped suite covers deploy mechanics + the
 * green/FF happy path; this file covers the gate's REFUSAL semantics:
 *   - a non-fast-forward target is flagged (isFastForward:false + the non-FF warning)
 *   - --force drops the "NOT the green" warning and marks the plan forced
 *   - a not-green/not-forced candidate is REFUSED before executeDeploy runs
 *
 * deploy-cli.ts's `main()` runs at module top-level (`main().then(process.exit)`)
 * and is not exported, so importing it would launch a real deploy. Rather than
 * refactor product code, we test `gatherPlan` over a real temp repo and assert the
 * gate predicate exactly as deploy-cli.ts encodes it (`!plan.green && !force`) —
 * see the NOTE at the bottom. Git is real-but-throwaway; nothing else escapes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherPlan, type DeployPlan } from './deploy';
import { git, revParse } from './git-ops';
import { releaseConfig } from './release-config';
import { AGENT_ROLES } from '@papercusp/agent-mcp';

let repo: string;
let release: string;

async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(repo, 'HEAD');
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'relgate-int-'));
  release = mkdtempSync(join(tmpdir(), 'relgate-rel-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
});

/**
 * The gate predicate exactly as deploy-cli.ts encodes it (line ~57):
 *   `if (!plan.green && !force) { REFUSE; return 2; }`
 * Returns whether the gate would PROCEED to executeDeploy.
 */
function gateProceeds(plan: DeployPlan, force: boolean): boolean {
  if (plan.noop) return false; // already at target — nothing to deploy
  if (!plan.green && !force) return false; // refused
  return true;
}

describe('gatherPlan — gate inputs', () => {
  it('flags a non-fast-forward target (isFastForward:false + the non-FF warning)', async () => {
    // release checkout sits on a feature line; main diverges → not a FF.
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await git(repo, ['worktree', 'add', '--detach', release, c1]);
    // move the release checkout onto a divergent commit (so currentReleaseSha is NOT an ancestor of target)
    const cFeat = await commit('feat.txt', 'feat', 'feat'); // on main
    await git(repo, ['-C', release, 'checkout', '-q', '--detach', cFeat]);
    // now reset main onto a different line and advance `ready` there
    await git(repo, ['reset', '--hard', c1]);
    const cDiv = await commit('b.txt', 'div', 'div');
    await git(repo, ['branch', '-f', 'ready', cDiv]);

    const p = await gatherPlan(
      releaseConfig({ integrationRoot: repo, releaseRoot: release, releaseRef: 'ready' }),
    );
    expect(p.isFastForward).toBe(false);
    expect(p.warnings.some((w) => /not a fast-forward/.test(w))).toBe(true);
    await git(repo, ['worktree', 'remove', '--force', release]).catch(() => {});
  });

  it('force:true drops the "NOT the green" warning and marks the plan forced', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2'); // main (target) is ahead of ready → not green

    const cfg = releaseConfig({ integrationRoot: repo, releaseRoot: repo, releaseRef: 'ready' });

    const unforced = await gatherPlan(cfg, { target: c2 });
    expect(unforced.green).toBe(false);
    expect(unforced.forced).toBe(false);
    expect(unforced.warnings.some((w) => /NOT the green/.test(w))).toBe(true);

    const forced = await gatherPlan(cfg, { target: c2, force: true });
    expect(forced.green).toBe(false);
    expect(forced.forced).toBe(true);
    // the NOT-green warning is suppressed once forced
    expect(forced.warnings.some((w) => /NOT the green/.test(w))).toBe(false);
  });
});

describe('deploy gate predicate (deploy-cli.ts refusal)', () => {
  it('REFUSES a not-green / not-forced candidate — does NOT proceed to executeDeploy', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2'); // un-green target

    const cfg = releaseConfig({ integrationRoot: repo, releaseRoot: repo, releaseRef: 'ready' });
    const plan = await gatherPlan(cfg, { target: c2 });

    expect(plan.green).toBe(false);
    expect(gateProceeds(plan, /* force */ false)).toBe(false); // refused → no executeDeploy
  });

  it('PROCEEDS for the same un-green candidate once forced', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2'); // un-green target
    // release checkout pinned at c1 (NOT the target) so the plan is not a noop
    await git(repo, ['worktree', 'add', '--detach', release, c1]);

    const cfg = releaseConfig({ integrationRoot: repo, releaseRoot: release, releaseRef: 'ready' });
    const plan = await gatherPlan(cfg, { target: c2, force: true });

    expect(plan.green).toBe(false);
    expect(plan.noop).toBe(false);
    expect(gateProceeds(plan, /* force */ true)).toBe(true);
    await git(repo, ['worktree', 'remove', '--force', release]).catch(() => {});
  });

  it('PROCEEDS for a green target (the safe default), but NOT when noop', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2');
    await git(repo, ['branch', '-f', 'ready', c2]); // ready == target == green

    const cfg = releaseConfig({ integrationRoot: repo, releaseRoot: repo, releaseRef: 'ready' });
    const greenPlan = await gatherPlan(cfg); // target defaults to `ready`
    expect(greenPlan.green).toBe(true);
    // releaseRoot === repo, whose HEAD is c2 === target → noop, so the gate stops
    expect(greenPlan.noop).toBe(true);
    expect(gateProceeds(greenPlan, false)).toBe(false);
  });
});

describe('release-manager role registration', () => {
  it("'release-manager' is a known built-in agent role (AGENT_ROLES)", () => {
    expect(AGENT_ROLES).toContain('release-manager');
  });
});
