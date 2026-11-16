/** Native TypeScript for the isolated installed-computer runtime (Node 25).
 * Reuse tsx's extension/alias resolver, while Node executes original source.
 * Full tsx rewrites typeless .ts leaves through CommonJS before the strict
 * committed-source guard judges them. No guard or package-type changes here.
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
    // Preserve native detection/type stripping after the source guard. Explicit
    // CommonJS (.cts/.cjs) keeps its declared format and strict guard.
    if (/\.(?:ts|mts)$/.test(path)) delete result.format;
    // The source graph uses TypeScript's ordinary JSON import syntax.
    if (path.endsWith('.json')) result.importAttributes = { ...context.importAttributes, type: 'json' };
  }
  return result;
}

export async function load(url, context, nextLoad) {
  // Node strips TypeScript but cannot compile JSX. Keep tsx's ESM transform
  // only for .tsx: nextLoad still lets the earlier source guard inspect (or
  // substitute) the original source before tsx transforms the returned bytes.
  if (tsx && url.startsWith('file:') && new URL(url).pathname.endsWith('.tsx')) {
    return tsx.load(url, { ...context, format: 'module' }, nextLoad);
  }
  return nextLoad(url, context);
}

if (!new URL(import.meta.url).searchParams.has('hooks')) {
  register(new URL('?hooks', import.meta.url), { data: {} });
}
