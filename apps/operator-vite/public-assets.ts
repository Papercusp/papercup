import { cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { selectDocsSwapLeftovers } from './dev-dist-prune';

/** Internal docs have their own host-docs mount and packaged payload. */
function includePublicAsset(root: string, source: string): boolean {
  const [parent, name] = relative(root, source).split(sep);
  return parent !== 'internal' || (name !== 'docs'
    && selectDocsSwapLeftovers([name ?? '']).length === 0);
}

/**
 * Vite's built-in public copy is synchronous and unfiltered. It blocked a
 * staging build in pagefind fragment I/O before any render progress could run.
 * Keep Vite's publicDir for dev/URL handling; replace only its build-time copy
 * with Node's asynchronous copy, pruning separately served docs before descent.
 */
export function publicAssetsPlugin(): Plugin {
  let config: ResolvedConfig;
  let enabled = true;
  return {
    name: 'papercusp-public-assets',
    apply: 'build',
    config(userConfig) {
      enabled = userConfig.build?.copyPublicDir !== false;
      return { build: { copyPublicDir: false } };
    },
    configResolved(resolved) { config = resolved; },
    // Rolldown's renderStart is synchronous: an async handler there is NOT
    // awaited. generateBundle awaits copying and propagates asset failures,
    // after outDir preparation but before emitted files overwrite public names.
    generateBundle: {
      order: 'pre',
      async handler() {
        if (!enabled || !config.build.write || !config.publicDir || !existsSync(config.publicDir)) return;
        const started = performance.now();
        config.logger.info('[vite-public-assets] copying SPA public assets (internal docs served separately)');
        await cp(config.publicDir, resolve(config.root, config.build.outDir), {
          recursive: true,
          dereference: true,
          filter: source => includePublicAsset(config.publicDir, source),
        });
        config.logger.info(`[vite-public-assets] copy completed in ${Math.round(performance.now() - started)}ms`);
      },
    },
  };
}
