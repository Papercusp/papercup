/** Explicit native acceptance; uses only the verifier's disposable Postgres. */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const live = process.env.PAPERCUSP_P2P_JOIN_NATIVE_LIVE === '1';

describe.skipIf(!live)('P2P join progress through the owned native operator', () => {
  it('serves populated owner progress and renders every join state without crossing harnesses', async () => {
    expect(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED).toBe('1');
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(Number(process.env.VERIFY_TAURI_PID)).toBe(profile.tauriPID);
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    expect(profile.workspaceId).toMatch(/^verify-tauri-isolated-\d+$/);
    const privateUrl = new URL(profile.privateAdminUrl);
    expect(['127.0.0.1', 'localhost']).toContain(privateUrl.hostname);
    expect(privateUrl.port).not.toBe('5432');
    expect(profile.evidencePath.startsWith('/')).toBe(true);
    const sql = postgres(profile.privateAdminUrl, { max: 1, connect_timeout: 10 });
    const env = { ...process.env, TMPDIR: profile.nativeTmpDir };
    const native = async (command: string, ...args: string[]) => {
      await execute('bash', [process.env.VERIFY_TAURI_LIVENESS_CHECK!], { env, timeout: 15_000 });
      return (await execute(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!,
        [command, ...args, '--pid', String(profile.tauriPID)], { env, timeout: 30_000 })).stdout.trim();
    };
    const evaluate = async (expression: string) => JSON.parse(await native('eval', `JSON.stringify(${expression})`));
    const cases = [
      { slug: 'native-joining', joinState: 'joining', mergedOps: 10, caughtUp: false, state: 'syncing', text: 'Joining' },
      { slug: 'native-usable', joinState: 'usable', mergedOps: 3, caughtUp: false, state: 'syncing', text: 'Syncing 3/10' },
      { slug: 'native-failed', joinState: 'failed', mergedOps: 3, caughtUp: false, state: 'failed', text: 'Sync stalled' },
      { slug: 'native-complete', joinState: 'complete', mergedOps: 10, caughtUp: true, state: 'caught-up', text: 'Up to date' },
      { slug: 'native-pending', joinState: 'complete', mergedOps: 10, caughtUp: false, state: 'syncing', text: 'Syncing 10/10' },
    ];
    const handles = [...cases.map(c => ({ workspaceId: profile.workspaceId, harnessSlug: c.slug })),
      { workspaceId: profile.workspaceId, harnessSlug: 'native-unobserved' }];
    const progress = cases.map(c => ({ workspaceId: profile.workspaceId, harnessSlug: c.slug,
      joinState: c.joinState, mergedOps: c.mergedOps, ownLogLength: 10, targetFrontier: 10,
      headApplied: c.joinState !== 'joining', caughtUp: c.caughtUp, lastMergeAt: Date.now(),
      stalledForMs: c.joinState === 'failed' ? 600_001 : 0 }));
    const evidence: Record<string, unknown> = { schemaVersion: 1, scope: 'current-build-native-fixture',
      sourceCommit: receipt.sourceCommit, sourceReceipt: process.env.VERIFY_TAURI_SOURCE_RECEIPT,
      nativePid: profile.tauriPID, workspaceId: profile.workspaceId, phase: 'fixture-publication' };
    const save = () => writeFileSync(profile.evidencePath, JSON.stringify(evidence, null, 2));
    const publish = () => sql`
      INSERT INTO harness_shared.substrate_booted_handles_status (workspace_id, payload)
      VALUES (${profile.workspaceId}, ${sql.json({ handles, sentAt: Date.now(), healthInputs: {
        bootstrapProgress: progress, replicationLiveness: [], ownLogForks: [], logStats: [], contentConnectivity: [],
      } })}) ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
    let publishError: unknown;
    let beat: ReturnType<typeof setInterval> | undefined;
    try {
      await publish();
      beat = setInterval(() => { void publish().catch(error => { publishError = error; }); }, 5_000);
      const origin = process.env.VERIFY_TAURI_DEV_URL!;
      const response = await fetch(origin + '/api/admin/dogfood-substrate-health', { signal: AbortSignal.timeout(20_000) });
      expect(response.status).toBe(200);
      const body = await response.json();
      evidence.serviceResponse = body; save();
      expect(body.reachedSubstrateOwner).toBe(true);
      expect(body.bootstrapProgressObserved).toBe(true);
      expect(body.harnesses).toHaveLength(handles.length);
      for (const sample of progress) {
        const row = body.harnesses.find((h: { harnessSlug: string }) => h.harnessSlug === sample.harnessSlug);
        expect(row.workspaceId).toBe(profile.workspaceId);
        expect(row.bootstrapProgress).toEqual(sample);
      }
      expect(body.harnesses.find((h: { harnessSlug: string }) => h.harnessSlug === 'native-unobserved').bootstrapProgress).toBeNull();
      evidence.phase = 'native-render'; save();
      await native('navigate', '/admin/dogfood-substrate');
      for (const sample of cases) {
        const selector = `[data-testid="dogfood-substrate-row-${sample.slug}"] [data-testid="bootstrap-progress-indicator"]`;
        await expect.poll(() => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)});
          return !!node && node.dataset.state === ${JSON.stringify(sample.state)} && node.textContent.includes(${JSON.stringify(sample.text)}); })()`),
        { timeout: 60_000 }).toBe(true);
      }
      await expect.poll(() => evaluate(`!!document.querySelector('[data-testid="dogfood-substrate-row-native-unobserved"] [aria-label="Join progress unavailable"]')`),
        { timeout: 20_000 }).toBe(true);
      const screenshot = profile.evidencePath + '.states.png';
      await native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', screenshot);
      evidence.statesScreenshot = screenshot;
      // A historical completed join must return to syncing while materialization is pending.
      progress.find(p => p.harnessSlug === 'native-complete')!.caughtUp = false;
      await publish();
      await expect.poll(() => evaluate(`document.querySelector('[data-testid="dogfood-substrate-row-native-complete"] [data-testid="bootstrap-progress-indicator"]')?.dataset.state === 'syncing'`),
        { timeout: 60_000 }).toBe(true);
      expect(publishError).toBeUndefined();
      evidence.phase = 'passed'; evidence.verifiedAt = new Date().toISOString(); save();
    } catch (error) {
      evidence.failure = { phase: evidence.phase, message: String(error), stack: error instanceof Error ? error.stack : undefined };
      save();
      throw error;
    } finally {
      if (beat) clearInterval(beat);
      await sql`DELETE FROM harness_shared.substrate_booted_handles_status WHERE workspace_id = ${profile.workspaceId}`;
      await sql.end({ timeout: 5 });
    }
  }, 180_000);
});
