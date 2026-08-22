import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  capabilitySetsDiffer,
  consumerVitestArgs,
  diffManifestSet,
  isTemplateGymCliEntry,
  MOBILE_TEMPLATE_IDS,
  runGym,
  validateMobileCheckUnion,
} from './template-gym-runner';

describe('mobile template-gym policy', () => {
  it('pins the official five-template closure', () => {
    expect(MOBILE_TEMPLATE_IDS).toEqual([
      'papercusp-mobile-base',
      'papercusp-android-shell',
      'papercusp-android-app',
      'papercusp-iphone-shell',
      'papercusp-iphone-app',
    ]);
  });

  it('requires the complete Android and iPhone check unions', () => {
    expect(validateMobileCheckUnion('android')).toEqual([]);
    expect(validateMobileCheckUnion('iphone')).toEqual([]);
  });

  it('detects missing, changed, and extra consumer manifest copies', () => {
    const canonical = new Map([
      ['base', 'base-v1'],
      ['shell', 'shell-v1'],
      ['app', 'app-v1'],
    ]);
    const consumer = new Map([
      ['base', 'base-v1'],
      ['shell', 'shell-edited'],
      ['extra', 'unexpected'],
    ]);
    expect(diffManifestSet(canonical, consumer)).toEqual({
      missing: ['app'],
      changed: ['shell'],
      extra: ['extra'],
    });
  });

  it('treats optional-capability diversity as set diversity, not ordering', () => {
    expect(capabilitySetsDiffer(['push', 'camera'], ['camera', 'push'])).toBe(false);
    expect(capabilitySetsDiffer(['push', 'camera'], ['media-playback'])).toBe(true);
  });

  it('restricts consumer Vitest discovery to the canonical template tree', () => {
    const files = [
      'templates/papercusp-mobile-base/checks/mobile-base-contract.test.ts',
      'templates/papercusp-android-shell/checks/android-shell-contract.test.ts',
    ];
    expect(consumerVitestArgs(files)).toEqual([
      'run',
      '--dir',
      'templates',
      ...files,
    ]);
  });

  it('reports missing mobile consumer configs without throwing out of a packaged sidecar boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'template-gym-missing-consumers-'));
    try {
      const summary = await runGym({
        papercuspMobileRoot: join(root, 'missing-papercusp-mobile'),
        sidestageMobileRoot: join(root, 'missing-sidestage-mobile'),
        legs: ['mobile-capability-diversity'],
        summaryJson: join(root, 'summary.json'),
      });

      expect(summary.green).toBe(false);
      expect(summary.legs).toHaveLength(1);
      expect(summary.legs[0]).toMatchObject({ leg: 'mobile-capability-diversity', ok: false });
      expect(summary.legs[0]?.detail).toContain('papercusp-android');
      expect(summary.legs[0]?.detail).toContain('sidestage-iphone');
      expect(summary.legs[0]?.detail).toContain('ENOENT');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the CLI only when the process entrypoint is the template-gym runner itself', () => {
    expect(
      isTemplateGymCliEntry(
        '/repo/packages/operator-core/lib/harness/routines/template-gym-runner.ts',
        '/repo/packages/operator-core/lib/harness/routines/template-gym-runner.ts',
      ),
    ).toBe(true);
    expect(isTemplateGymCliEntry('/repo/dist/template-gym-runner.js', '/repo/dist/template-gym-runner.js')).toBe(
      true,
    );
  });

  it('does not run the CLI when bundling makes argv and import.meta.url both name serve.mjs', () => {
    expect(
      isTemplateGymCliEntry(
        '/usr/lib/Papercusp GUI/sidecar/serve.mjs',
        '/usr/lib/Papercusp GUI/sidecar/serve.mjs',
      ),
    ).toBe(false);
    expect(isTemplateGymCliEntry('/repo/node_modules/.bin/vitest', '/repo/template-gym-runner.ts')).toBe(false);
    expect(isTemplateGymCliEntry(undefined, '/repo/template-gym-runner.ts')).toBe(false);
  });
});
