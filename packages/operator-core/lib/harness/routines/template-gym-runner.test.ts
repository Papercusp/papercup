import { describe, expect, it } from 'vitest';
import {
  capabilitySetsDiffer,
  diffManifestSet,
  isTemplateGymCliEntry,
  MOBILE_TEMPLATE_IDS,
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
