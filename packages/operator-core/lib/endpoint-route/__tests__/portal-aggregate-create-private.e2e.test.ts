/** P-005: catch module/provider failures before private workflow allocation. */
import { expect, it } from 'vitest';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT)).each([
  ['Conversations aggregate', { conversations: true }],
  ['Plans create dock', { createDock: true }],
] as const)('real Portal %s graph mounts its original component before private allocation', async (_surface, mode) => {
  const portalSourceRoot = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
  expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot,
    selected: 'aggregate-create-preflight-selected', neighbor: 'aggregate-create-preflight-neighbor', ...mode,
  })).toMatchObject({ mounted: true });
}, 180_000);
