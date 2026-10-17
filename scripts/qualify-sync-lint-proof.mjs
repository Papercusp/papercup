/** P037 source-only admission. No compiler, private PG, result key or source copy.
 * Walk literal imports transitively, including runtime implementations behind
 * declarations and workspace symlinks. Explicit proof roots cover spawned workers;
 * computed imports/assets still require explicit roots. Gitlink identity is checked
 * by the existing validator against the SUPERPROJECT pin, never nested HEAD.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { validateVerifierInputs } from './source-preview.mjs';

const integration = 'packages/operator-core/lib/release/sync-batch-lint-guards.integration.test.ts';
const supplemental = [
  'packages/operator-core/lib/release/sync-batch-lint-guards.compiler.test.ts',
  'packages/operator-core/lib/isolated-worker-pending-stage.test.ts',
  'packages/operator-core/test/private-http-workspace-preflight.ts',
  'packages/operator-core/vitest.config.ts', 'packages/operator-core/vitest.integration.config.ts',
  'scripts/lib/isolated-runtime-start.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
  'scripts/lib/task-cgroup-limits.mjs', 'scripts/lib/task-cgroup-limits.d.mts',
  'scripts/source-preview.mjs', 'scripts/test-files.mjs',
  'scripts/qualify-sync-lint-proof.mjs', 'scripts/qualify-sync-lint-proof.d.mts',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

export function syncLintProofRoots(repo) {
  const source = ts.createSourceFile(integration, readFileSync(join(repo, integration), 'utf8'),
    ts.ScriptTarget.Latest, true);
  let declared;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sourcePaths') {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer))
        throw new Error('P037 sourcePaths must remain an explicit array');
      declared = node.initializer.elements.map(element => {
        if (ts.isStringLiteral(element)) return element.text;
        if (ts.isIdentifier(element) && element.text === 'filePath') return integration;
        throw new Error('P037 sourcePaths contains an unmodelled computed input');
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declared) throw new Error('P037 maintained sourcePaths declaration missing');
  return [...new Set([integration, ...declared, ...supplemental])].sort();
}

export function collectVerifierInputClosure(repo, roots) {
  repo = realpathSync(repo);
  const paths = new Set(), queue = [], imports = [], unresolved = [], workingHashes = {};
  const contained = path => path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  const add = file => {
    const path = relative(repo, realpathSync(file)).split(sep).join('/');
    if (!contained(path) || path.split('/').includes('node_modules')) return false;
    if (!lstatSync(join(repo, path)).isFile()) throw new Error('input is not a regular file: ' + path);
    if (!paths.has(path)) {
      paths.add(path); queue.push(path);
      workingHashes[path] = hash(readFileSync(join(repo, path)));
    }
    return true;
  };
  for (const path of roots) {
    if (!path || !contained(path) || path.split('/').some(p => !p || p === '.' || p === '..')
      || !add(join(repo, path))) throw new Error('invalid verifier root: ' + path);
  }
  const config = join(repo, 'tsconfig.base.json');
  let options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, resolveJsonModule: true };
  if (existsSync(config)) {
    add(config);
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    options = { ...options, ...ts.convertCompilerOptionsFromJson(read.config.compilerOptions ?? {}, repo).options };
  }
  const cache = ts.createModuleResolutionCache(repo, path => path, options);
  const manifests = new Map();
  const runtimeExports = (spec, typed) => {
    if (spec.startsWith('.') || isAbsolute(spec)) return [];
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const subpath = '.' + spec.slice(name.length);
    let dir = dirname(realpathSync(typed));
    while (contained(relative(repo, dir))) {
      const manifestPath = join(dir, 'package.json');
      if (existsSync(manifestPath)) {
        if (!manifests.has(manifestPath)) manifests.set(manifestPath, JSON.parse(readFileSync(manifestPath, 'utf8')));
        const pkg = manifests.get(manifestPath);
        if (pkg.name === name) {
          add(manifestPath);
          let entry = pkg.exports, wildcard;
          if (entry && typeof entry === 'object' && Object.keys(entry).some(key => key.startsWith('.'))) {
            const key = Object.keys(entry).filter(key => key === subpath || key.includes('*')
              && subpath.startsWith(key.split('*')[0]) && subpath.endsWith(key.split('*')[1]))
              .sort((a, b) => Number(b === subpath) - Number(a === subpath)
                || b.split('*')[0].length - a.split('*')[0].length || b.length - a.length)[0];
            if (key?.includes('*')) wildcard = subpath.slice(key.split('*')[0].length,
              key.split('*')[1] ? -key.split('*')[1].length : undefined);
            entry = entry[key];
          } else if (subpath !== '.') entry = undefined;
          const targets = [];
          const visit = value => {
            if (typeof value === 'string') {
              const target = resolve(dir, wildcard === undefined ? value : value.replaceAll('*', wildcard));
              if (existsSync(target) && lstatSync(target).isFile()) targets.push(target);
            } else if (value && typeof value === 'object') {
              // Include each runtime condition conservatively. require.resolve
              // alone can choose require while the worker executes import.
              for (const [condition, branch] of Object.entries(value))
                if (condition !== 'types' && !condition.startsWith('types@')) visit(branch);
            }
          };
          visit(entry);
          if (!pkg.exports && subpath === '.') { visit(pkg.main); visit(pkg.module); }
          return targets;
        }
      }
      if (dir === repo) break;
      dir = dirname(dir);
    }
    return [];
  };
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i], absolute = join(repo, from);
    // Manifests affect workspace exports and must be admitted along with source.
    let dir = dirname(absolute);
    while (contained(relative(repo, dir))) {
      if (existsSync(join(dir, 'package.json'))) { add(join(dir, 'package.json')); break; }
      if (dir === repo) break;
      dir = dirname(dir);
    }
    const implementation = absolute.replace(/\.d\.mts$/, '.mjs').replace(/\.d\.cts$/, '.cjs')
      .replace(/\.d\.ts$/, '.js');
    if (implementation !== absolute && existsSync(implementation)) add(implementation);
    if (!/\.[cm]?[jt]sx?$/.test(from)) continue;
    const text = readFileSync(absolute, 'utf8');
    const require = createRequire(absolute);
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const spec = imported.fileName;
      if (isBuiltin(spec)) continue;
      const targets = new Set();
      const typed = ts.resolveModuleName(spec, absolute, options, ts.sys, cache).resolvedModule?.resolvedFileName;
      if (typed) {
        targets.add(typed);
        for (const target of runtimeExports(spec, typed)) targets.add(target);
      }
      // Types and Node's runtime export can be different files; retain BOTH.
      try { targets.add(require.resolve(spec)); } catch { /* TS also resolves source-only ESM imports. */ }
      if (!targets.size && (spec.startsWith('.') || spec.startsWith('@papercusp/')))
        unresolved.push({ from, spec });
      for (const target of targets) {
        const local = add(target);
        imports.push({ from, spec, path: relative(repo, realpathSync(target)).split(sep).join('/'), external: !local });
      }
    }
    // Configs hand setup/reporters to Vitest as paths rather than imports.
    const literals = /\bresolve\(\s*(?:__dirname|import\.meta\.dirname)\s*,\s*['"]([^'"\n]+)['"]\s*\)|\bnew\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    for (const match of text.matchAll(literals)) {
      const file = resolve(dirname(absolute), match[1] ?? match[2]);
      if (existsSync(file) && lstatSync(file).isFile()) add(file);
    }
  }
  for (const path of ['package.json', 'package-lock.json']) if (existsSync(join(repo, path))) add(join(repo, path));
  return { roots: [...new Set(roots)].sort(), paths: [...paths].sort(), imports, unresolved, workingHashes };
}

export async function qualifySyncLintProofInputs({ repo, roots = syncLintProofRoots(repo) }) {
  const headStart = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const closure = collectVerifierInputClosure(repo, roots);
  let refusal = null;
  try {
    if (closure.unresolved.length) throw new Error('unresolved local imports: ' + JSON.stringify(closure.unresolved));
    await validateVerifierInputs({ repo, ref: headStart, inputs: closure.paths });
  } catch (error) { refusal = String(error); }
  const headAfter = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const workingDrift = closure.paths.filter(path => {
    try { return hash(readFileSync(join(repo, path))) !== closure.workingHashes[path]; }
    catch { return true; }
  });
  if (headAfter !== headStart || workingDrift.length) refusal = 'source changed during qualification';
  return { schemaVersion: 'p037-source-admission-v1', measuredAt: new Date().toISOString(),
    headStart, headAfter, ...closure, workingDrift, refusal, qualification: refusal ? 'refused' : 'qualified' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--receipt') throw new Error('usage: node scripts/qualify-sync-lint-proof.mjs --receipt <new-json-path>');
  const receipt = await qualifySyncLintProofInputs({ repo: process.cwd() });
  writeFileSync(args[1], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('P037_CENSUS_SUMMARY ' + JSON.stringify({ qualification: receipt.qualification,
    headStart: receipt.headStart, headAfter: receipt.headAfter, roots: receipt.roots.length,
    paths: receipt.paths.length, unresolved: receipt.unresolved, workingDrift: receipt.workingDrift,
    refusal: receipt.refusal, receipt: resolve(args[1]) }));
  process.exitCode = receipt.qualification === 'qualified' ? 0 : 2;
}
