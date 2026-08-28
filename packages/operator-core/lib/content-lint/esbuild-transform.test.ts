/**
 * Tests for the esbuild transform detector (EI-5240).
 *
 * Fixtures are assembled as strings so the test module itself remains valid
 * TypeScript even when it describes source that esbuild must reject.
 */
import { describe, expect, it } from 'vitest';
import { findEsbuildTransformError } from './esbuild-transform';
import { esbuildTransformDetector } from './registry';

const DUPLICATE_DECLARATION = [
  'export function f(ownerId: string) {',
  '  const sessionId = ownerId ? "a" : null;',
  '  const sessionId = ownerId ? "b" : null;',
  '  return sessionId;',
  '}',
].join('\n');

const DUPLICATE_MODIFIER = ['export export const X = 1;'].join('\n');

const VALID_DECORATOR_SOURCE = [
  'function Inject(): ParameterDecorator { return () => {}; }',
  'class Controller {',
  '  handle(@Inject() value: string): string { return value; }',
  '}',
].join('\n');

describe('findEsbuildTransformError', () => {
  it('catches duplicate declarations that the bundle host refuses', async () => {
    const hit = await findEsbuildTransformError('routes/launch.ts', DUPLICATE_DECLARATION);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(3);
    expect(hit!.col).toBeGreaterThan(0);
    expect(hit!.reason).toContain('already been declared');
  });

  it('catches duplicate modifiers that TypeScript can accept but esbuild rejects', async () => {
    const hit = await findEsbuildTransformError('routes/launch.ts', DUPLICATE_MODIFIER);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(1);
    expect(hit!.reason).toContain('Unexpected');
  });

  it('does not resolve imports or perform typechecking', async () => {
    const unresolved = [
      "import { missing } from './does-not-exist';",
      'export const value: number = missing;',
    ].join('\n');
    expect(await findEsbuildTransformError('unresolved.ts', unresolved)).toBeNull();
  });

  it('accepts parameter decorators through the transform tsconfig', async () => {
    expect(await findEsbuildTransformError('controller.ts', VALID_DECORATOR_SOURCE)).toBeNull();
  });

  it('uses the appropriate transform loader for all guarded extensions', async () => {
    const source = 'export const value = 1;\n';
    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
      await expect(findEsbuildTransformError(`source${extension}`, source)).resolves.toBeNull();
    }
    // Unsupported paths are not sent to esbuild, even if their text is broken.
    await expect(findEsbuildTransformError('README.md', DUPLICATE_MODIFIER)).resolves.toBeNull();
  });
});

describe('esbuildTransformDetector', () => {
  it('matches supported source extensions and excludes retired/vendor/build trees', () => {
    expect(esbuildTransformDetector.matches('packages/x/source.ts')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.tsx')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.mts')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.cts')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.js')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.jsx')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.mjs')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/source.cjs')).toBe(true);
    expect(esbuildTransformDetector.matches('packages/x/node_modules/dependency/source.ts')).toBe(false);
    expect(esbuildTransformDetector.matches('packages/x/dist/source.ts')).toBe(false);
    expect(esbuildTransformDetector.matches('_retired/source.ts')).toBe(false);
    expect(esbuildTransformDetector.matches('README.md')).toBe(false);
  });

  it('formats the esbuild diagnostic for the content guard and dispatches the fixer', async () => {
    const message = await esbuildTransformDetector.detect('routes/launch.ts', DUPLICATE_MODIFIER);
    expect(message).toMatch(/esbuild transform error at line 1/i);
    expect(message).toContain('Unexpected');
    expect(esbuildTransformDetector.fixerRole).toBe('content-fixer');
  });
});
