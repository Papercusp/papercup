import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_BUILD_TEST_CLASSES, SERVING_RUNTIMES } from './serving-runtimes';

const root = resolve(__dirname, '../../..');

describe('current-build execution route contract', () => {
  it('points every declared runnable route at maintained source and a real runtime', () => {
    for (const route of CURRENT_BUILD_TEST_CLASSES) {
      if (route.runtime) expect(SERVING_RUNTIMES[route.runtime]).toBeDefined();
      if (route.readiness === 'ready' || route.readiness === 'requires-prerequisites') {
        expect(route.routeFile, route.id).not.toBeNull();
        expect(existsSync(resolve(root, route.routeFile!)), route.id).toBe(true);
      }
      expect(route.prerequisites.length, route.id).toBeGreaterThan(0);
      expect(route.verification.length, route.id).toBeGreaterThan(20);
    }
  });

  it('does not promote a separate staging API port into isolated background or data ownership', () => {
    const api = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'operator-api')!;
    const background = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'background-federation')!;
    expect(api.runtime).toBe('staging-operator');
    expect(api.isolation).toMatch(/database and workspace are not isolated/i);
    expect(background.runtime).toBe('bg-host');
    expect(background.readiness).toBe('gap');
    expect(background.route).not.toContain('3170');
  });

  it('requires opt-in private data for mutable desktop tests and protects the release boundary', () => {
    const desktop = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'desktop-native')!;
    const script = readFileSync(resolve(root, desktop.routeFile!), 'utf8');
    expect(script).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(desktop.prerequisites.join(' ')).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'final-release')?.readiness)
      .toBe('release-only');
  });
});
