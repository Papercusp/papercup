/**
 * Recurrence guard for WI-10005299: the shared esbuild host banner must never re-declare
 * `__dirname` / `__filename`, and every esbuild call that injects it must also pass
 * HOST_BANNER_DEFINES.
 *
 * Why this cannot be caught by the bundler alone: esbuild never parses `--banner:js` text, so
 * its renamer cannot see a binding the banner declares. A module-level `const __dirname` in
 * the bundled graph keeps its name unless some OTHER module reserves the name with a free
 * reference, so whether a bare banner declaration collides depends on the whole module graph.
 * The same source built cleanly into one bundle and crash-looped the embed sidecar in another
 * ("Identifier '__dirname' has already been declared"). The fix binds the banner's helpers under
 * banner-private names and rewrites FREE references with `--define`, which is graph-independent.
 *
 * This file lives under apps/operator/lib, outside every scanned root below, so the fixture
 * strings in it can never be picked up by the scan itself (asserted in the first test).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const TEST_FILE = fileURLToPath(import.meta.url);
// Resolve from this module, not process.cwd(): root-level and package-scoped Vitest runs differ.
const REPO_ROOT = resolve(dirname(TEST_FILE), '../../..');
const COMMON_SCRIPT = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');

/** Roots whose shell scripts invoke esbuild with the shared banner. */
const SCAN_ROOTS = ['apps/operator/bin', 'scripts', 'papercusp-desktop/bin'] as const;
/** papercusp-desktop is a submodule; its scripts are only scanned when it is checked out. */
const DESKTOP_ROOT = 'papercusp-desktop/bin';

/** Files known to inject the banner today — the positive control that keeps the scan honest. */
const KNOWN_SUPERPROJECT_CONSUMERS = [
  'apps/operator/bin/bundle-host-common.sh',
  'apps/operator/bin/bundle-host.sh',
  'scripts/build-p2p-witness.sh',
];
const KNOWN_DESKTOP_CONSUMERS = [
  'papercusp-desktop/bin/build-desktop-sidecar.sh',
  'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh',
];

const BARE_PATH_BINDING = /\b(?:const|let|var|function)\s+(?:__dirname|__filename)\b/;

interface SharedBanner {
  banner: string;
  defines: Record<string, string>;
}

/** Read the banner and its defines exactly as bash sees them, by sourcing the real script. */
function loadSharedBanner(): SharedBanner {
  const result = spawnSync(
    'bash',
    ['-c', 'source "$1" && printf "%s" "$HOST_BANNER" && printf "\\0" && printf "%s\\n" "${HOST_BANNER_DEFINES[@]}"', '_', COMMON_SCRIPT],
    { encoding: 'utf8', env: { ...process.env, PAPERCUSP_BUNDLE_HOST_COMMON_LOADED: '' } },
  );
  expect(result.status, result.stderr).toBe(0);
  const [banner, defineLines] = result.stdout.split('\0');
  const defines: Record<string, string> = {};
  for (const line of defineLines.split('\n').filter(Boolean)) {
    const match = /^--define:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)$/.exec(line);
    expect(match, `unexpected HOST_BANNER_DEFINES entry: ${line}`).not.toBeNull();
    defines[match![1]] = match![2];
  }
  return { banner, defines };
}

interface BannerCall {
  line: number;
  bannerVar: string;
  hasDefines: boolean;
  command: string;
}

describe('WI-10007376 — helper-only host bundles avoid eager PTY script hashing', () => {
  it('runs launcher helpers without reading the generated bundle as a PTY script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-helper-digest-'));
    try {
      const { banner, defines } = loadSharedBanner();
      const entry = join(dir, 'entry.mjs');
      const out = join(dir, 'host.mjs');
      writeFileSync(entry, [
        `import { operatorPinEvidence } from ${JSON.stringify(join(REPO_ROOT, 'apps/operator/scripts/psu-pty-host.mjs'))};`,
        `import { normalizeModelSpecForAgent } from ${JSON.stringify(join(REPO_ROOT, 'apps/operator/scripts/psu-launcher.mjs'))};`,
        `console.log(operatorPinEvidence({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170' }));`,
        `console.log(normalizeModelSpecForAgent('codex', 'gpt-5.5:high'));`,
      ].join('\n'));
      await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node',
        format: 'esm', target: 'node22', banner: { js: banner },
        define: { ...defines, __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
        treeShaking: true, logLevel: 'silent' });
      // Allow Node's own loader reads, but fail if a bundled PTY initializer
      // performs the extra filesystem read observed in the frozen-host profile.
      const preload = [
        "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
        'const read = fs.readFileSync;',
        "fs.readFileSync = function(...args) { if (new Error().stack.includes('hashHostScript')) process.stderr.write('EAGER_PTY_DIGEST_ATTEMPT\\n'); return read.apply(this, args); };",
        'syncBuiltinESMExports();',
      ].join('\n');
      const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, out], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('direct-3170\ngpt-5.5:high');
      // hashHostScript deliberately degrades read errors to null, so detect
      // attempted reads independently of its return value or process status.
      expect(run.stderr).not.toContain('EAGER_PTY_DIGEST_ATTEMPT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Find every esbuild `--banner:js=` argument that injects HOST_BANNER (directly or through a
 * variable built from it, such as STAMP_BANNER), and report whether the same logical shell
 * command — the run of lines joined by trailing backslashes — also passes HOST_BANNER_DEFINES.
 */
function findBannerCalls(source: string): BannerCall[] {
  // Blank comment lines while keeping line numbers, so prose that mentions the flag never counts.
  const lines = source.split('\n').map((text) => (/^\s*#/.test(text) ? '' : text));
  const bannerVars = new Set(['HOST_BANNER']);
  for (const text of lines) {
    const derived = /^\s*(?:local\s+|export\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=.*\$\{?HOST_BANNER\b/.exec(text);
    if (derived) bannerVars.add(derived[1]);
  }
  const continues = (index: number) => index >= 0 && index < lines.length && lines[index].trimEnd().endsWith('\\');
  const calls: BannerCall[] = [];
  lines.forEach((text, index) => {
    const arg = /--banner:js=["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    if (!arg || !bannerVars.has(arg[1])) return;
    let start = index;
    while (continues(start - 1)) start -= 1;
    let end = index;
    while (continues(end)) end += 1;
    const command = lines.slice(start, end + 1).join('\n');
    calls.push({ line: index + 1, bannerVar: arg[1], hasDefines: command.includes('HOST_BANNER_DEFINES[@]'), command });
  });
  return calls;
}

function listShellFiles(root: string): string[] {
  const absolute = join(REPO_ROOT, root);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (entry.endsWith('.sh')) out.push(path);
    }
  };
  walk(absolute);
  return out;
}

describe('findBannerCalls (scanner controls)', () => {
  it('cannot self-match: this test file is outside every scanned root', () => {
    const own = relative(REPO_ROOT, TEST_FILE);
    for (const root of SCAN_ROOTS) expect(own.startsWith(`${root}/`)).toBe(false);
  });

  it('flags a banner call that omits the defines, including through a derived banner variable', () => {
    const fixture = [
      'STAMP="${HOST_BANNER}console.log(1);"',
      'npx esbuild a.ts \\',
      '  --bundle \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  --outfile=a.mjs',
      'npx esbuild b.ts --banner:js="$STAMP" --outfile=b.mjs',
    ].join('\n');
    const calls = findBannerCalls(fixture);
    expect(calls.map((call) => [call.line, call.bannerVar, call.hasDefines])).toEqual([
      [4, 'HOST_BANNER', false],
      [6, 'STAMP', false],
    ]);
  });

  it('accepts the defines anywhere in the same continued command, in either expansion form', () => {
    const fixture = [
      '(cd web && npx esbuild a.ts \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  ${HOST_BANNER_DEFINES[@]+"${HOST_BANNER_DEFINES[@]}"})',
      'npx esbuild b.ts --banner:js="$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" --outfile=b.mjs',
    ].join('\n');
    expect(findBannerCalls(fixture).map((call) => call.hasDefines)).toEqual([true, true]);
  });

  it('does not borrow defines from a different command, and ignores comments and unrelated banners', () => {
    const fixture = [
      'npx esbuild a.ts "${HOST_BANNER_DEFINES[@]}" --outfile=a.mjs',
      'npx esbuild b.ts \\',
      '  --banner:js="$HOST_BANNER" \\',
      '  --outfile=b.mjs',
      '# npx esbuild c.ts --banner:js="$HOST_BANNER"',
      'npx esbuild d.ts --banner:js="$OTHER_BANNER" --outfile=d.mjs',
    ].join('\n');
    expect(findBannerCalls(fixture).map((call) => [call.line, call.hasDefines])).toEqual([[3, false]]);
  });
});

describe('shared esbuild host banner (WI-10005299)', () => {
  it('binds its path helpers under banner-private names that HOST_BANNER_DEFINES targets', () => {
    const { banner, defines } = loadSharedBanner();
    expect(banner).not.toMatch(BARE_PATH_BINDING);
    expect(Object.keys(defines).sort()).toEqual(['__dirname', '__filename']);
    for (const target of Object.values(defines)) {
      expect(target).not.toMatch(/^__(?:dirname|filename)$/);
      expect(banner).toMatch(new RegExp(`\\bconst ${target}=`));
    }
  });

  it('every esbuild call that injects the banner also passes HOST_BANNER_DEFINES', () => {
    const consumers = new Set<string>();
    const missing: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listShellFiles(root)) {
        const rel = relative(REPO_ROOT, file);
        for (const call of findBannerCalls(readFileSync(file, 'utf8'))) {
          consumers.add(rel);
          if (!call.hasDefines) missing.push(`${rel}:${call.line} (--banner:js="$${call.bannerVar}")`);
        }
      }
    }
    expect(missing).toEqual([]);
    // Positive control: the scan must still see every known consumer, or a zero above is vacuous.
    for (const known of KNOWN_SUPERPROJECT_CONSUMERS) expect([...consumers]).toContain(known);
    if (existsSync(join(REPO_ROOT, DESKTOP_ROOT))) {
      for (const known of KNOWN_DESKTOP_CONSUMERS) expect([...consumers]).toContain(known);
    }
  });

  describe('bundling with the real banner', () => {
    async function bundleAndRun(entrySource: string, opts: { banner: string; define?: Record<string, string> }) {
      // realpath: macOS tmpdir is a symlink, and the bundle reports its resolved location.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-host-banner-')));
      try {
        const entry = join(dir, 'entry.mjs');
        writeFileSync(entry, entrySource);
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node22',
          banner: { js: opts.banner },
          define: opts.define,
          write: false,
          logLevel: 'silent',
        });
        const out = join(dir, 'out.mjs');
        writeFileSync(out, result.outputFiles[0].text);
        const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
        const run = check.status === 0 ? spawnSync(process.execPath, [out], { encoding: 'utf8' }) : null;
        return { dir, check, stdout: run?.stdout.trim() ?? '', runStatus: run?.status ?? null };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // The crash shape: a module declares its OWN top-level __dirname and nothing in the graph
    // makes a free reference that would push esbuild to rename it.
    const OWN_DECLARATION = [
      "import { dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const __dirname = dirname(fileURLToPath(import.meta.url));',
      'console.log(__dirname);',
    ].join('\n');
    // CJS-style code that relies on the banner to supply the value.
    const FREE_REFERENCE = 'console.log(__dirname + "|" + __filename);';

    it('control: the pre-fix banner (bare const __dirname) reproduces the duplicate-declaration crash', async () => {
      const { banner } = loadSharedBanner();
      const preFix = banner.replace(/__pc_dirname/g, '__dirname').replace(/__pc_filename/g, '__filename');
      expect(preFix).toMatch(BARE_PATH_BINDING);
      const result = await bundleAndRun(OWN_DECLARATION, { banner: preFix });
      expect(result.check.status).not.toBe(0);
      expect(result.check.stderr).toMatch(/Identifier '__dirname' has already been declared/);
    });

    it('bundles and runs a module that declares its own __dirname', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(OWN_DECLARATION, { banner, define: defines });
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus).toBe(0);
      expect(result.stdout).toBe(result.dir);
    });

    it('still resolves free __dirname/__filename references through the defines', async () => {
      const { banner, defines } = loadSharedBanner();
      const result = await bundleAndRun(FREE_REFERENCE, { banner, define: defines });
      expect(result.check.status, result.check.stderr).toBe(0);
      expect(result.runStatus).toBe(0);
      expect(result.stdout).toBe(`${result.dir}|${join(result.dir, 'out.mjs')}`);
    });
  });
});
