import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Cache location is also needed by the database test bootstrap. Keep it free
// of browser installation and CommonJS preflight dependencies.
export function browserCachePath(env = process.env) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === '0') return join(repoRoot, 'node_modules', 'playwright-core', '.local-browsers');
  return resolve(configured || join(env.HOME || process.cwd(), '.cache', 'ms-playwright'));
}

export function withPlaywrightBrowserCache(env = process.env) {
  if (typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' && env.PLAYWRIGHT_BROWSERS_PATH.trim()) return env;
  return { ...env, PLAYWRIGHT_BROWSERS_PATH: browserCachePath({ ...env, PLAYWRIGHT_BROWSERS_PATH: undefined }) };
}
