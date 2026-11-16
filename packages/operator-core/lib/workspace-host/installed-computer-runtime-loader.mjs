/** ESM TypeScript for the isolated installed-computer runtime (Node 25).
 * Reuse tsx's resolver and ESM transform AFTER the strict source guard.
 * Full tsx can rewrite typeless .ts leaves through CommonJS before the guard;
 * native stripping alone retains imports used only in type annotations.
 */
import { register } from 'node:module';

let tsx;
export async function initialize(data) {
  tsx = await import('tsx/esm');
  await tsx.initialize(data);
}

export async function resolve(specifier, context, nextResolve) {
  // initialize() imports the resolver through this same hook chain.
  if (!tsx) return nextResolve(specifier, context);
  const result = await tsx.resolve(specifier, context, nextResolve);
  if (result.url.startsWith('file:')) {
    const path = new URL(result.url).pathname;
    // Defer the TypeScript format until load, where the guard inspects original
    // bytes first. Explicit CommonJS (.cts/.cjs) keeps its declared format.
    if (/\.(?:ts|mts)$/.test(path)) delete result.format;
    // The source graph uses TypeScript's ordinary JSON import syntax.
    if (path.endsWith('.json')) result.importAttributes = { ...context.importAttributes, type: 'json' };
  }
  return result;
}

export async function load(url, context, nextLoad) {
  // Transpile type-only imports as well as JSX. nextLoad lets the earlier
  // source guard inspect (or substitute) original bytes before the maintained
  // ESM transform; no CommonJS compilation precedes the source-identity fence.
  if (tsx && url.startsWith('file:') && /\.(?:ts|mts|tsx)$/.test(new URL(url).pathname)) {
    return tsx.load(url, { ...context, format: 'module' }, nextLoad);
  }
  return nextLoad(url, context);
}

if (!new URL(import.meta.url).searchParams.has('hooks')) {
  register(new URL('?hooks', import.meta.url), { data: {} });
}
