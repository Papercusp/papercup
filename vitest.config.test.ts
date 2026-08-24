import { describe, expect, it } from 'vitest';
import rootConfig, { ROOT_VITEST_TSCONFIG_PROJECTS } from './vitest.config.ts';

describe('repository-root Vitest discovery', () => {
  it('excludes Papercusp scratch and retired trees from direct runs', () => {
    const excludes = (rootConfig.test as { exclude?: string[] } | undefined)?.exclude ?? [];

    expect(excludes).toEqual(
      expect.arrayContaining(['**/.papercusp/**', '**/_retired/**']),
    );
  });

  it('loads the operator workspace aliases for direct root runs', () => {
    expect(ROOT_VITEST_TSCONFIG_PROJECTS).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/[/\\]apps[/\\]operator[/\\]tsconfig\.json$/),
      ]),
    );
    expect(rootConfig.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'vite-tsconfig-paths' })]),
    );
  });
});
