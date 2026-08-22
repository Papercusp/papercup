#!/usr/bin/env node
// PostToolUse advisory for EI-19450114644493388: compile the COMPLETE .mdx file
// immediately after an edit, before git-sync can quarantine it minutes later.
//
// PreToolUse cannot do this correctly: Edit/MultiEdit expose only replacement
// fragments, and an MDX fragment is not a compilable document. This hook reads
// the resulting file from disk, uses the same @mdx-js/mdx + remark-gfm + js-yaml
// stack as packages/operator-core/lib/content-lint/mdx.ts, and reports the first
// real compile failure as additionalContext. It is advisory and fail-open: a
// multi-step edit may temporarily be invalid, and a detector failure must never
// turn a successful edit into a blocked one.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';
const MAX_BYTES = 2_000_000;
const REQUIRED_PACKAGES = [
  join('node_modules', '@mdx-js', 'mdx', 'package.json'),
  join('node_modules', 'remark-gfm', 'package.json'),
  join('node_modules', 'js-yaml', 'package.json'),
];

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const message = await nudgeFor(filePath);
    if (message) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
        }) + '\n',
      );
    }
  } catch {
    // Fail open: the commit-path detector remains the backstop.
  }
  return done();
}

function slash(path) {
  return path.split(/[\\/]/).join('/');
}

export function isCandidateFile(filePath, repoRoot) {
  if (!repoRoot) return false;
  const rel = slash(relative(repoRoot, resolve(filePath)));
  return (
    rel.startsWith(DOCS_PREFIX) &&
    rel.endsWith('.mdx') &&
    !rel.startsWith('_retired/') &&
    !rel.includes('/_retired/') &&
    !rel.includes('/node_modules/') &&
    !rel.includes('/dist/')
  );
}

export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (REQUIRED_PACKAGES.every((p) => exists(join(dir, p)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function blankFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return text;
  for (let i = 0; i <= end; i++) lines[i] = '';
  return lines.join('\n');
}

async function frontmatterError(text, yamlLoad) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  try {
    yamlLoad(lines.slice(1, end).join('\n'));
    return null;
  } catch (err) {
    const line = typeof err?.mark?.line === 'number' ? err.mark.line + 2 : null;
    const col = typeof err?.mark?.column === 'number' ? err.mark.column + 1 : null;
    const reason = `frontmatter YAML: ${(err?.reason ?? err?.message ?? String(err)).split('\n')[0]}`;
    return { line, col, reason };
  }
}

/**
 * Plain-JS mirror of content-lint/mdx.ts. The recurrence test compares this
 * against the real exported detector over failing and clean corpus cases.
 */
export async function findMdxCompileError(fileName, text, deps) {
  const fm = await frontmatterError(text, deps.yamlLoad);
  if (fm) return fm;
  try {
    await deps.compile(blankFrontmatter(text), {
      format: 'mdx',
      remarkPlugins: [deps.remarkGfm],
    });
    return null;
  } catch (err) {
    const start = (err?.place && 'start' in err.place ? err.place.start : err?.place) ?? {};
    const line = err?.line ?? start.line ?? null;
    const col = err?.column ?? start.column ?? null;
    const reason = (err?.reason ?? err?.message ?? String(err)).split('\n')[0];
    return { line, col, reason };
  }
}

export async function loadMdxDeps(repoRoot) {
  try {
    const req = createRequire(pathToFileURL(join(repoRoot, 'package.json')).href);
    const [mdx, gfm, yaml] = await Promise.all(
      ['@mdx-js/mdx', 'remark-gfm', 'js-yaml'].map(async (name) => {
        const entry = req.resolve(name);
        return import(pathToFileURL(entry).href);
      }),
    );
    const compile = mdx.compile;
    const remarkGfm = gfm.default ?? gfm;
    const yamlLoad = yaml.load ?? yaml.default?.load;
    if (typeof compile !== 'function' || typeof remarkGfm !== 'function' || typeof yamlLoad !== 'function') {
      return null;
    }
    return { compile, remarkGfm, yamlLoad };
  } catch {
    return null;
  }
}

export function formatNudge(relPath, hit) {
  const at = hit.line != null ? `line ${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : 'unknown position';
  return [
    'This MDX file does NOT COMPILE right now:',
    `  ${relPath} — ${at}`,
    `  ${hit.reason}`,
    '',
    'The docs build will fail, and git-sync will quarantine this file instead of',
    'committing it. Fix the MDX syntax before leaving the edit behind.',
    '',
    'A subtle cause is an inline code span split across a newline: a `{` at the',
    'start of the continuation line is parsed as an MDX expression. Keep inline',
    'code spans on one line, or use a fenced code block for multi-line content.',
    '',
    'This is advisory: the edit already succeeded, but the file is currently unsafe',
    'for git-sync and the docs build.',
  ].join('\n');
}

export async function nudgeFor(filePath, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const repoRoot = deps.repoRoot ?? findRepoRoot(filePath, exists);
  if (!repoRoot || !isCandidateFile(filePath, repoRoot)) return null;

  const sizeOf = deps.sizeOf ?? ((p) => statSync(p).size);
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let text;
  try {
    if (sizeOf(filePath) > MAX_BYTES) return null;
    text = readFile(filePath);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.length === 0) return null;

  const loader = deps.loadMdxDeps ?? loadMdxDeps;
  const mdx = await loader(repoRoot);
  if (!mdx) return null;
  try {
    const hit = await findMdxCompileError(filePath, text, mdx);
    if (!hit) return null;
    return formatNudge(slash(relative(repoRoot, resolve(filePath))), hit);
  } catch {
    return null;
  }
}

function readStdin(timeoutMs) {
  return new Promise((resolveInput) => {
    if (process.stdin.isTTY) return resolveInput('');
    let data = '';
    const timer = setTimeout(() => resolveInput(data), timeoutMs);
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolveInput(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolveInput(data);
    });
  });
}

function done() {
  process.exit(0);
}

async function selfTest() {
  const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
  const deps = repoRoot ? await loadMdxDeps(repoRoot) : null;
  if (!deps) {
    console.error('posttooluse-mdx-nudge --self-test: cannot resolve MDX dependencies');
    process.exit(1);
  }
  const broken = 'text `some:tool\n{ a:"b", c:{ d, e? } }` more text\n';
  const clean = 'text `some:tool { a: "b" }` more text\n';
  const brokenHit = await findMdxCompileError('broken.mdx', broken, deps);
  const cleanHit = await findMdxCompileError('clean.mdx', clean, deps);
  if (!brokenHit || cleanHit) {
    console.error('posttooluse-mdx-nudge --self-test: expected broken/clean outcomes diverged');
    process.exit(1);
  }
  console.log('posttooluse-mdx-nudge --self-test: all cases passed');
}
