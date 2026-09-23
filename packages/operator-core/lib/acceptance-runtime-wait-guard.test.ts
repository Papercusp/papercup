/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-003/P-006 — a deploy wait is challenged
 * when the caller's held live acceptance bars are measured on another runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptancePlaneAdvisoryForWait,
  buildAcceptancePlaneAdvisory,
  goalNamesDeployWait,
  isDeployWaitEvent,
  loadHeldLiveBars,
  type WaitGuardDeps,
} from './acceptance-runtime-wait-guard';

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';

const deps = (criteria: Awaited<ReturnType<WaitGuardDeps['acceptanceCriteria']>>): WaitGuardDeps & { reads: number } => {
  const d = {
    reads: 0,
    heldPlanSlugs: async () => ['psu-pty-plan'],
    acceptanceCriteria: async () => {
      d.reads += 1;
      return criteria;
    },
  };
  return d;
};

describe('deploy-wait detection', () => {
  it('matches release-deploy event keys only', () => {
    expect(isDeployWaitEvent('release:deployed')).toBe(true);
    expect(isDeployWaitEvent('release:deployed:papercusp')).toBe(true);
    expect(isDeployWaitEvent('release:deploy-failed')).toBe(true);
    expect(isDeployWaitEvent('deploy:await')).toBe(true);
    expect(isDeployWaitEvent('work-item:done:WI-1')).toBe(false);
    expect(isDeployWaitEvent('release:green')).toBe(false);
    expect(isDeployWaitEvent(null)).toBe(false);
  });

  it('matches loop goals waiting on main/:3070/a deploy, not ordinary uses of "main"', () => {
    expect(goalNamesDeployWait('Wait for the fix to reach green main, then grade R-3')).toBe(true);
    expect(goalNamesDeployWait('re-check :3070 serves the fix')).toBe(true);
    expect(goalNamesDeployWait('waiting on the deploy before acceptance')).toBe(true);
    expect(goalNamesDeployWait('finish once it lands on main')).toBe(true);
    expect(goalNamesDeployWait('the main risk is the parser; fix it')).toBe(false);
    expect(goalNamesDeployWait('Carry plan X to shipped')).toBe(false);
  });
});

describe('advisory construction', () => {
  it('names the non-release runtime of each held live bar', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([
        { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', evidenceRuntime: 'bg-host' },
        { key: 'r-3', barKey: 'R-3', evidencePlane: 'live', method: `census rows from ${BG_PATH}` },
        { key: 'r-2', barKey: 'R-2', evidencePlane: 'tree' },
      ]),
    );
    expect(bars.map((b) => b.barKey)).toEqual(['R-1', 'R-3']);
    const advisory = buildAcceptancePlaneAdvisory(bars);
    expect(advisory).toMatch(/bg-host: psu-pty-plan#R-1, psu-pty-plan#R-3 \(inferred\)/);
    expect(advisory).toMatch(/None of your held bars needs the release operator/);
    expect(advisory).toMatch(/Registered anyway/);
  });

  it('is silent when every held live bar really is measured on the release operator', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([{ key: 'r-1', barKey: 'R-1', evidencePlane: 'deployed', evidenceRuntime: 'release-operator' }]),
    );
    expect(buildAcceptancePlaneAdvisory(bars)).toBeNull();
  });

  it('is silent with no held live bars, or only unresolved ones', async () => {
    expect(buildAcceptancePlaneAdvisory([])).toBeNull();
    const bars = await loadHeldLiveBars('su-x', deps([{ key: 'r-1', evidencePlane: 'live', method: 'eyeball it' }]));
    expect(buildAcceptancePlaneAdvisory(bars)).toBeNull();
  });

  it('names the release-operator bars that DO need main alongside the ones that do not', async () => {
    const bars = await loadHeldLiveBars(
      'su-x',
      deps([
        { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', evidenceRuntime: 'staging-operator' },
        { key: 'r-9', barKey: 'R-9', evidencePlane: 'deployed', evidenceRuntime: 'release-operator' },
      ]),
    );
    expect(buildAcceptancePlaneAdvisory(bars)).toMatch(/Only psu-pty-plan#R-9 genuinely need the release operator/);
  });
});

describe('acceptancePlaneAdvisoryForWait — the call events:await and loop:arm make', () => {
  const live = [{ key: 'r-1', barKey: 'R-1', evidencePlane: 'live' as const, evidenceRuntime: 'bg-host' as const }];

  it('advises on a release:deployed await and on a deploy-shaped loop goal', async () => {
    expect(await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'release:deployed' }, deps(live))).toMatch(
      /ACCEPTANCE-PLANE ADVISORY/,
    );
    expect(
      await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', goal: 'wait for green main then grade' }, deps(live)),
    ).toMatch(/bg-host/);
  });

  it('does no I/O at all for a wait that is not deploy-shaped', async () => {
    const d = deps(live);
    expect(await acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'work-item:done:WI-1' }, d)).toBeNull();
    expect(d.reads).toBe(0);
  });

  it('never throws — a failing read degrades to no advisory, never a refused wait', async () => {
    const broken: WaitGuardDeps = {
      heldPlanSlugs: async () => {
        throw new Error('presence down');
      },
      acceptanceCriteria: async () => null,
    };
    await expect(acceptancePlaneAdvisoryForWait({ ownerId: 'su-x', event: 'release:deployed' }, broken)).resolves.toBeNull();
    await expect(acceptancePlaneAdvisoryForWait({ ownerId: null, event: 'release:deployed' }, deps(live))).resolves.toBeNull();
  });
});
