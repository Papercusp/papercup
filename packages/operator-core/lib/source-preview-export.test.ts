/**
 * scripts/source-preview.mjs export — plan dhh-source-preview-2026-09-28 R-1/R-3/R-4
 * (P-001, P-002).
 *
 * The preview must be the SAME public-safe cut the desktop installer ships
 * (sidecar/source.tar.zst), minus node_modules — not a second, hand-kept list.
 * The parity case proves that by running the shared selection library in its
 * INSTALLER mode over the same clean tree and comparing file sets, so a future
 * edit that forks the two selections fails here.
 *
 * Every case drives a synthetic superproject under tmpdir; nothing touches the
 * shared checkout.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADDED_FILES,
  SELECTION_LIB,
  allowlistTops,
  exportSnapshot,
  loadReleaseHost,
  materializeCommit,
  prepareVerifierSource,
  runCli,
  verifyVerifierSource,
  releasesPageUrl,
  sourceYear,
} from '../../../scripts/source-preview.mjs';
import { DROPPED, INTERNAL_DOC_CONTENTS, SHIPPED, childEnv, git, makeSuperproject, write, type Superproject } from './source-preview.fixture';

let tmp: string;
let fx: Superproject;
let out: string;
let manifest: Awaited<ReturnType<typeof exportSnapshot>>['manifest'];

function listFiles(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else acc.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return acc.sort();
}

/** What the INSTALLER selection would put in source.tar.zst for the same clean tree. */
function installerListing(mono: string): string[] {
  const r = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    '. "$1"',
    'source_tree_selection "$(dirname "$1")/.." "$2" installer',
    'tar "${SELECTION_EXCLUDES[@]}" -C "$2" -cf - "${SELECTION_INCLUDES[@]}" | tar -tf -',
  ].join('\n'), '_', SELECTION_LIB, mono], { encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, '')).sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-export-test-'));
  fx = makeSuperproject(tmp);
  out = join(tmp, 'export');
  ({ manifest } = await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out, env: childEnv() }));
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview export — R-1 selection parity with the installer cut', () => {
  it('ships every selected tracked file, including the submodule contents', () => {
    const files = listFiles(out);
    for (const p of SHIPPED) expect(files, p).toContain(p);
  });

  it('drops every excluded class, node_modules at any depth, and all git metadata', () => {
    const files = listFiles(out);
    for (const p of DROPPED) expect(files, p).not.toContain(p);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('.git'))).toEqual([]);
  });

  it('retains the exact eligible bytes from both internal documentation roots', () => {
    for (const [path, body] of Object.entries(INTERNAL_DOC_CONTENTS)) {
      expect(readFileSync(join(out, path), 'utf8'), path).toBe(body);
    }
  });

  it('equals the installer selection over the same clean commit, minus node_modules', () => {
    const mono = join(tmp, 'parity-mono');
    rmSync(mono, { recursive: true, force: true });
    spawnSync('mkdir', ['-p', mono]);
    materializeCommit({ repo: fx.repo, sha: fx.commit, dest: mono, allow: allowlistTops() });
    const installer = installerListing(mono).filter((f) => !f.split('/').includes('node_modules'));
    const preview = listFiles(out).filter((f) => !ADDED_FILES.includes(f));
    expect(preview).toEqual(installer);
    // The comparison is only meaningful if the installer side really shipped node_modules.
    expect(installerListing(mono)).toContain('node_modules/leftpad/index.js');
    for (const path of Object.keys(INTERNAL_DOC_CONTENTS)) expect(installer, path).toContain(path);
    expect(installer).not.toContain('libs/papercusp/plugins/gitnexus-bridge/index.ts');
    expect(installer).toContain('libs/papercusp/plugins/markdown-preview/papercusp.json');
  });
});

describe('EI-25303741091409100 — pinned verifier source identity', () => {
  it('transports a complete list beyond the argv/env limit and retains merged hashes and gitlinks', () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-large-list-fixture'));
    const paths = Array.from({ length: 2000 }, (_, i) =>
      `apps/operator/acceptance/${String(i).padStart(4, '0')}-${'x'.repeat(70)}.ts`);
    paths.push('apps/operator/acceptance/space and,comma.ts');
    for (const path of paths) write(fixture.repo, path, `// ${path}\n`);
    git(fixture.repo, ['add', 'apps/operator/acceptance']);
    git(fixture.repo, ['commit', '-qm', 'large complete verifier list']);
    const sha = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const inputsFile = join(tmp, 'verifier-large-inputs.json');
    const serialized = JSON.stringify(paths);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
    writeFileSync(inputsFile, serialized);
    const dest = join(tmp, 'verifier-large-export');
    const receiptFile = join(tmp, 'verifier-large-receipt.json');
    const tooling = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/source-preview.mjs'),
      'verifier-prepare', '--repo', fixture.repo, '--ref', sha, '--out', dest,
      '--inputs', tooling, '--inputs-file', inputsFile, '--receipt', receiptFile],
    { encoding: 'utf8', env: childEnv(), timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.sourceCommit).toBe(sha);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(receipt.testedInputs).toEqual([...paths, tooling].sort().map((path) => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(fixture.repo, path))).digest('hex') })));
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);
  }, 120_000);

  it.each(['', '{bad', '{}', '[]', '[null]', '["../outside"]', '[""]'])
    ('refuses malformed or empty input files before exporting (%s)', async (body) => {
      const inputsFile = join(tmp, 'verifier-invalid-inputs.json');
      const dest = join(tmp, 'verifier-invalid-export');
      writeFileSync(inputsFile, body);
      await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
        inputs: [SHIPPED[0]], inputsFile })).rejects.toThrow();
      expect(existsSync(dest)).toBe(false);
    });

  it('refuses an absent input file rather than using only the mandatory inputs', async () => {
    const dest = join(tmp, 'verifier-absent-input-file-export');
    await expect(prepareVerifierSource({ repo: fx.repo, ref: fx.commit, dest,
      inputs: [SHIPPED[0]], inputsFile: join(tmp, 'does-not-exist.json') })).rejects.toThrow(/ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it.each([{ tail: [] }, { tail: ['--receipt', 'receipt.json'] }])
    ('refuses a missing --inputs-file value despite valid CSV inputs ($tail)', async ({ tail }) => {
    const dest = join(tmp, 'verifier-missing-input-argument-export');
    await expect(runCli(['verifier-prepare', '--repo', fx.repo, '--ref', fx.commit,
      '--out', dest, '--inputs', SHIPPED[0], '--inputs-file', ...tail]))
      .rejects.toThrow('missing value for --inputs-file');
    expect(existsSync(dest)).toBe(false);
  });

  it.each(['dirty', 'missing'])('refuses a %s file-listed input and removes the incomplete export', async (kind) => {
    const fixture = makeSuperproject(join(tmp, `verifier-file-${kind}-fixture`));
    const dest = join(tmp, `verifier-file-${kind}-export`);
    const inputsFile = join(tmp, `verifier-file-${kind}-inputs.json`);
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    if (kind === 'dirty') writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    writeFileSync(inputsFile, JSON.stringify([kind === 'dirty' ? input : 'apps/operator/missing.ts']));
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest,
      inputs: [SHIPPED.find((p) => p !== input)!], inputsFile }))
      .rejects.toThrow(kind === 'dirty' ? /dirty tested-input mismatch/ : /ENOENT/);
    expect(existsSync(dest)).toBe(false);
  });

  it('round-trips the verifier CLI with an external caller receipt and refuses tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-cli-fixture'));
    const dest = join(tmp, 'verifier-cli-export');
    const receipt = join(tmp, 'verifier-cli-receipt.json');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    expect(await runCli(['verifier-prepare', '--repo', fixture.repo, '--ref', fixture.commit,
      '--out', dest, '--inputs', input, '--receipt', receipt])).toBe(0);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).sourceCommit).toBe(fixture.commit);
    expect(await runCli(['verifier-verify', '--out', dest, '--receipt', receipt])).toBe(0);
    writeFileSync(join(dest, input), 'changed after preparation');
    await expect(runCli(['verifier-verify', '--out', dest, '--receipt', receipt]))
      .rejects.toThrow('tampered verification source archive');
  });

  it('exports exact gitlinks despite unrelated dirty donor bytes and detects archive tampering', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-fixture'));
    const dest = join(tmp, 'verifier-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    write(fixture.repo, 'unrelated-untracked.ts', 'peer edit');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    expect(receipt.sourceCommit).toBe(fixture.commit);
    expect(receipt.submodules.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, 'unrelated-untracked.ts'))).toBe(false);
    await expect(verifyVerifierSource(dest, receipt)).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'tampered');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow(`tampered verification source archive: changed ${input}`);
  });

  it('refuses an older committed tested input and cleans the incomplete export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-dirty-fixture'));
    const dest = join(tmp, 'verifier-dirty-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    writeFileSync(join(fixture.repo, input), 'uncommitted acceptance change');
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] }))
      .rejects.toThrow('dirty tested-input mismatch');
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses missing, altered provenance and extra archive files', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-provenance-fixture'));
    const dest = join(tmp, 'verifier-provenance-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, undefined as never)).rejects.toThrow('missing verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), '{}');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source provenance');
    writeFileSync(join(dest, '.verifier-source.json'), JSON.stringify(receipt));
    writeFileSync(join(dest, 'extra.ts'), 'unexpected');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('tampered verification source archive: added extra.ts');
  });

  it('never excludes recorded files under runtime directories from the source verdict', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-recorded-fixture'));
    const dest = join(tmp, 'verifier-runtime-recorded-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    const recorded = receipt.files.find(file => file.path.startsWith('node_modules/'))!;
    expect(recorded).toBeDefined();
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, recorded.path), 'changed recorded dependency source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('tampered verification source archive');
  });

  it('rejects a symlink posing as an independent runtime directory', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-runtime-link-fixture'));
    const dest = join(tmp, 'verifier-runtime-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    symlinkSync(join(dest, 'apps/operator/src'), join(dest, 'apps/operator/dist-verify'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent directory');
  });

  it('allows an unrecorded generated router tree only for runtime source attestation', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-runtime-fixture'));
    const dest = join(tmp, 'verifier-router-runtime-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'generated from recorded routes');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added apps/operator-vite/src/routeTree.gen.ts');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['apps/operator-vite/src/routeTree.gen.ts', '.papercusp-pinned-deps', 'libs/generic/sse/dist/index.js', 'packages/omp-plugin/dist/native-extension.mjs'])('never excludes recorded output from source attestation: %s', async input => {
    const suffix = input.replaceAll('/', '-');
    const fixture = makeSuperproject(join(tmp, `verifier-output-recorded-${suffix}`));
    write(fixture.repo, input, 'recorded route tree');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'recorded route tree fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, `verifier-output-recorded-export-${suffix}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded route tree');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it('accepts unrecorded pinned dependency output while still detecting recorded source changes', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-pinned-output-fixture'));
    const input = 'libs/generic/sse/src/index.ts';
    write(fixture.repo, input, 'export const source = true;');
    git(fixture.repo, ['add', input]);
    git(fixture.repo, ['commit', '-qm', 'pinned runtime source fixture']);
    const ref = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
    const dest = join(tmp, 'verifier-pinned-output-export');
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref, dest, inputs: [input] });
    write(dest, '.papercusp-pinned-deps', 'immutable dependency receipt');
    write(dest, 'libs/generic/sse/dist/index.js', 'export const source = true;');
    write(dest, 'packages/omp-plugin/dist/native-extension.mjs', 'export const source = true;');
    await expect(verifyVerifierSource(dest, receipt)).rejects.toThrow('added .papercusp-pinned-deps');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).resolves.toEqual(receipt);
    writeFileSync(join(dest, input), 'changed recorded source');
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow(`changed ${input}`);
  });

  it.each(['.papercusp-pinned-deps', 'libs/generic/sse/dist', 'packages/omp-plugin/dist'])('rejects a redirect posing as runtime output: %s', async artifact => {
    const fixture = makeSuperproject(join(tmp, `verifier-output-link-${artifact.replaceAll('/', '-')}`));
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const dest = join(tmp, `verifier-output-link-export-${artifact.replaceAll('/', '-')}`);
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, artifact, 'placeholder');
    rmSync(join(dest, artifact));
    symlinkSync(join(dest, input), join(dest, artifact));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent');
  });

  it('rejects a symlink posing as an unrecorded generated router tree', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-router-link-fixture'));
    const dest = join(tmp, 'verifier-router-link-export');
    const input = SHIPPED.find(p => p.startsWith('apps/'))!;
    const receipt = await prepareVerifierSource({ repo: fixture.repo, ref: fixture.commit, dest, inputs: [input] });
    write(dest, 'apps/operator-vite/src/routeTree.gen.ts', 'placeholder');
    rmSync(join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    symlinkSync(join(dest, input), join(dest, 'apps/operator-vite/src/routeTree.gen.ts'));
    await expect(verifyVerifierSource(dest, receipt, { runtimeArtifacts: true })).rejects.toThrow('runtime artifact is not an independent file');
  });

  it('refuses tracked source symlinks that read outside the immutable export', async () => {
    const fixture = makeSuperproject(join(tmp, 'verifier-link-fixture'));
    symlinkSync('/tmp/live-peer-source.ts', join(fixture.repo, 'outside-source'));
    git(fixture.repo, ['add', 'outside-source']);
    git(fixture.repo, ['commit', '-qm', 'outside source fixture']);
    const dest = join(tmp, 'verifier-link-export');
    const input = SHIPPED.find((p) => p.startsWith('apps/'))!;
    await expect(prepareVerifierSource({ repo: fixture.repo, ref: 'HEAD', dest, inputs: [input] }))
      .rejects.toThrow('archive symlink escapes source root');
    expect(existsSync(dest)).toBe(false);
  });
});

describe('source-preview export — R-3 pinned, history-free snapshot', () => {
  it('records the superproject commit and every exported submodule gitlink in MANIFEST.json', () => {
    const onDisk = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);
    expect(manifest.source.commit).toBe(fx.commit);
    expect(manifest.submodules).toEqual([{ path: 'libs/papercusp', sha: fx.subCommit }]);
    expect(manifest.fileCount).toBe(listFiles(out).length - ADDED_FILES.length);
  });

  it('refuses an unresolvable gitlink and leaves no export behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-ghost-'));
    try {
      const ghost = makeSuperproject(root);
      git(ghost.repo, ['update-index', '--cacheinfo', `160000,${'1'.repeat(40)},libs/papercusp`]);
      git(ghost.repo, ['commit', '-q', '-m', 'point the gitlink at a commit that does not exist']);
      const target = join(root, 'export');
      await expect(exportSnapshot({ repoRoot: ghost.repo, ref: 'main', out: target, env: childEnv() }))
        .rejects.toThrow(/unresolvable gitlink libs\/papercusp/);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(root).filter((n) => n.startsWith('export.partial'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('is deterministic: exporting the same commit twice yields identical bytes', async () => {
    const again = join(tmp, 'export-again');
    await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: again, env: childEnv() });
    const a = listFiles(out);
    expect(listFiles(again)).toEqual(a);
    for (const f of a) expect(readFileSync(join(again, f)), f).toEqual(readFileSync(join(out, f)));
  }, 120_000);

  it('exports only committed content, never uncommitted working-tree edits', async () => {
    write(fx.repo, 'apps/operator/src/index.ts', 'export const x = "uncommitted";\n');
    try {
      const snap = join(tmp, 'export-dirty');
      await exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: snap, env: childEnv() });
      expect(readFileSync(join(snap, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      git(fx.repo, ['checkout', '--', 'apps/operator/src/index.ts']);
    }
  }, 120_000);

  it('uses the pinned dependency graph and leaves dirty source, index and branch unchanged (D-007)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-pin-'));
    try {
      const pinned = makeSuperproject(root);
      const pinnedLock = JSON.stringify({ lockfileVersion: 3, packages: {
        'node_modules/pinned-dependency': { version: '1.0.0', license: 'MIT' },
      } });
      write(pinned.repo, 'package-lock.json', pinnedLock);
      git(pinned.repo, ['add', 'package-lock.json']);
      git(pinned.repo, ['commit', '-q', '-m', 'pin dependency graph']);
      const ref = git(pinned.repo, ['rev-parse', 'HEAD']);
      // The installed/working tree deliberately disagrees with the pinned graph.
      write(pinned.repo, 'package-lock.json', '{"packages":{"node_modules/integration-only":{"version":"2"}}}\n');
      write(pinned.repo, 'node_modules/integration-only/index.js', 'module.exports = "integration-only";\n');
      write(pinned.repo, 'apps/operator/src/index.ts', 'export const staged = true;\n');
      git(pinned.repo, ['add', 'apps/operator/src/index.ts']);
      const state = () => ({
        head: git(pinned.repo, ['rev-parse', 'HEAD']),
        branch: git(pinned.repo, ['symbolic-ref', 'HEAD']),
        index: git(pinned.repo, ['diff', '--cached', '--binary']),
        worktree: git(pinned.repo, ['diff', '--binary']),
      });
      const before = state();
      expect(before.index).toContain('staged = true');
      expect(before.worktree).toContain('integration-only');
      const target = join(root, 'export');
      const { manifest: receipt } = await exportSnapshot({ repoRoot: pinned.repo, ref, out: target, env: childEnv() });
      expect(receipt.source.commit).toBe(ref);
      expect(receipt.submodules).toEqual([{ path: 'libs/papercusp', sha: pinned.subCommit }]);
      expect(readFileSync(join(target, 'package-lock.json'), 'utf8')).toBe(pinnedLock);
      expect(readFileSync(join(target, 'apps/operator/src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
      expect(existsSync(join(target, 'node_modules'))).toBe(false);
      expect(readFileSync(join(pinned.repo, 'node_modules/integration-only/index.js'), 'utf8'))
        .toBe('module.exports = "integration-only";\n');
      expect(state()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('source-preview export — R-4 evaluation notice', () => {
  it('writes a NOTICE restricting use to evaluation and forbidding redistribution', () => {
    const notice = readFileSync(join(out, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/EVALUATION ONLY/);
    expect(notice).toMatch(/may not redistribute/);
    expect(notice).toContain(fx.commit);
  });

  it('dates the copyright from real history, not a fixed-date repair-queue admission commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-preview-year-'));
    try {
      const repo = makeSuperproject(root).repo;
      const real = Number(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD']));
      const fixed = '2000-01-01T00:00:00Z';
      const r = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'admit 1 path(s) onto frozen lineage'], {
        encoding: 'utf8',
        env: childEnv({
          GIT_AUTHOR_NAME: 'gate', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_AUTHOR_DATE: fixed,
          GIT_COMMITTER_NAME: 'gate', GIT_COMMITTER_EMAIL: 'gate@example.invalid', GIT_COMMITTER_DATE: fixed,
        }),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(git(repo, ['show', '-s', '--format=%cd', '--date=format:%Y', 'HEAD'])).toBe('2000');
      expect(sourceYear(repo, git(repo, ['rev-parse', 'HEAD']))).toBe(real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes README.md naming the snapshot and the workspaces it contains', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain(fx.commit);
    expect(readme).toContain('`apps/operator`');
    expect(readme).toContain('the operator host');
  });

  it('links the releases page and explains how and why the release carries this source', () => {
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('[Papercusp releases page](https://releases.example.invalid/fixture/index.html)');
    expect(readme).toMatch(/## How this source ships inside every release[\s\S]*`sidecar\/source\.tar\.zst`/);
    expect(readme).toMatch(/## Why the release carries its own source/);
  });

  it('refuses to export without a release host rather than publish a README with no download link', async () => {
    const target = join(tmp, 'export-no-release-host');
    await expect(exportSnapshot({ repoRoot: fx.repo, ref: 'main', out: target, env: childEnv({ PAPERCUSP_UPDATE_BASE_URL: '' }) }))
      .rejects.toThrow(/PAPERCUSP_UPDATE_BASE_URL is unset/);
    expect(existsSync(target)).toBe(false);
  });
});

describe('source-preview export — release host resolution', () => {
  it('fills the base URL from the release-host file only when the environment is silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-preview-release-host-'));
    try {
      const file = join(dir, 'release-host.env');
      writeFileSync(file, '# comment\nPAPERCUSP_RELEASE_HOST=https://file.example.invalid/x\nPAPERCUSP_UPDATE_BASE_URL=https://file.example.invalid/x\n');
      const silent: NodeJS.ProcessEnv = {};
      loadReleaseHost(silent, file);
      expect(silent).toEqual({ PAPERCUSP_UPDATE_BASE_URL: 'https://file.example.invalid/x' });
      const exported: NodeJS.ProcessEnv = { PAPERCUSP_UPDATE_BASE_URL: 'https://env.example.invalid/y' };
      loadReleaseHost(exported, file);
      expect(releasesPageUrl(exported)).toBe('https://env.example.invalid/y/index.html');
      const none: NodeJS.ProcessEnv = {};
      loadReleaseHost(none, join(dir, 'missing.env'));
      expect(() => releasesPageUrl(none)).toThrow(/unset/);
      expect(() => releasesPageUrl({ PAPERCUSP_UPDATE_BASE_URL: 'http://plain.example.invalid' })).toThrow(/not an https URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
