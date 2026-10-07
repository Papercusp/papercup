/** Real-host P-006 proof; test:file routes this file through the measured e2e project.
 * Opt in with PAPERCUSP_PERSONAL_DESKTOP_LIVE=1 and explicit ORG/CWS/HOST/INST/PROJECT/ZONE/OUT.
 * OUT must name a new artifact; the historical live-run.json is never overwritten.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { allowRealPgForLiveSuite } from '../testing/live-suite-real-pg';

const live = process.env.PAPERCUSP_PERSONAL_DESKTOP_LIVE === '1';
allowRealPgForLiveSuite(live);

describe.skipIf(!live)('personal desktop on a real workspace host', () => {
  let observed: Awaited<ReturnType<typeof import('./personal-desktop-live-driver').runPersonalDesktopLive>>;
  beforeAll(async () => {
    for (const name of ['ORG', 'CWS', 'HOST', 'INST', 'PROJECT', 'ZONE', 'OUT']) {
      if (!process.env[name]) throw new Error(`Missing live precondition: ${name}`);
    }
    if (existsSync(process.env.OUT!)) throw new Error('Live evidence output already exists; choose a fresh OUT');
    const { runPersonalDesktopLive } = await import('./personal-desktop-live-driver');
    observed = await runPersonalDesktopLive();
  }, 240_000);

  for (const assertion of [
    'personal-desktop-uid',
    'personal-desktop-home',
    'personal-desktop-takeover-input',
    'personal-desktop-reconnect',
    'personal-desktop-non-owner-refused',
  ]) {
    it(assertion, () => {
      expect(observed.assertions[assertion], 'The real driver must have measured this assertion').toBeDefined();
      expect(observed.assertions[assertion].passed).toBe(true);
    });
  }
});
