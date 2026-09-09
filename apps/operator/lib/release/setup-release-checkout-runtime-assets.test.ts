/**
 * Regression coverage for setup-release-checkout.sh block `3b` — the provisioning
 * of GITIGNORED RUNTIME ASSETS under apps/operator/public into the gate's
 * checkpoint / release tree (EI-19373176486666620, recurrence guard
 * EI-19373637173456393).
 *
 * ## The class this guards
 *
 * Step 1 of the script runs `git clean -fdqx -e node_modules`. The `-x` is
 * deliberate and must stay (WI-5366: a stale gitignored cache from a prior
 * checkout at a different sha is a real correctness risk), but it cannot tell a
 * stale CACHE from a required RUNTIME ASSET, and it spares only node_modules.
 * `apps/operator/public/` is full of the latter — vditor, porcupine, excalidraw,
 * monaco, the ort-wasm-* blobs — all gitignored, all provisioned by
 * apps/operator/scripts/setup-*-runtime.sh via postinstall.
 *
 * So a test that asserts one of those files exists can NEVER pass in the gate's
 * checkout, however many times it is re-fired. Observed live 2026-08-02:
 * candidate 38ae7faf red-pinned `main` fleet-wide on `vditor mirror missing at
 * .../public/vditor/dist/js/lute/lute.min.js`.
 *
 * ## Why this failure mode earns a guard rather than a comment
 *
 * It is maximally deceptive. It is PERMANENT (no re-fire can fix a gitignored
 * asset) but presents as an intermittent flake, because the same test passes on
 * every developer machine — where postinstall has run. The author cannot
 * reproduce it locally BY CONSTRUCTION, and the cost lands on the whole fleet
 * rather than on them. Before the cause was traced, porcupine failed 7x and
 * vditor 10x in 12h.
 *
 * ## What this test locks
 *
 * Nothing today fails if someone deletes block 3b, narrows its enumeration root,
 * or breaks the `git status --porcelain --ignored` pipeline it depends on — each
 * of which silently re-arms the red-pin. So this test extracts the REAL block
 * from the shipped script (never a copy, mirroring the extraction pattern in
 * setup-release-checkout-deps.test.ts) and executes it against controlled temp
 * trees.
 *
 * The fixture deliberately reproduces the exact VDITOR SHAPE — a deep file
 * nested inside an ignored DIRECTORY — because `git status --porcelain
 * --ignored` reports ignored directories as a single entry with a trailing
 * slash (`apps/operator/public/vditor/`), never as individual files. A guard
 * that only exercised a top-level ignored FILE would pass while the real
 * directory case broke. Per EI-19373637173456393: a scan that misses the one
 * instance you already know about certifies nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../bin/release/setup-release-checkout.sh');

/**
 * Extract block 3b verbatim from the shipped script, so this test tracks the
 * real logic and fails loudly if the block is deleted or renamed.
 */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^# 3b\. Gitignored RUNTIME ASSETS/.test(l));
  if (start === -1) return '';
  // End at the NEXT numbered section header (`# 4. ...`, `# 3b-2. ...`) — NOT at
  // any `# <digit>`, which also matches this block's own comment line
  // "# 38ae7faf went red on ..." and truncates the block to its header. That
  // exact bug made the structural assertion below pass VACUOUSLY (the surviving
  // comment still mentions apps/operator/public) while zero shell was executed.
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^# \d+[a-z]?(-\d+)?\. /.test(l));
  return lines
    .slice(start, endRel === -1 ? undefined : start + 1 + endRel)
    .join('\n');
}

const BLOCK = extractBlock();

describe('setup-release-checkout.sh 3c — pinned WSL rootfs', () => {
  function runRootfs({ mismatch = false, copyRace = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'release-rootfs-'));
    const integration = join(root, 'integration');
    const release = join(root, '.papercusp/worktrees/cut');
    const relative = 'papercusp-desktop/src-tauri/resources';
    const target = join(release, relative, 'papercup-runtime.tar.gz');
    try {
      mkdirSync(join(integration, relative), { recursive: true });
      mkdirSync(join(release, relative), { recursive: true });
      writeFileSync(join(integration, relative, 'papercup-runtime.tar.gz'), mismatch ? 'wrong rootfs' : 'trusted rootfs');
      writeFileSync(join(release, relative, '.rootfs-build-stamp'), JSON.stringify({
        rootfsSha256: createHash('sha256').update('trusted rootfs').digest('hex'),
      }));
      const source = readFileSync(SCRIPT, 'utf8');
      const start = source.indexOf('# 3c. Checksum-pinned desktop rootfs');
      const end = source.indexOf('# 4. SPA dist', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const race = copyRace ? 'cp() { command cp "$@"; printf corrupted > "$2"; };\n' : '';
      const result = spawnSync('bash', ['-c', 'set -euo pipefail\nlog() { printf "%s\\n" "$*"; };\n' + race + source.slice(start, end)], {
        encoding: 'utf8', env: { ...process.env, INTEGRATION_ROOT: integration, RELEASE_ROOT: release },
      });
      return { ...result, target: existsSync(target) ? readFileSync(target, 'utf8') : null };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('hydrates a nested checkout from the integration donor with the exact release stamp', () => {
    const result = runRootfs();
    expect(result.status, result.stderr).toBe(0);
    expect(result.target).toBe('trusted rootfs');
  });
  it('never copies a donor from a different rootfs generation', () => {
    expect(runRootfs({ mismatch: true }).target).toBeNull();
  });
  it('rechecks copied bytes and refuses a donor changed during the copy', () => {
    const result = runRootfs({ copyRace: true });
    expect(result.status).not.toBe(0);
    expect(result.target).toBeNull();
    expect(result.stdout).toContain('refusing unverified input');
  });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

describe('setup-release-checkout.sh cleanup — dependency generation ownership', () => {
  it('preserves the complete generation store while deleting unrelated ignored debris', () => {
    const release = mkdtempSync(join(tmpdir(), 'setup-generation-clean-'));
    try {
      git(release, 'init', '-q');
      writeFileSync(join(release, '.gitignore'), '.papercusp/\n.vitest-tmp/\n');
      const store = '.papercusp/dependency-generations';
      const generation = `v1-${'a'.repeat(64)}`;
      const retained = [
        `${store}/.gitignore`,
        `${store}/.inputs/input-fingerprint`,
        `${store}/.pins/checkpoint`,
        `${store}/.leases/reader`,
        `${store}/${generation}/.papercusp-dependency-generation`,
        `${store}/${generation}/.tree-manifest`,
        `${store}/${generation}/tree/node_modules/example/package.json`,
        `${store}/.build-pending-writer/.papercusp-generation-writer`,
        `${store}/.build-pending-writer/tree/node_modules/example/package.json`,
        'node_modules/example/package.json',
        'apps/operator/dist-host/sql/runtime.sql',
      ];
      const debris = ['.vitest-tmp/stale.js', '.papercusp/unrelated-cache/stale.json'];
      for (const path of [...retained, ...debris]) {
        mkdirSync(dirname(join(release, path)), { recursive: true });
        writeFileSync(join(release, path), `payload:${path}`);
      }
      // Execute the actual cleanup command against a disposable Git repository.
      // A node_modules-only exclusion preserves package bytes but destroys the
      // selectors, publication proofs and leases needed to reuse those bytes.
      const clean = readFileSync(SCRIPT, 'utf8').split('\n').find(
        (line) => /^\s*git -C "\$RELEASE_ROOT" clean /.test(line),
      );
      expect(clean).toBeDefined();
      const result = spawnSync('bash', ['-c', clean!], {
        env: { ...process.env, RELEASE_ROOT: release }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(debris.filter((path) => existsSync(join(release, path)))).toEqual([]);
      expect(retained.map((path) => [
        path, existsSync(join(release, path)) ? readFileSync(join(release, path), 'utf8') : null,
      ])).toEqual(retained.map((path) => [path, `payload:${path}`]));
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });
});

describe('setup-release-checkout.sh 3b — gitignored runtime asset provisioning', () => {
  let root: string;
  let integration: string;
  let release: string;

  const VDITOR_REL = 'apps/operator/public/vditor/dist/js/lute/lute.min.js';
  const WASM_REL = 'apps/operator/public/ort-wasm-simd-threaded.wasm';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'setup-3b-'));
    integration = join(root, 'integration');
    release = join(root, 'release');
    mkdirSync(integration, { recursive: true });
    mkdirSync(release, { recursive: true });

    // An integration tree shaped like the real one: a gitignored DIRECTORY
    // (the vditor case) plus a gitignored top-level FILE (the ort-wasm case).
    git(integration, 'init', '-q');
    writeFileSync(
      join(integration, '.gitignore'),
      ['apps/operator/public/vditor/', 'apps/operator/public/ort-wasm-*'].join('\n'),
    );
    for (const rel of [VDITOR_REL, WASM_REL]) {
      const abs = join(integration, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `payload:${rel}`);
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Run the extracted block with the script-level globals it reads. */
  function runBlock(opts: { integrationRoot?: string } = {}) {
    const script = [
      'set -u',
      'log() { echo "[log] $*"; }',
      `INTEGRATION_ROOT=${JSON.stringify(opts.integrationRoot ?? integration)}`,
      `RELEASE_ROOT=${JSON.stringify(release)}`,
      BLOCK,
    ].join('\n');
    const file = join(root, 'run-3b.sh');
    writeFileSync(file, script);
    return spawnSync('bash', [file], { encoding: 'utf8' });
  }

  it('the block still exists in the shipped script and still covers apps/operator/public', () => {
    // Catches the two likeliest regressions: deleting the block, or narrowing
    // its enumeration root so it silently stops covering the assets.
    expect(
      BLOCK,
      'block "3b. Gitignored RUNTIME ASSETS" is missing from setup-release-checkout.sh — ' +
        'deleting it re-arms a PERMANENT, fleet-wide green-checkpoint red-pin that presents as a flake ' +
        '(EI-19373176486666620). If you moved it, update this extractor.',
    ).not.toBe('');
    expect(
      BLOCK,
      'block 3b no longer references apps/operator/public — narrowing its enumeration root ' +
        'silently stops provisioning vditor/porcupine/excalidraw/monaco/ort-wasm into the gate tree.',
    ).toContain('apps/operator/public');
  });

  it('provisions a gitignored DIRECTORY into the release tree (the vditor shape)', () => {
    const r = runBlock();
    expect(r.status, r.stderr).toBe(0);
    const dst = join(release, VDITOR_REL);
    expect(
      existsSync(dst),
      `${VDITOR_REL} was not provisioned. This is the exact assertion vditor-cdn.test.ts makes; ` +
        'if it is missing here, the gate red-pins permanently and no re-fire can clear it.',
    ).toBe(true);
    expect(readFileSync(dst, 'utf8')).toBe(`payload:${VDITOR_REL}`);
  });

  it('provisions a gitignored top-level FILE as well as a directory', () => {
    const r = runBlock();
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(release, WASM_REL))).toBe(true);
  });

  it('never overwrites an entry already present in the release tree (tracked wins)', () => {
    // 3b only FILLS what is missing, so anything checked out at TARGET_SHA
    // always beats the integration tree's copy.
    const dst = join(release, VDITOR_REL);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, 'sentinel-from-target-sha');
    const r = runBlock();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(dst, 'utf8')).toBe('sentinel-from-target-sha');
  });

  it('is non-fatal when apps/operator/public is absent from the integration tree', () => {
    // A missing asset must surface as the owning test's red, never as an
    // aborted tree setup that takes down every deploy.
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q');
    const r = runBlock({ integrationRoot: bare });
    expect(r.status, r.stderr).toBe(0);
  });

  it('reports how many assets it provisioned, so a silent no-op is visible in the gate log', () => {
    // The block failing OPEN is deliberate, which is exactly why the count has
    // to be observable — otherwise "provisioned nothing" is indistinguishable
    // from "provisioned everything" in the log.
    const r = runBlock();
    expect(r.stdout).toMatch(/provisioned [1-9][0-9]* gitignored runtime asset\(s\)/);
  });
});
