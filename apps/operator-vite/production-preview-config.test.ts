// @vitest-environment node
import type { ConfigEnv } from 'vite';
import { expect, it, vi } from 'vitest';

const resolveBase = vi.hoisted(() => vi.fn(async (env: ConfigEnv) => ({
  base: `/${env.mode}/`,
  plugins: [{ name: 'base-plugin' }],
})));

vi.mock('./vite.config', () => ({ default: resolveBase }));

it('resolves the async base with the preview environment and keeps both plugins', async () => {
  const env: ConfigEnv = { command: 'serve', mode: 'production', isPreview: true };
  const config = import('./vite.config.production-preview').then(({ default: preview }) => preview(env));

  await expect(config).resolves.toMatchObject({
    base: '/production/',
    plugins: [
      { name: 'base-plugin' },
      { name: 'e2e-production-preview-first-css-failure' },
    ],
  });
  expect(resolveBase).toHaveBeenCalledWith(env);
});
