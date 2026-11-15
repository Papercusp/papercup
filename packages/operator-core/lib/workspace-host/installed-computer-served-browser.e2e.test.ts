/** Explicit served-engine acceptance. Supply PAPERCUSP_PORTAL_SOURCE_ROOT;
 * test:file selects the maintained e2e config and records the native receipt. */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestRunsPgUrl } from '@papercusp/test-config/admin-test-runs-reporter';
import { assertInstalledRuntimeSource, installedDesktopBinaries, installedPortalRelease, installedPortalSource } from './installed-computer-served-browser.fixture';

describe('served Portal installed-computer consent', () => {
  it('uses the real Portal and local app to persist view-only consent and reuse browser/install identity', async () => {
    const portal = process.env.PAPERCUSP_PORTAL_SOURCE_ROOT;
    expect(portal, 'PAPERCUSP_PORTAL_SOURCE_ROOT must name the maintained Portal checkout').toBeTruthy();
    const root = fileURLToPath(new URL('../../../..', import.meta.url));
    // Refuse a mixed native import cohort before hashing the large Portal
    // artifact or provisioning its private database.
    await assertInstalledRuntimeSource(root);
    await installedPortalSource(portal);
    const release = process.env.PAPERCUSP_TEST_PORTAL_RELEASE_ROOT;
    await installedPortalRelease(portal!, release);
    const actorId = process.env.PAPERCUSP_SID;
    const workspaceId = process.env.PAPERCUSP_TEST_RUN_WORKSPACE
      ?? process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE;
    const harness = process.env.PAPERCUSP_TEST_RUN_HARNESS ?? 'papercusp';
    expect(actorId, 'Maintained Portal reporter requires this session actor').toBeTruthy();
    expect(workspaceId, 'Maintained Portal reporter requires the caller ledger workspace').toBeTruthy();
    const kasmvncRoot = process.env.PAPERCUSP_TEST_KASMVNC_ROOT;
    await installedDesktopBinaries(kasmvncRoot);
    const artifacts = await mkdtemp(join(tmpdir(), 'installed-portal-served-'));
    const evidence = join(artifacts, 'runtime');
    const log = createWriteStream(join(artifacts, 'wrapper.log'), { mode: 0o600 });
    const child = spawn(process.execPath, ['scripts/with-test-pg.mjs', '--isolated-runtime=operator-api', '--',
      process.execPath, '--import', 'tsx', 'packages/operator-core/lib/workspace-host/machine-first-browser-runtime.fixture.ts',
      '--installed-browser', '--smoke', '--portal-source-root', portal!, '--evidence', evidence,
      '--portal-release-root', release!, '--portal-actor-id', actorId!,
      '--portal-ledger-workspace', workspaceId!, '--portal-ledger-harness', harness,
      ...(kasmvncRoot ? ['--kasmvnc-root', kasmvncRoot] : [])], {
      cwd: root, env: { ...process.env,
        PAPERCUSP_TEST_RUN_WORKSPACE: workspaceId!,
        PAPERCUSP_TEST_RUNS_DB_URL: resolveTestRunsPgUrl(process.env) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const retain = (data: Buffer) => { log.write(data); output = (output + data.toString()).slice(-12000); };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    const deadline = setTimeout(() => child.kill('SIGTERM'), 16 * 60_000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      expect(exit, `Served runtime failed; artifacts ${artifacts}\n${output}`).toBe(0);
      const receipt = JSON.parse(await readFile(`${evidence}.json`, 'utf8'));
      expect(receipt.status).toBe('passed');
      expect(receipt.installedBrowser).toMatchObject({ status: 'passed', portalEngine: 'Next/Playwright',
        desktopRegistryCount: 193, linkedWorkspaceCount: 1, liveRosterIndex: 192,
        executor: { ok: true, passed: 2, failed: 0, skipped: 0 } });
      expect(receipt.installedBrowser.artifact.sourceRootDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.installedBrowser.executor.testRunIds.length).toBeGreaterThan(0);
      expect(receipt.installedBrowser.installedHost).toMatchObject({ pid: receipt.installedBrowser.operatorPid,
        xServer: 'kasmvnc', name: 'served-0192-live' });
      expect(receipt.cleanup.every((process: { exitCode: number | null; signal: string | null }) =>
        process.exitCode !== null || process.signal !== null)).toBe(true);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => log.end((error?: Error | null) => error ? reject(error) : resolve()));
    }
  }, 17 * 60_000);
});
