/**
 * Work-on-frame E2E — the FULL `cloud-deployment-layer-2026-06-06` P-013
 * extended step: a deployed frame's OWN orchestrator loop (D-006) completes a
 * REAL work item against its OWN Postgres (D-007), end to end:
 *
 *   deployHarness (provision → install → join)
 *     → frame operator `:3070` healthy
 *     → register harness + seed F-001 on the frame
 *     → frame loop dispatches director → worker → validator
 *     → F-001 `passed` in harness_features_consolidated + hello.txt written
 *     → teardownHarness (PRODUCT path: confirm-destroy + registry handle cleared)
 *
 * COSTS MONEY + takes ~15-45 min, so it is deliberately opt-in: skipped unless
 * `WORK_ON_FRAME_E2E_HARNESS` names a registry harness with a cloud `deployment`
 * (the standing target on the dev box: `frame-work-smoke` — Hetzner cpx31 @ ash,
 * claude backend via the staged OAuth token, runtime tarball delivery).
 *
 *   WORK_ON_FRAME_E2E_HARNESS=frame-work-smoke \
 *   npx vitest run --config vitest.integration.config.ts lib/deployment/work-on-frame.integration.test.ts
 *
 * Teardown runs in a `finally` (fires on assertion failure too) through
 * `teardownHarness` — the product path, NOT a raw provider-API sweep: the sweep
 * leaves a stale `deploymentFrame` handle in the registry (ghost frames in
 * deploy:status + the Frames tab — observed live 2026-06-09).
 *
 * Watcher provenance: feature status is read from
 * `harness_shared.harness_features_consolidated` keyed (harness_slug, feature_id)
 * — NOT `harness_shared.work_items` (querying the wrong table made the first
 * live watcher blind to F-001; found 2026-06-09).
 */
import { describe, it, expect } from 'vitest';
// Side-effect: registers the latitude+hetzner drivers + the admission instance.
import './configure';
import { deployHarness, teardownHarness, defaultDeployDeps } from './deploy';
import { sshTargetForFrame } from './frame-installer';
import { createSshRemoteExec, type RemoteExec } from './remote-exec';
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';

const SLUG = process.env.WORK_ON_FRAME_E2E_HARNESS;
const WS = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
const NINETY_MIN = 90 * 60_000;

/** psql one-liner against the frame's own Postgres (D-007), run over SSH. */
const FRAME_PSQL = `psql postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp -tAc`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tryScript(exec: RemoteExec, script: string): Promise<string | undefined> {
  try {
    return (await exec.runScript(script)).stdout.trim();
  } catch {
    return undefined;
  }
}

describe.skipIf(!SLUG)('work-on-frame E2E (opt-in: WORK_ON_FRAME_E2E_HARNESS; provisions a REAL frame)', () => {
  it(
    'a deployed frame completes F-001 to `passed` with the artifact written, then tears down clean',
    async () => {
      const log = (lvl: string, m: string) => console.log(`[work-on-frame ${lvl}] ${m}`);
      const deps = defaultDeployDeps((l, m) => log(l, m));
      const config = (await deps.getDeploymentConfig(SLUG!, WS)) as DeploymentConfig | undefined;
      if (!config || config.target === 'local') {
        throw new Error(`harness '${SLUG}' has no cloud deployment config in workspace '${WS}'`);
      }

      let frame: Frame | undefined;
      try {
        ({ frame } = await deployHarness(SLUG!, WS, deps));
        expect(frame.host).toBeTruthy();
        const exec = createSshRemoteExec(sshTargetForFrame(frame, config));

        // 1) The frame's operator host comes up (the loop lives in that process).
        let healthy = false;
        for (let i = 0; i < 30 && !healthy; i++) {
          const code = await tryScript(exec, `curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:3070/api/health`);
          healthy = code === '200';
          if (!healthy) await sleep(10_000);
        }
        expect(healthy, 'frame operator :3070 never became healthy').toBe(true);

        // 2) Register the harness on the frame + seed the work item its loop will run.
        const seedOut = await tryScript(
          exec,
          [
            `curl -s -m 10 -X POST localhost:3070/api/harness/projects -H "Content-Type: application/json" -d '{"slug":"${SLUG}","path":"/opt/papercusp/${SLUG}"}' >/dev/null`,
            `curl -s -m 10 -X POST localhost:3070/api/harness/${SLUG}/features -H "Content-Type: application/json" -d '{"id":"F-001","title":"Create hello.txt","summary":"Create a file named hello.txt at the repository root containing exactly the single line: hello from the frame","status":"todo"}'`,
          ].join('\n'),
        );
        log('info', `seeded F-001: ${String(seedOut).slice(0, 200)}`);

        // 3) The frame's own loop carries F-001 to `passed` (director → worker →
        //    validator on the frame; ~5-30 min on haiku).
        let status = '';
        let artifact = '';
        for (let i = 0; i < 80; i++) {
          status =
            (await tryScript(
              exec,
              `${FRAME_PSQL} "SELECT coalesce(status,'') FROM harness_shared.harness_features_consolidated WHERE harness_slug='${SLUG}' AND feature_id='F-001'"`,
            )) ?? '';
          artifact = (await tryScript(exec, `cat /opt/papercusp/${SLUG}/hello.txt 2>/dev/null || true`)) ?? '';
          if (i % 4 === 0) log('info', `t+${i * 30}s F-001=${status || '?'} artifact=${artifact ? 'present' : 'absent'}`);
          if (status === 'passed') break;
          await sleep(30_000);
        }
        expect(status, 'F-001 never reached `passed` on the frame').toBe('passed');
        expect(artifact).toContain('hello from the frame');
      } finally {
        // ALWAYS destroy through the product path — ends billing AND clears the
        // registry handle (no ghost frames).
        const r = await teardownHarness(SLUG!, WS, deps);
        log('info', `teardown destroyed=${r.destroyed}`);
        expect(await deps.loadFrame(SLUG!, WS), 'registry handle must be cleared by teardown').toBeUndefined();
      }
    },
    NINETY_MIN,
  );
});
