/**
 * WI-10004074: the setup-*-runtime.sh mirrors must be EXACT copies of their
 * package, not "a copy finished once at this version".
 *
 * Each script used to skip its copy whenever the version stamp matched and one
 * sentinel file existed. The canonical tree's public/monaco/vs therefore held
 * 151 files against monaco-editor 0.56.0's 123: 28 hashed chunks from an older
 * build that no run ever removed. The release cut hard-links that tree, so all 28
 * shipped in the 0.0.25 SPA, and cut-to-cut reproducibility depended on the state
 * of the integration tree.
 *
 * These tests run the REAL scripts against a hermetic fixture root. Each script
 * `cd`s to its own `..`, so a copied script resolves node_modules and public/
 * inside the fixture and never touches the live tree. Each test populates a
 * mirror with a clean run, injects drift while leaving the stamp current, and
 * asserts the next run repairs it. It then asserts that a third run takes the
 * cheap "already current" path again, so the fix cannot degrade into "always
 * re-copy".
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = resolve(__dirname, '..');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(script: string): string {
  const repository = mkdtempSync(join(tmpdir(), 'papercusp-mirror-reconcile-'));
  roots.push(repository);
  const root = join(repository, 'apps', 'operator');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(repository, 'scripts', 'lib'), { recursive: true });
  copyFileSync(resolve(SCRIPTS, '../../../scripts/lib/fs-mutex.mjs'), join(repository, 'scripts/lib/fs-mutex.mjs'));
  copyFileSync(join(SCRIPTS, 'lib/with-runtime-mirror-lock.mjs'), join(root, 'scripts/lib/with-runtime-mirror-lock.mjs'));
  copyFileSync(join(SCRIPTS, script), join(root, 'scripts', script));
  copyFileSync(join(SCRIPTS, 'lib', 'mirror-tree.sh'), join(root, 'scripts', 'lib', 'mirror-tree.sh'));
  return root;
}

function put(root: string, rel: string, body = `${rel}\n`): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function fileSet(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

function run(root: string, script: string): string {
  const result = spawnSync('bash', [join(root, 'scripts', script)], { encoding: 'utf8', env: process.env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  expect(result.status, output).toBe(0);
  return output;
}

describe('setup-monaco-runtime.sh reconciles the mirror file set (WI-10004074)', () => {
  const SCRIPT = 'setup-monaco-runtime.sh';

  function monacoRoot(): string {
    const root = fixtureRoot(SCRIPT);
    put(root, 'node_modules/monaco-editor/package.json', JSON.stringify({ version: '9.9.9' }));
    for (const rel of ['loader.js', 'editor/editor.main.css', 'editor-Abc123.js', 'basic-languages/sql-Def456.js']) {
      put(root, `node_modules/monaco-editor/min/vs/${rel}`);
    }
    return root;
  }

  it('removes stale chunks that an already-current stamp used to protect', () => {
    const root = monacoRoot();
    const src = join(root, 'node_modules/monaco-editor/min/vs');
    const dest = join(root, 'public/monaco/vs');

    expect(run(root, SCRIPT)).toContain('mirrored monaco-editor v9.9.9');
    expect(readFileSync(join(root, 'public/monaco/.version'), 'utf8').trim()).toBe('9.9.9');

    // The measured drift: hashed chunks from an older monaco build, with the
    // stamp still naming the installed version.
    put(root, 'public/monaco/vs/abap-D-t0cyap.js');
    put(root, 'public/monaco/vs/basic-languages/apex-CcIm7xu6.js');

    expect(run(root, SCRIPT)).toContain('file set differs from monaco-editor — re-copying');
    expect(fileSet(dest)).toEqual(fileSet(src));

    expect(run(root, SCRIPT)).toContain('already current (v9.9.9) — skipping copy');
    expect(fileSet(dest)).toEqual(fileSet(src));
  });

  it('restores a file missing from an already-stamped mirror', () => {
    const root = monacoRoot();
    run(root, SCRIPT);
    rmSync(join(root, 'public/monaco/vs/basic-languages/sql-Def456.js'));

    expect(run(root, SCRIPT)).toContain('re-copying');
    expect(existsSync(join(root, 'public/monaco/vs/basic-languages/sql-Def456.js'))).toBe(true);
  });

  it('serializes overlapping install and prebuild mirror transactions', async () => {
    const root = monacoRoot();
    const bin = join(root, 'bin');
    const entered = join(root, 'copy-entered');
    const release = join(root, 'copy-release');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cp'), [
      '#!/bin/sh',
      'if ! mkdir "$MIRROR_TEST_ENTERED" 2>/dev/null; then',
      '  echo "overlapping mirror writes" >&2; exit 78',
      'fi',
      'while [ ! -e "$MIRROR_TEST_RELEASE" ]; do sleep 0.01; done',
      'exec /bin/cp "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      MIRROR_TEST_ENTERED: entered,
      MIRROR_TEST_RELEASE: release,
      PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, 'mutex'),
      PAPERCUSP_DISABLE_FS_MUTEX: '0',
    };
    const start = () => {
      const child = spawn('bash', [join(root, 'scripts', SCRIPT)], { env });
      const output = createTextCollector(child.stdout);
      output.attach(child.stderr);
      const exited = new Promise<number | null>((resolveExit) => child.once('close', resolveExit));
      return { child, exited, output: () => output.peek() };
    };
    const first = start();
    let second: ReturnType<typeof start> | undefined;
    let codes: (number | null)[] = [];
    try {
      for (let attempt = 0; attempt < 1000 && !existsSync(entered); attempt += 1) {
        if (first.child.exitCode !== null) throw new Error(first.output());
        await delay(5);
      }
      expect(existsSync(entered), first.output()).toBe(true);
      second = start();
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (second.child.exitCode !== null || second.output().includes('runtime-mirror: waiting')) break;
        await delay(5);
      }
    } finally {
      writeFileSync(release, 'continue');
      codes = await Promise.all([first.exited, ...(second ? [second.exited] : [])]);
    }
    expect(codes, first.output() + '\n' + (second?.output() ?? '')).toEqual([0, 0]);
    expect(fileSet(join(root, 'public/monaco/vs'))).toEqual(fileSet(join(root, 'node_modules/monaco-editor/min/vs')));
    expect(readFileSync(join(root, 'public/monaco/.version'), 'utf8').trim()).toBe('9.9.9');
    expect(run(root, SCRIPT)).toContain('already current');
  }, 20_000);
});

describe('setup-excalidraw-runtime.sh reconciles the mirror file set (WI-10004074)', () => {
  const SCRIPT = 'setup-excalidraw-runtime.sh';

  it('removes stale files but keeps the in-mirror stamp out of the comparison', () => {
    const root = fixtureRoot(SCRIPT);
    put(root, 'node_modules/@excalidraw/excalidraw/package.json', JSON.stringify({ version: '1.2.3' }));
    for (const rel of ['index.js', 'fonts/Virgil.woff2', 'chunk-Xyz789.js']) {
      put(root, `node_modules/@excalidraw/excalidraw/dist/prod/${rel}`);
    }
    const src = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod');
    const dest = join(root, 'public/excalidraw');

    run(root, SCRIPT);
    // The stamp lives inside the mirror. If the comparison counted it, every
    // run would re-copy and the cheap path would be dead.
    expect(run(root, SCRIPT)).toContain('already current (v1.2.3) — skipping copy');

    put(root, 'public/excalidraw/chunk-OldBuild.js');
    expect(run(root, SCRIPT)).toContain('re-copying');
    expect(fileSet(dest)).toEqual([...fileSet(src), '.version'].sort());
    expect(readFileSync(join(dest, '.version'), 'utf8').trim()).toBe('1.2.3');

    expect(run(root, SCRIPT)).toContain('already current (v1.2.3) — skipping copy');
  });
});

describe('setup-vditor-runtime.sh reconciles both of its mirrors (WI-10004074)', () => {
  const SCRIPT = 'setup-vditor-runtime.sh';
  const MARKMAP_CDN = [
    'https://cdn.jsdelivr.net/npm/d3@6.7.0',
    'https://cdn.jsdelivr.net/npm/markmap-view@0.14.3',
    'https://cdn.jsdelivr.net/npm/webfontloader@1.6.28/webfontloader.js',
  ];

  function vditorRoot(): string {
    const root = fixtureRoot(SCRIPT);
    put(root, 'node_modules/vditor/package.json', JSON.stringify({ version: '3.11.2' }));
    put(root, 'node_modules/vditor/dist/js/lute/lute.min.js');
    put(root, 'node_modules/vditor/dist/js/markmap/markmap.min.js', `load(${JSON.stringify(MARKMAP_CDN)});\n`);
    put(root, 'node_modules/vditor/dist/index.css');
    put(root, 'node_modules/d3/package.json', JSON.stringify({ version: '6.7.0' }));
    put(root, 'node_modules/d3/dist/d3.min.js');
    put(root, 'node_modules/markmap-view/package.json', JSON.stringify({ version: '0.14.3' }));
    put(root, 'node_modules/markmap-view/dist/index.min.js');
    put(root, 'node_modules/webfontloader/package.json', JSON.stringify({ version: '1.6.28' }));
    put(root, 'node_modules/webfontloader/webfontloader.js');
    return root;
  }

  it('re-copies when either the dist mirror or vditor-local has drifted', () => {
    const root = vditorRoot();
    const src = join(root, 'node_modules/vditor/dist');
    const dest = join(root, 'public/vditor/dist');
    const local = join(root, 'public/vditor-local');
    const expectedLocal = ['.versions', 'd3.min.js', 'markmap-view.min.js', 'webfontloader.js'];

    run(root, SCRIPT);
    // markmap.min.js is rewritten in place after the copy, so only the PATH set
    // can be compared. If the check hashed bytes, this would re-copy.
    expect(run(root, SCRIPT)).toContain('already current (v3.11.2) — skipping copy');

    put(root, 'public/vditor/dist/js/stale-OldBuild.js');
    expect(run(root, SCRIPT)).toContain('re-copying');
    expect(fileSet(dest)).toEqual(fileSet(src));
    expect(readFileSync(join(dest, 'js/markmap/markmap.min.js'), 'utf8')).not.toContain('cdn.jsdelivr.net');

    put(root, 'public/vditor-local/old-asset.js');
    expect(run(root, SCRIPT)).toContain('re-copying');
    expect(fileSet(local)).toEqual(expectedLocal);

    expect(run(root, SCRIPT)).toContain('already current (v3.11.2) — skipping copy');
  });
});

describe('mirror-tree.sh', () => {
  function sh(root: string, body: string) {
    return spawnSync('bash', ['-c', `set -euo pipefail; . scripts/lib/mirror-tree.sh; ${body}`], {
      cwd: root,
      encoding: 'utf8',
    });
  }

  it('never reports a missing destination as matching', () => {
    const root = fixtureRoot('setup-monaco-runtime.sh');
    put(root, 'src/a.js');
    expect(sh(root, 'mirror_matches src missing').status).not.toBe(0);
    expect(sh(root, 'mkdir dest && cp src/a.js dest/ && mirror_matches src dest').status).toBe(0);
  });

  it('keeps an in-progress atomic replacement outside Vite inputs and the git-sync source census', async () => {
    const root = fixtureRoot('setup-monaco-runtime.sh');
    copyFileSync(resolve(SCRIPTS, '../../..', '.gitignore'), join(root, '.gitignore'));
    const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    put(root, 'authored-control.ts', 'export const authored = true;\n');
    put(root, 'src/ort-wasm.wasm', 'new wasm bytes');
    mkdirSync(join(root, 'public/vad-runtime'), { recursive: true });
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const started = join(root, 'copy-started');
    const release = join(root, 'copy-release');
    writeFileSync(
      join(bin, 'cp'),
      '#!/bin/sh\ntouch "$MIRROR_COPY_STARTED"\nwhile [ ! -e "$MIRROR_COPY_RELEASE" ]; do sleep 0.01; done\nexec /bin/cp "$@"\n',
      { mode: 0o755 },
    );

    const child = spawn('bash', [
      '-c',
      'set -euo pipefail; . scripts/lib/mirror-tree.sh; mirror_copy_unlinked src/ort-wasm.wasm public/vad-runtime/ort-wasm.wasm',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        MIRROR_COPY_STARTED: started,
        MIRROR_COPY_RELEASE: release,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    let exitCode: number | null = null;

    try {
      for (let attempt = 0; attempt < 200 && !existsSync(started); attempt += 1) {
        if (child.exitCode !== null) throw new Error(`mirror copy exited early with ${child.exitCode}`);
        await delay(5);
      }
      expect(existsSync(started), 'copy wrapper did not reach its pause point').toBe(true);
      expect(fileSet(join(root, 'public'))).toEqual([]);
      const staged = readdirSync(root).filter((name) => name.startsWith('.mirror-tree.tmp.'));
      expect(staged).toHaveLength(1);
      const census = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: root, encoding: 'utf8',
      });
      expect(census.status, census.stderr).toBe(0);
      const paths = census.stdout.trim().split('\n');
      expect(paths).toContain('authored-control.ts');
      expect(paths.filter((path) => staged.includes(path))).toEqual([]);
    } finally {
      writeFileSync(release, 'continue');
      exitCode = await exited;
    }

    expect(exitCode).toBe(0);
    expect(readFileSync(join(root, 'public/vad-runtime/ort-wasm.wasm'), 'utf8')).toBe('new wasm bytes');
    expect(fileSet(join(root, 'public'))).toEqual(['vad-runtime/ort-wasm.wasm']);
    expect(readdirSync(root).filter((name) => name.startsWith('.mirror-tree.tmp.'))).toEqual([]);
  });
});
