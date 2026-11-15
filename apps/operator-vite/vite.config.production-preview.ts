import { defineConfig, mergeConfig, type ConfigEnv, type Plugin, type UserConfig } from 'vite';
import base from './vite.config';

let armed = false;

const firstCssFailurePlugin: Plugin = {
  name: 'e2e-production-preview-first-css-failure',
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'POST' && pathname === '/__e2e/arm-first-css-failure') {
        armed = true;
        response.statusCode = 204;
        response.end();
        return;
      }

      if (armed && request.method === 'GET' && pathname.endsWith('.css')) {
        armed = false;
        response.statusCode = 503;
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end('/* first lazy HUD stylesheet failure */');
        return;
      }

      next();
    });
  },
};

// The base config is exported in callback form (`defineConfig(async () => …)`), and Vite's
// `mergeConfig` throws "Cannot merge config in form of callback" when handed a function — which
// stopped `vite preview` from starting and left the CSS-preload e2e unable to run at all
// (WI-6554700010048804). Resolve the base against the same ConfigEnv first; this also stays
// correct if the base is ever exported as a plain object or promise again.
export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const resolveBase = base as UserConfig | Promise<UserConfig> | ((env: ConfigEnv) => UserConfig | Promise<UserConfig>);
  const resolvedBase = typeof resolveBase === 'function' ? await resolveBase(env) : await resolveBase;
  return mergeConfig(resolvedBase, { plugins: [firstCssFailurePlugin] });
});
