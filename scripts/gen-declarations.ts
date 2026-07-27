/**
 * Generate `.d.mts` declarations for the plain-JS `.mjs` modules listed in
 * `tsconfig.declarations.json` (WI-6394). See that file for WHY these are
 * generated rather than hand-written.
 *
 *   npm run gen:declarations         # emit in place
 *   npm run gen:declarations:check   # verify the committed files are current
 *
 * `--check` is what CI and the vitest drift test call: it regenerates into a temp
 * directory and compares, so it never writes into the working tree. That matters
 * here beyond politeness — this repo has ONE checkout shared by the whole fleet,
 * so a check that wrote in place could clobber a peer mid-edit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'tsconfig.declarations.json';
const TSC = join(REPO_ROOT, 'node_modules/.bin/tsc');

/** The `.mjs` inputs, read from the config so the two can never disagree. */
function inputs(): string[] {
  // The config carries `//` comments (tsc accepts JSONC), so strip them before parsing.
  const raw = readFileSync(join(REPO_ROOT, CONFIG), 'utf8');
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(stripped) as { files?: string[] };
  if (!parsed.files?.length) throw new Error(`${CONFIG} declares no \`files\``);
  return parsed.files;
}

/** `scripts/foo.mjs` -> `scripts/foo.d.mts` */
function declarationFor(mjs: string): string {
  return mjs.replace(/\.mjs$/, '.d.mts');
}

function runTsc(outDir?: string): void {
  const args = ['-p', CONFIG, ...(outDir ? ['--outDir', outDir] : [])];
  try {
    execFileSync(TSC, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // Surface tsc's own diagnostics — a bare "Command failed" hides what broke.
    throw new Error(`tsc failed:\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`);
  }
}

function generate(): void {
  // Delete existing declarations FIRST. Once a `.d.mts` exists, an importing
  // sibling's `./x.mjs` specifier resolves to the DECLARATION rather than the JS,
  // which makes it a compilation input — and tsc refuses to overwrite its own
  // input (TS5055). Without this, generation succeeds exactly once on a clean
  // tree and fails for everyone afterwards.
  for (const mjs of inputs()) {
    const dts = join(REPO_ROOT, declarationFor(mjs));
    if (existsSync(dts)) unlinkSync(dts);
  }
  runTsc();
  console.log(`✓ gen:declarations: emitted ${inputs().length} declaration file(s)`);
}

function check(): void {
  const out = mkdtempSync(join(tmpdir(), 'papercusp-decl-check-'));
  try {
    runTsc(out);

    const stale: string[] = [];
    const missing: string[] = [];
    for (const mjs of inputs()) {
      const rel = declarationFor(mjs);
      const committedPath = join(REPO_ROOT, rel);
      if (!existsSync(committedPath)) {
        missing.push(rel);
        continue;
      }
      const fresh = readFileSync(join(out, rel), 'utf8');
      if (readFileSync(committedPath, 'utf8') !== fresh) stale.push(rel);
    }

    if (missing.length || stale.length) {
      if (missing.length) console.error(`✗ missing declaration(s):\n   ${missing.join('\n   ')}`);
      if (stale.length) console.error(`✗ stale declaration(s):\n   ${stale.join('\n   ')}`);
      console.error(`\nRun \`npm run gen:declarations\` and commit the result.`);
      process.exit(1);
    }
    console.log(`✓ gen:declarations:check: ${inputs().length} declaration file(s) up to date`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv.includes('--check')) check();
else generate();
