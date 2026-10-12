/** Per-harness Settings coverage in the maintained disposable Portal boundary. */
import { expect, it } from 'vitest';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal per-harness Settings graph mounts separately from utility Profile before private allocation', async () => {
    const input = {
      portalSourceRoot: preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]),
      selected: 'settings-preflight-selected', neighbor: 'settings-preflight-neighbor', harnessSettings: true,
    };
    const graph = await buildPortalRosterBrowser(input);
    for (const file of ['AdvHarnessPanelPage.tsx', 'BlueprintSettingsPanel.tsx', 'HarnessSettingsPanel.tsx']) {
      expect([...graph.originals.keys()].some(path => path.endsWith('/' + file))).toBe(true);
    }
    expect(graph.bundle).toContain('Schema-driven per-harness settings');
    expect(await verifyPrivateWorkspaceBrowserMount(input)).toMatchObject({
      mounted: true, settingsBlueprintDefault: true, settingsScopeSwitch: true,
    });
    // This mount uses explicit component responses. Private spec persistence,
    // cookie/Host denials and hosted acceptance need their own journey receipts.
  }, 180_000);
