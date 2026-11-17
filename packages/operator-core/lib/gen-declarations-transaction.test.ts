import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { check, compileDeclarationsIncrementally, generate, includeEnrolledImporters, runDeclarationCli } from '../../../scripts/gen-declarations.ts';
import * as ts from 'typescript';

type Compile = (repoRoot: string, config: string, outDir: string) => void;

function fixture(): { root: string; declaration: string } {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-gen-declarations-test-'));
  writeFileSync(join(root, 'input.mjs'), 'export const answer = 42;\n');
  writeFileSync(
    join(root, 'tsconfig.declarations.json'),
    JSON.stringify({ files: ['input.mjs'] }),
  );
  return { root, declaration: join(root, 'input.d.mts') };
}

function withFixture(run: (paths: { root: string; declaration: string }) => void): void {
  const paths = fixture();
  try {
    run(paths);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

describe('declaration compiler resumption', () => {
  it('compiles in the public tsx CLI CommonJS format', () => {
    // The test runner deliberately refuses edited CJS entry points. Exercise
    // tsx's actual transform grammar without disabling that source guard.
    const source = readFileSync(fileURLToPath(new URL('../../../scripts/gen-declarations.ts', import.meta.url)), 'utf8');
    expect(() => transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' })).not.toThrow();
  });

  it('resumes incomplete native work, invalidates changed dependencies, and retains cached diagnostics', async () => {
    const { root, declaration } = fixture();
    try {
      const config = join(root, 'tsconfig.declarations.json');
      writeFileSync(config, JSON.stringify({
        compilerOptions: { allowJs: true, declaration: true, emitDeclarationOnly: true,
          rootDir: '.', outDir: '.', types: [], skipLibCheck: true,
          module: 'esnext', moduleResolution: 'bundler', target: 'es2022' },
        files: ['input.mjs'],
      }));
      writeFileSync(join(root, 'dependency.ts'), 'export const value = 42;\n');
      writeFileSync(join(root, 'input.mjs'), "export { value as answer } from './dependency.js';\n");
      writeFileSync(declaration, '// last published bytes\n');
      const out = join(root, 'isolated');
      const cacheRoot = join(root, 'cache');
      let checkedBeforeCancel = 0;
      await expect(compileDeclarationsIncrementally(root, config, out, {
        cacheRoot, onProgress: (checked) => { checkedBeforeCancel = checked; }, cancellationToken: {
          isCancellationRequested: () => checkedBeforeCancel > 0,
          throwIfCancellationRequested() {
            if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
          },
        },
      })).rejects.toThrow('slice incomplete');
      expect(checkedBeforeCancel).toBeGreaterThan(0);
      const key = readdirSync(cacheRoot).find((name) => name !== 'locks')!;
      expect(existsSync(join(cacheRoot, key, 'compiler.tsbuildinfo'))).toBe(true);
      expect(readFileSync(declaration, 'utf8')).toBe('// last published bytes\n');
      expect(existsSync(join(out, 'input.d.mts'))).toBe(false);

      await compileDeclarationsIncrementally(root, config, out, { cacheRoot });
      expect(readFileSync(join(out, 'input.d.mts'), 'utf8')).toContain('value as answer');
      writeFileSync(join(root, 'dependency.ts'), 'export const value: number = "wrong";\n');
      await expect(compileDeclarationsIncrementally(root, config, out, { cacheRoot }))
        .rejects.toThrow('not assignable to type');
      // A cached failure must fail again; an empty affected set is not success.
      await expect(compileDeclarationsIncrementally(root, config, out, { cacheRoot }))
        .rejects.toThrow('not assignable to type');
      writeFileSync(join(root, 'dependency.ts'), 'export const value = "fixed";\n');
      await compileDeclarationsIncrementally(root, config, out, { cacheRoot });
      expect(readFileSync(declaration, 'utf8')).toBe('// last published bytes\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('gen:declarations transactional publish', () => {
  it('leaves existing declarations untouched when compilation fails after partial output', () => {
    withFixture(({ root, declaration }) => {
      const original = '// the last good declaration\n';
      writeFileSync(declaration, original);

      const compile: Compile = (_repoRoot, _config, outDir) => {
        expect(outDir).not.toBe(root);
        writeFileSync(join(outDir, 'input.d.mts'), 'partial compiler output\n');
        writeFileSync(join(outDir, 'transitive.d.mts'), 'stray compiler output\n');
        throw new Error('synthetic compiler failure');
      };

      expect(() => generate(root, 'tsconfig.declarations.json', compile)).toThrow(
        'synthetic compiler failure',
      );
      expect(readFileSync(declaration, 'utf8')).toBe(original);
      expect(existsSync(join(root, 'transitive.d.mts'))).toBe(false);
    });
  });

  it('publishes only declared outputs after a successful isolated compile', () => {
    withFixture(({ root, declaration }) => {
      const compile: Compile = (_repoRoot, _config, outDir) => {
        writeFileSync(join(outDir, 'input.d.mts'), 'export declare const answer: 42;\n');
        writeFileSync(join(outDir, 'transitive.d.mts'), 'export declare const stray: true;\n');
      };

      generate(root, 'tsconfig.declarations.json', compile);

      const generated = readFileSync(declaration, 'utf8');
      expect(generated).toContain('// GENERATED by `npm run gen:declarations` from input.mjs.');
      expect(generated).toContain('export declare const answer: 42;');
      expect(existsSync(join(root, 'transitive.d.mts'))).toBe(false);
    });
  });

  it.each([
    { form: 'equals', args: ['--files=input.mjs'] },
    { form: 'spaced', args: ['--files', 'input.mjs'] },
  ])('publishes only the selected enrolled output while preserving every sibling ($form CLI)', ({ args }) => {
    withFixture(({ root, declaration }) => {
      const siblingSource = join(root, 'sibling.mjs');
      const siblingDeclaration = join(root, 'sibling.d.mts');
      writeFileSync(siblingSource, 'export const sibling = true;\n');
      writeFileSync(siblingDeclaration, '// sibling last-good bytes\n');
      writeFileSync(
        join(root, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['input.mjs', 'sibling.mjs'] }),
      );

      const compile: Compile = (_repoRoot, _config, outDir) => {
        writeFileSync(join(outDir, 'input.d.mts'), 'export declare const answer: 42;\n');
        writeFileSync(join(outDir, 'sibling.d.mts'), 'export declare const sibling: true;\n');
      };

      runDeclarationCli(args, {
        generateImpl: (selection) => generate(root, 'tsconfig.declarations.json', compile, selection),
      });

      expect(readFileSync(declaration, 'utf8')).toContain('export declare const answer: 42;');
      expect(readFileSync(siblingDeclaration, 'utf8')).toBe('// sibling last-good bytes\n');
    });
  });

  it('checks only selected enrolled outputs through the scoped --check CLI', () => {
    withFixture(({ root, declaration }) => {
      const siblingSource = join(root, 'sibling.mjs');
      const siblingDeclaration = join(root, 'sibling.d.mts');
      writeFileSync(siblingSource, 'export const sibling = true;\n');
      writeFileSync(
        join(root, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['input.mjs', 'sibling.mjs'] }),
      );
      execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '--', 'input.mjs', 'sibling.mjs'], { cwd: root, stdio: 'ignore' });

      const compile: Compile = (_repoRoot, _config, outDir) => {
        writeFileSync(join(outDir, 'input.d.mts'), 'export declare const answer: 42;\n');
        writeFileSync(join(outDir, 'sibling.d.mts'), 'export declare const sibling: true;\n');
      };
      generate(root, 'tsconfig.declarations.json', compile);
      writeFileSync(siblingDeclaration, '// stale sibling declaration\n');

      expect(() => runDeclarationCli(['--check', '--files=input.mjs'], {
        generateImpl: vi.fn(),
        checkImpl: (selection) => check(root, 'tsconfig.declarations.json', selection, compile),
      })).not.toThrow();
      expect(readFileSync(declaration, 'utf8')).toContain('export declare const answer: 42;');
      expect(readFileSync(siblingDeclaration, 'utf8')).toBe('// stale sibling declaration\n');
    });
  });

  it('checks full-root literal inference against selected cold and warm compiler output', () => {
    withFixture(({ root, declaration }) => {
      writeFileSync(join(root, 'input.mjs'),
        'export function answer(n) { if (n === 1) return "pending"; if (n === 2) return "completed"; if (n === 3) return "cancelled"; return "clear"; }\n');
      writeFileSync(join(root, 'seed.mjs'),
        'export function seed(n) { if (n === 1) return "clear"; if (n === 2) return "cancelled"; if (n === 3) return "completed"; return "pending"; }\n');
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
        compilerOptions: {
          allowJs: true, declaration: true, emitDeclarationOnly: true,
          rootDir: '.', outDir: '.', types: [], skipLibCheck: true,
          module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
        },
        files: ['seed.mjs', 'input.mjs'],
      }));
      execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '--', 'input.mjs', 'seed.mjs'], { cwd: root, stdio: 'ignore' });
      generate(root, 'tsconfig.declarations.json');
      const published = readFileSync(declaration, 'utf8');
      expect(published).toContain('"clear" | "cancelled" | "completed" | "pending"');
      expect(() => check(root, 'tsconfig.declarations.json', ['input.mjs'])).not.toThrow();
      expect(() => check(root, 'tsconfig.declarations.json', ['input.mjs'])).not.toThrow();
      expect(readFileSync(declaration, 'utf8')).toBe(published);
    });
  }, 60_000);

  it('accepts compiler literal-union permutations without changing the published declaration', () => {
    withFixture(({ root, declaration }) => {
      execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '--', 'input.mjs'], { cwd: root, stdio: 'ignore' });
      const emit = (members: string, edge: string): Compile => (_root, _config, out) => {
        writeFileSync(join(out, 'input.d.mts'),
          `#!/usr/bin/env node\n/** Keep provenance. */\nexport declare const answer: ${members};\nexport type Edge = ${edge};\n`);
      };
      generate(root, 'tsconfig.declarations.json', emit(
        '"pending" | "completed" | "cancelled" | "clear"', '-1 | 0 | null | "a|b"',
      ));
      const published = readFileSync(declaration, 'utf8');
      for (const [members, edge] of [
        ['"cancelled" | "pending" | "completed" | "clear"', 'null | "a|b" | 0 | -1'],
        ['"clear" | "cancelled" | "completed" | "pending"', '"a|b" | -1 | null | 0'],
      ]) {
        expect(() => check(root, 'tsconfig.declarations.json', undefined, emit(members, edge))).not.toThrow();
      }
      expect(readFileSync(declaration, 'utf8')).toBe(published);
    });
  });

  it.each([
    'export declare const answer: "cancelled" | "pending" | "completed" | "clear" | "late";\n',
    'export declare const answer: "cancelled" | "pending" | "completed";\n',
    '/** Changed documentation. */\nexport declare const answer: "cancelled" | "pending" | "completed" | "clear";\n',
  ])('still rejects real declaration drift alongside reordered literal unions: %s', (changed) => {
    withFixture(({ root, declaration }) => {
      const emit = (text: string): Compile => (_root, _config, out) => {
        writeFileSync(join(out, 'input.d.mts'), text);
      };
      generate(root, 'tsconfig.declarations.json', emit(
        'export declare const answer: "pending" | "completed" | "cancelled" | "clear";\n',
      ));
      const published = readFileSync(declaration, 'utf8');
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('stale declaration exit'); });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => check(root, 'tsconfig.declarations.json', undefined, emit(changed)))
          .toThrow('stale declaration exit');
        expect(exit).toHaveBeenCalledWith(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('stale declaration(s)'));
        expect(readFileSync(declaration, 'utf8')).toBe(published);
      } finally {
        exit.mockRestore();
        error.mockRestore();
      }
    });
  });

  it('refuses an unenrolled selection before compiling or changing an existing declaration', () => {
    withFixture(({ root, declaration }) => {
      const original = '// existing declaration\n';
      let compiled = false;
      writeFileSync(declaration, original);
      const compile: Compile = () => {
        compiled = true;
      };

      expect(() =>
        generate(root, 'tsconfig.declarations.json', compile, ['not-enrolled.mjs']),
      ).toThrow('cannot generate undeclared input: not-enrolled.mjs');
      expect(compiled).toBe(false);
      expect(readFileSync(declaration, 'utf8')).toBe(original);
    });
  });

  it('compiles only selected roots with the pinned real compiler and keeps reachable imports', () => {
    withFixture(({ root, declaration }) => {
      writeFileSync(join(root, 'input.mjs'), "import { value } from './dependency.mjs';\nexport const answer = value;\n");
      writeFileSync(join(root, 'dependency.mjs'), 'export const value = 42;\n');
      writeFileSync(join(root, 'sibling.mjs'), 'export const invalid = ;\n');
      writeFileSync(join(root, 'sibling.d.mts'), '// last good sibling\n');
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
        compilerOptions: {
          allowJs: true, declaration: true, emitDeclarationOnly: true,
          rootDir: '.', outDir: '.', types: [], skipLibCheck: true,
          module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
        },
        files: ['input.mjs', 'sibling.mjs'],
      }));

      generate(root, 'tsconfig.declarations.json', undefined, ['input.mjs']);
      const generated = readFileSync(declaration, 'utf8');
      expect(generated).toContain('answer: 42');
      expect(readFileSync(join(root, 'sibling.d.mts'), 'utf8')).toBe('// last good sibling\n');
      expect(existsSync(join(root, 'dependency.d.mts'))).toBe(false);

      // Full generation still diagnoses the unrelated broken root and cannot
      // replace the last good selected output with a partial compile.
      expect(() => generate(root)).toThrow(/tsc failed/);
      expect(readFileSync(declaration, 'utf8')).toBe(generated);
    });
  }, 30_000);

  it.each(['implicit', 'inherited-explicit'])(
    'selected real compiler preserves original ambient type roots: %s', mode => {
      withFixture(({ root, declaration }) => {
        const ambient = join(root, mode === 'implicit' ? 'node_modules/@types' : 'ambient');
        mkdirSync(join(ambient, 'fixture-original'), { recursive: true });
        writeFileSync(join(ambient, 'fixture-original/index.d.ts'), 'type OriginalAmbient = { answer: 42 };\n');
        writeFileSync(join(root, 'input.mjs'), '/** @type {OriginalAmbient} */\nexport const answer = { answer: 42 };\n');
        writeFileSync(join(root, 'sibling.mjs'), 'export const sibling = true;\n');
        writeFileSync(join(root, 'sibling.d.mts'), '// preserve sibling\n');
        if (mode === 'inherited-explicit') {
          mkdirSync(join(root, 'config'));
          writeFileSync(join(root, 'config/base.json'), JSON.stringify({ compilerOptions: { typeRoots: ['../ambient'] } }));
        }
        writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
          ...(mode === 'inherited-explicit' ? { extends: './config/base.json' } : {}),
          compilerOptions: { allowJs: true, declaration: true, emitDeclarationOnly: true,
            rootDir: '.', outDir: '.', types: ['fixture-original'], skipLibCheck: true,
            module: 'esnext', moduleResolution: 'bundler', target: 'es2022' },
          files: ['input.mjs', 'sibling.mjs'],
        }));
        generate(root, 'tsconfig.declarations.json', undefined, ['input.mjs']);
        expect(readFileSync(declaration, 'utf8')).toContain('answer: OriginalAmbient');
        expect(readFileSync(join(root, 'sibling.d.mts'), 'utf8')).toBe('// preserve sibling\n');
      });
    }, 30_000);

  it('includes transitive and JSDoc importers while leaving independent roots out', () => {
    withFixture(({ root }) => {
      writeFileSync(join(root, 'input.d.mts'), 'export declare const answer: 42;\n');
      writeFileSync(join(root, 'middle.mjs'), "export { answer } from './input.mjs';\n");
      writeFileSync(join(root, 'importer.mjs'), "export { answer } from './middle.mjs';\n");
      writeFileSync(join(root, 'doc-importer.mjs'), '/** @type {typeof import("./middle.mjs").answer} */\nexport const answer = 42;\n');
      writeFileSync(join(root, 'independent.mjs'), 'export const independent = true;\n');
      const enrolled = ['input.mjs', 'importer.mjs', 'doc-importer.mjs', 'independent.mjs'];
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
        compilerOptions: { allowJs: true, types: [], module: 'esnext', moduleResolution: 'bundler' },
        files: enrolled,
      }));

      expect(includeEnrolledImporters(root, 'tsconfig.declarations.json', enrolled, ['input.mjs']))
        .toEqual(['input.mjs', 'importer.mjs', 'doc-importer.mjs']);
    });
  });

  it('keeps selection narrow when an external declaration has an unresolved optional import', () => {
    withFixture(({ root }) => {
      const vendor = join(root, 'node_modules/vendor');
      mkdirSync(vendor, { recursive: true });
      writeFileSync(join(vendor, 'package.json'), JSON.stringify({ name: 'vendor', types: 'index.d.ts' }));
      writeFileSync(join(vendor, 'index.d.ts'),
        "export type { Optional } from './missing-optional';\nexport interface Value { answer: number }\n");
      writeFileSync(join(root, 'importer.mjs'), "export { answer } from './input.mjs';\n");
      writeFileSync(join(root, 'independent.mjs'),
        '/** @type {import("vendor").Value} */\nexport const independent = { answer: 1 };\n');
      const enrolled = ['input.mjs', 'importer.mjs', 'independent.mjs'];
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
        compilerOptions: { allowJs: true, types: [], module: 'esnext', moduleResolution: 'bundler' },
        files: enrolled,
      }));

      expect(includeEnrolledImporters(root, 'tsconfig.declarations.json', enrolled, ['input.mjs']))
        .toEqual(['input.mjs', 'importer.mjs']);
    });
  });

  it('retains full generation when a repository import cannot be resolved', () => {
    withFixture(({ root }) => {
      writeFileSync(join(root, 'independent.mjs'), "export { unknown } from './missing-local.mjs';\n");
      const enrolled = ['input.mjs', 'independent.mjs'];
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({
        compilerOptions: { allowJs: true, types: [], module: 'esnext', moduleResolution: 'bundler' },
        files: enrolled,
      }));

      expect(includeEnrolledImporters(root, 'tsconfig.declarations.json', enrolled, ['input.mjs']))
        .toEqual(enrolled);
    });
  });
});

describe('gen:declarations CLI validation', () => {
  it.each([
    { args: ['--files'], error: /requires a non-empty/ },
    { args: ['--files='], error: /requires a non-empty/ },
    { args: ['--files', '--check'], error: /requires a non-empty/ },
    { args: ['--files=input.mjs,'], error: /requires a non-empty/ },
    { args: ['--files', ',input.mjs'], error: /requires a non-empty/ },
    { args: ['--file=input.mjs'], error: /unknown declaration-generator argument/ },
    { args: ['--files=input.mjs', 'unexpected'], error: /unknown declaration-generator argument/ },
    { args: ['--check', '--unknown'], error: /unknown declaration-generator argument/ },
    { args: ['--include-importers'], error: /requires `--files`/ },
  ])('refuses $args before either operation can change output', ({ args, error }) => {
    const generateImpl = vi.fn();
    const checkImpl = vi.fn();
    expect(() => runDeclarationCli(args, { generateImpl, checkImpl })).toThrow(error);
    expect(generateImpl).not.toHaveBeenCalled();
    expect(checkImpl).not.toHaveBeenCalled();
  });

  it('preserves the explicit full-generation and check modes', () => {
    const generateImpl = vi.fn();
    const checkImpl = vi.fn();
    runDeclarationCli([], { generateImpl, checkImpl });
    expect(generateImpl).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(checkImpl).not.toHaveBeenCalled();
    runDeclarationCli(['--check'], { generateImpl, checkImpl });
    expect(checkImpl).toHaveBeenCalledOnce();
    expect(generateImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { form: 'equals', args: ['--check', '--files=input.mjs'] },
    { form: 'spaced', args: ['--files', 'input.mjs', '--check'] },
  ])('routes a scoped check selection through the check operation ($form form)', ({ args }) => {
    const generateImpl = vi.fn();
    const checkImpl = vi.fn();
    runDeclarationCli(args, { generateImpl, checkImpl });
    expect(checkImpl).toHaveBeenCalledExactlyOnceWith(['input.mjs']);
    expect(generateImpl).not.toHaveBeenCalled();
  });

  it('combines repeated selectors across both supported forms', () => {
    const generateImpl = vi.fn();
    runDeclarationCli(['--files=input.mjs,sibling.mjs', '--files', 'another.mjs'], { generateImpl });
    expect(generateImpl).toHaveBeenCalledExactlyOnceWith(['input.mjs', 'sibling.mjs', 'another.mjs']);
  });

  it.each([false, true])('routes importer expansion only when explicitly requested (check=%s)', (checkOnly) => {
    const generateImpl = vi.fn();
    const checkImpl = vi.fn();
    runDeclarationCli(['--files=input.mjs', '--include-importers', ...(checkOnly ? ['--check'] : [])], {
      generateImpl, checkImpl,
    });
    expect(checkOnly ? checkImpl : generateImpl).toHaveBeenCalledExactlyOnceWith(['input.mjs'], true);
    expect(checkOnly ? generateImpl : checkImpl).not.toHaveBeenCalled();
  });
});
