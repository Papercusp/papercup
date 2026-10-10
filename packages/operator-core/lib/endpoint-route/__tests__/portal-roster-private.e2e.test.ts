import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser } from '../../../test/portal-roster-browser-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Settings Profile saves across reload, retains a denied draft and persists its retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', settings: true });
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/session.ts',
        'packages/operator-core/lib/operator-state-pg.ts', 'packages/operator-core/lib/endpoint-route/routes/misc/profile.ts',
        'apps/operator/app/settings/profile/page.tsx', 'apps/operator/lib/forms/useFormWith.ts',
        'apps/operator/lib/forms/FormField.tsx', 'apps/operator/lib/forms/SubmitButton.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_SETTINGS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
          if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-profile-with-cookie', savedExactValue: true, deepLinkReload: true,
          denialStatus: 403, draftRetained: true, deniedWriteIsolated: true, retryPersisted: true, retryReload: true });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([200, 403, 200]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_SETTINGS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal shortcuts persist a remap across reload, deny a foreign Origin write and restore dispatch on reset', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', shortcuts: true });
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/shortcut-registry.ts',
        'packages/operator-core/lib/shortcut-bus.ts', 'packages/operator-core/lib/profile-pref.ts',
        'packages/operator-core/lib/endpoint-route/routes/misc/profile.ts',
        'apps/operator/app/settings/shortcuts/page.tsx', 'apps/operator/app/_components/GlobalShortcutDispatcher.tsx',
        'apps/operator/lib/hotkeys.ts', 'packages/operator-ui/src/shortcuts/index.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_SHORTCUT_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        delete env.ROSTER_STOP_HTTP_MUTATION; delete env.ROSTER_HISTORY_BROWSER_PROOF;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
          if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        expect(JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length))).toMatchObject({
          authMethod: 'private-loopback-profile-with-cookie', remapImmediate: true, remapPersisted: true, deepLinkReload: true,
          resetRestoredDefault: true, denialStatus: 403, deniedWriteIsolated: true, oldChordFalsifier: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_SHORTCUT_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

// Portal is a separately maintained app. Missing source is an explicit skip,
// never a pass; acceptance runs must select its canonical source checkout.
it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal roster browser preserves denied draft, retries the exact private recipient and truthfully renders wake', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor' });
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/private-coord-receipt.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/auth.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/coord.ts',
        'apps/operator/bin/host-spa.ts', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE; delete env.ROSTER_STOP_HTTP_MUTATION;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
          if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'cookie-session',
          denialStatus: 403, draftRetained: true, retryClearedDraft: true, deepLinkReload: true,
          neighborIsolated: true, positiveControl: 'wrong-recipient rejected' });
        expect(new Set(receipt.selectedMessageIds).size).toBe(2);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_COORD_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal roster opens the selected native history and explicitly selects its GUI conversation across reload', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      history: { selectedSessionId: 1, neighborSessionId: 2, selectedRolloutId: 'preflight-selected-rollout',
        neighborRolloutId: 'preflight-neighbor-rollout', selectedMarker: 'preflight-selected', neighborMarker: 'preflight-neighbor' } });
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/session-transcript-resolvers.ts',
        'apps/operator/app/adv/sessions/SessionHistoryModal.tsx', 'apps/operator/app/_components/chat/use-owner-session-chat.ts',
        'apps/operator/app/harness/AgentInspectorModal.tsx', 'apps/operator/app/harness/AgentThinkingStream.tsx',
        'packages/operator-core/lib/endpoint-route/routes/harness/streams.ts',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HISTORY_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE; delete env.ROSTER_STOP_HTTP_MUTATION;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
          if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        expect(JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length))).toMatchObject({
          authMethod: 'cookie-session', historyKeptSeparate: true, historyReload: true, explicitGuiSelection: true,
          conversationSelectionReload: true, neighborIsolated: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_HISTORY_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);
