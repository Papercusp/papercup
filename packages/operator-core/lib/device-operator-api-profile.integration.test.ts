import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

describe('disposable operator-api monitoring sources', () => {
  it('measures an explicitly paused private gate and preserves missing-source failure', () => {
    const probe = `
      import { getOrgPg } from '@papercusp/db-org';
      import { releaseGateTile } from './packages/operator-core/lib/device-monitoring.ts';
      import { clearOrientPipelineCache } from './packages/operator-core/lib/agent-tools/coordination/pipeline-health.ts';
      const e = process.env;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      if (!id.startsWith('test-runtime-') || e.PAPERCUSP_POT_HOME_SLUG !== id ||
          e.PAPERCUSP_BACKGROUND_WORKERS !== '0' || e.PAPERCUSP_DBOS_ROUTINES !== '0') {
        throw new Error('Disposable request-only identity required');
      }
      const { sql } = getOrgPg();
      try {
        const rows = await sql\`SELECT workspace_id, install_slug, active, next_fire_at, metadata
          FROM harness_shared.routines WHERE name = 'green-checkpoint'\`;
        const gate = await releaseGateTile(id);
        await sql\`DELETE FROM harness_shared.routines WHERE install_slug = \${id} AND name = 'green-checkpoint'\`;
        clearOrientPipelineCache();
        const missingGate = await releaseGateTile(id);
        console.log('PRIVATE_GATE_PROOF=' + JSON.stringify({ id, home: e.HOME, rows, gate, missingGate }));
      } finally { await sql.end(); }
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status, (result.stderr ?? '').slice(-3000)).toBe(0);
    // Progress messages must never be mistaken for the final ready identity.
    // These retained stages also identify import/registry/DB/sidecar stalls.
    for (const stage of ['imports:harness-registry', 'imports:embed-sidecar',
      'imports:db-org', 'imports:device-monitoring', 'private-registry',
      'paused-routine', 'measure-private-gate', 'sidecar-listen']) {
      expect(result.stdout).toContain('operator-api stage ' + stage + ' +');
    }
    const timings = result.stdout.split('\n').filter(line => line.includes('operator-api stage ') && line.includes(' timing='))
      .map(line => JSON.parse(line.slice(line.indexOf(' timing=') + ' timing='.length)));
    expect(timings.length, 'The real child must retain emission and receive clocks').toBeGreaterThan(0);
    for (const timing of timings) {
      expect(timing.childPid).toBeGreaterThan(0);
      expect(timing.childElapsedMs).toBeGreaterThanOrEqual(0);
      expect(timing.childEventLoopDelayMaxMs).toBeGreaterThanOrEqual(0);
      expect(timing.parentLoopLateMaxMs).toBeGreaterThanOrEqual(0);
      expect(timing.deliveryDelayMs).toBeCloseTo(timing.parentReceivedAtMs - timing.childEmittedAtMs, 2);
      expect(timing.profileSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set(timings.map(timing => timing.childPid)).size).toBe(1);
    expect(new Set(timings.map(timing => timing.profileSourceSha256)).size).toBe(1);
    for (const stage of ['harness-registry', 'embed-sidecar', 'db-org', 'device-monitoring',
      'pipeline-health', 'why-chain', 'git-pipeline-stats']) {
      const started = timings.find(timing => timing.stage === 'imports:' + stage && timing.phase === 'start' && !timing.heartbeat);
      const finished = timings.find(timing => timing.stage === 'imports:' + stage && timing.phase === 'ready' && !timing.heartbeat);
      expect(started, 'Missing actual import start: ' + stage).toBeDefined();
      expect(finished, 'Missing actual import completion: ' + stage).toBeDefined();
      expect(finished.operationDurationMs).toBeGreaterThanOrEqual(0);
      expect(Math.abs(finished.operationDurationMs - (finished.childElapsedMs - started.childElapsedMs))).toBeLessThan(5);
    }
    for (const source of ['routines', 'conflicts', 'day', 'week', 'recent',
      'deploy', 'fire-history', 'config-import', 'config-ready']) {
      expect(result.stdout).toContain('measure-private-gate:' + source + ':start');
      expect(result.stdout).toContain('measure-private-gate:' + source + ':ready');
    }
    const gateStages = result.stdout.split('\n').filter(line => line.includes('measure-private-gate:'));
    expect(gateStages.some(line => line.includes('pending=["routines"]'))).toBe(true);
    expect(gateStages.at(-1)).toContain('pending=[]');
    const line = result.stdout.split('\n').find(row => row.startsWith('PRIVATE_GATE_PROOF='));
    expect(line, 'Private gate proof must execute').toBeDefined();
    const proof = JSON.parse(line!.slice('PRIVATE_GATE_PROOF='.length));
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      workspace_id: proof.id, install_slug: proof.id, active: false, next_fire_at: null,
      metadata: { pause: { reason: 'Disposable operator-api fixture; publication disabled' } },
    });
    expect(proof.gate).toMatchObject({ gate: 'wedged', red: true });
    expect(proof.missingGate).toBeNull();
    expect(existsSync(proof.home), 'Private runtime must be disposed').toBe(false);
  }, 200_000);
});
