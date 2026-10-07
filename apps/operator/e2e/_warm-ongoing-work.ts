import type { FullConfig } from '@playwright/test';
import { resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';
import warmDevServer from './_warm-dev-server';

/** Prepare the real HUD dependency graph using the maintained local-only warm-up. */
export default async function warmOngoingWork(config: FullConfig): Promise<void> {
  const workspaceId = resolveTestRunWorkspaceId();
  if (!workspaceId) throw new Error('The ongoing-work rehearsal requires an explicit workspace');
  await warmDevServer(config, {
    paths: [`/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId)}`],
    readySelector: '[role="tablist"][aria-label="HUD board"]',
    strict: true,
  });
}
