import { describe, expect, it } from 'vitest';
import rootConfig from './vitest.config.ts';

describe('repository-root Vitest discovery', () => {
  it('excludes Papercusp scratch and retired trees from direct runs', () => {
    const excludes = (rootConfig.test as { exclude?: string[] } | undefined)?.exclude ?? [];

    expect(excludes).toEqual(
      expect.arrayContaining(['**/.papercusp/**', '**/_retired/**']),
    );
  });
});
