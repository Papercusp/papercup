import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateDocsBrowserDocuments, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateDocsBrowserMount, verifyPrivateProfileOriginControl } from '../../../test/portal-roster-browser-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private ADV Docs selects by keyboard, retains a denied article and persists its exact anchored verification retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const prepared = await preparePrivateDocsBrowserDocuments(root);
    await verifyPrivateDocsBrowserMount({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      docs: { harness: 'preflight-docs', ...prepared.selection },
      markdownPreflight: { value: prepared.bodies[prepared.selection.selectedDoc], heading: prepared.selection.selectedHeading } });
    await verifyPrivateProfileOriginControl();
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/docs.ts',
        'packages/operator-core/lib/harness/docs/merged-read.ts', 'packages/operator-core/lib/harness/docs/manual-anchor.ts',
        'packages/operator-core/lib/harness/docs/doc-record.ts', 'packages/operator-core/lib/harness/docs/harness-repo.ts',
        'packages/operator-core/lib/harness-registry.ts', 'packages/operator-core/lib/harness/workspace-for-harness.ts',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx', 'apps/operator/app/adv/harnesses/AdvDocsTab.tsx',
        ...prepared.sourcePaths,
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_DOCS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF', 'ROSTER_PLANS_BROWSER_PROOF']) delete env[key];
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
          authMethod: 'private-loopback-docs-with-cookie', keyboardSelection: true, deepLinkReload: true,
          shellQueryPreserved: true, denialStatus: 403, articleRetained: true, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(receipt.writes.map((write: { target: string }) => write.target)).toEqual([receipt.selectedDoc, receipt.selectedDoc]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_DOCS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Plans filters across reload, cancels without writing and recovers its exact archive from Origin denial', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      plans: { selectedSlug: 'preflight-selected', neighborSlug: 'preflight-neighbor', selectedTitle: 'preflight-selected',
        neighborTitle: 'preflight-neighbor', harness: 'papercusp' } });
    await verifyPrivateProfileOriginControl();
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/agent-tools/plans/set-archived.ts',
        'packages/operator-core/lib/agent-tools/plans/_write-scope.ts', 'packages/operator-core/lib/agent-tools/plans/source.ts',
        'packages/operator-core/lib/agent-tools/plans/_ctx-opts.ts', 'packages/operator-core/lib/agent-tools/plans/list.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/plans.ts',
        'apps/operator/app/_components/plans/PlansPane.tsx', 'apps/operator/app/_components/plans/plans-pane.css',
        'apps/operator/app/harness/useConfirmDialog.tsx', 'apps/operator/app/admin/plans/plans-api.ts',
        'packages/operator-ui/src/surfaces/index.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_PLANS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF']) delete env[key];
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
          authMethod: 'private-loopback-plans-with-cookie', filterKeyboard: true, deepLinkReload: true,
          shellQueryPreserved: true, cancelNoRequest: true, denialStatus: 403, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(new Set(receipt.writes.map((write: { target: string }) => write.target))).toEqual(new Set([receipt.selectedSlug]));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_PLANS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Inbox retains selected deep links, isolates denied acknowledgment and persists its retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      inbox: { selectedMessageId: 'preflight-selected', neighborMessageId: 'preflight-neighbor',
        selectedTitle: 'preflight-selected', neighborTitle: 'preflight-neighbor' } });
    await verifyPrivateProfileOriginControl();
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/agent-tools/plans/attention.ts',
        'packages/operator-core/lib/agent-tools/plans/read-dispatch.ts',
        'libs/generic/tooldef-http/src/http-projection.ts',
        'packages/operator-core/lib/cache/cached-read.ts', 'packages/operator-core/lib/cache/pg-l2-store.ts',
        'packages/operator-core/lib/cache/l2-tier.ts', 'packages/operator-core/lib/cache/debounced-invalidate.ts',
        'packages/operator-core/lib/events/cache-eca-rule.ts',
        'libs/papercusp/libs/db/sql/1436-emit-change-notify-row-workspace.sql',
        'packages/operator-core/lib/agent-tools/coordination/messages.ts', 'packages/operator-core/lib/attention/adapters.ts',
        'packages/operator-core/lib/attention/terminal-action-dispatch.ts', 'packages/operator-core/lib/endpoint-route/routes/admin/coord.ts',
        'apps/operator/app/_components/inbox/InboxPane.tsx', 'apps/operator/app/_components/inbox/use-inbox-pending.ts',
        'apps/operator/app/admin/plans/PlanOtherList.tsx', 'apps/operator/app/admin/plans/attention-card.ts',
        'apps/operator/app/admin/plans/plans-api.ts', 'packages/operator-ui/src/surfaces/index.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_INBOX_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF']) delete env[key];
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
          authMethod: 'private-loopback-inbox-with-cookie', keyboardSelection: true, deepLinkReload: true,
          shellQueryPreserved: true, denialStatus: 403, selectionRetained: true, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(new Set(receipt.writes.map((write: { target: string }) => write.target)).size).toBe(1);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_INBOX_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Quick Panel prompts persist title and note, retain qp deep links and recover from a denied create', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', prompts: true });
    await verifyPrivateProfileOriginControl();
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/saved-prompts-client.ts',
        'packages/operator-core/lib/saved-prompts-store.ts', 'packages/operator-core/lib/saved-prompts-tree.ts',
        'packages/operator-core/lib/saved-prompts-materialize.ts', 'packages/operator-core/lib/cross-origin-url.ts',
        'packages/operator-core/lib/endpoint-route/routes/agent-mcp/saved-prompts.ts',
        'apps/operator/app/quick-panel/PromptsTab.tsx', 'apps/operator/app/harness/useDebouncedSave.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_PROMPTS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF']) delete env[key];
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
          authMethod: 'private-loopback-prompts-with-cookie', savedExactValue: true, bodySavedByKeyboard: true,
          deepLinkReload: true, shellQueryPreserved: true, denialStatus: 403, deniedWriteIsolated: true,
          existingOutlineRetained: true, retryPersisted: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([200, 200, 200, 403, 200]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_PROMPTS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Settings Profile saves across reload, retains a denied draft and persists its retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', settings: true });
    await verifyPrivateProfileOriginControl();
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
