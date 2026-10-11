/** P-005 Learning preparation. Browser graph proof alone is not private API acceptance. */
import { expect, it } from 'vitest';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Learning browser graph contains its retained ledger and scope providers before private allocation', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const graph = await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'learning-preflight-selected', neighbor: 'learning-preflight-neighbor', learning: true });
    const inputs = [...graph.originals.keys()];
    expect(inputs.some(path => path.endsWith('/LearningTab.tsx'))).toBe(true);
    expect(inputs.some(path => path.endsWith('/AdvShell.tsx'))).toBe(true);
    expect(inputs.some(path => path.endsWith('/learning-retain-types.ts'))).toBe(true);
    expect(new TextDecoder().decode(graph.bundle)).toContain('Retained ledger');
  }, 180_000);
