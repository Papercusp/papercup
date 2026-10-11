import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildMirror,
  importSpecifiers,
  readCommittedPackage,
  selfContainmentProblems,
  writeMirror,
} from './plugin-mirror-export.mjs';

const file = (path, text) => ({ path, content: Buffer.from(text) });
const manifest = (extra = {}) =>
  file('papercusp.json', JSON.stringify({ name: 'demo', version: '0.1.0', kind: 'plugin', license: 'MIT', ...extra }));

test('importSpecifiers finds static, re-export, dynamic and require forms', () => {
  const src = [
    "import a from './a.mjs';",
    "import { b } from 'node:fs';",
    "import './side-effect.mjs';",
    "export { c } from '../escape.mjs';",
    "const d = await import('ws');",
    "const e = require('@scope/pkg/sub');",
  ].join('\n');
  assert.deepEqual(
    importSpecifiers(src).sort(),
    ['../escape.mjs', './a.mjs', './side-effect.mjs', '@scope/pkg/sub', 'node:fs', 'ws'].sort(),
  );
});

test('self-containment: in-package relative and builtin imports pass; escapes and undeclared bare imports fail', () => {
  const ok = [file('provider.mjs', "import './lib/x.mjs'; import 'node:crypto'; import 'fs';"), file('lib/x.mjs', "import '../provider.mjs';")];
  assert.deepEqual(selfContainmentProblems(ok), []);

  const escaping = [file('lib/x.mjs', "import '../../outside.mjs';")];
  assert.match(selfContainmentProblems(escaping)[0], /escapes the package directory/);

  const absolute = [file('x.mjs', "import '/etc/thing.mjs';")];
  assert.match(selfContainmentProblems(absolute)[0], /escapes the package directory/);

  const undeclared = [file('x.mjs', "import WebSocket from 'ws';")];
  assert.match(selfContainmentProblems(undeclared)[0], /not declared in package\.json/);

  const declared = [
    file('x.mjs', "import WebSocket from 'ws'; const s = require('@scope/pkg/sub');"),
    file('package.json', JSON.stringify({ dependencies: { ws: '^8' }, peerDependencies: { '@scope/pkg': '*' } })),
  ];
  assert.deepEqual(selfContainmentProblems(declared), []);

  // Non-code files are not scanned, so prose that mentions an import cannot refuse a package.
  assert.deepEqual(selfContainmentProblems([file('README.md', "import x from '../../nope';")]), []);
});

test('buildMirror generates an MIT LICENSE only when the package has none', () => {
  const built = buildMirror([manifest(), file('provider.mjs', "import 'node:fs';")], { year: 2026 });
  assert.equal(built.ok, true);
  const license = built.files.find((f) => f.path === 'LICENSE');
  assert.ok(license, 'LICENSE generated');
  assert.match(license.content.toString(), /^MIT License\n\nCopyright \(c\) 2026 Papercusp/);

  const own = buildMirror([manifest(), file('LICENSE', 'custom terms')]);
  assert.equal(own.ok, true);
  assert.equal(own.files.filter((f) => f.path === 'LICENSE').length, 1);
  assert.equal(own.files.find((f) => f.path === 'LICENSE').content.toString(), 'custom terms');
});

test('buildMirror refuses what the Cupboard or a standalone checkout could not use', () => {
  assert.match(buildMirror([manifest({ license: 'Apache-2.0' })]).problems.join('\n'), /MIT only/);
  assert.match(buildMirror([manifest({ version: '' })]).problems.join('\n'), /non-empty name and version/);
  assert.match(buildMirror([file('provider.mjs', '')]).problems.join('\n'), /papercusp\.json is missing/);
  assert.match(buildMirror([file('papercusp.json', '{not json')]).problems.join('\n'), /does not parse/);
  assert.match(buildMirror([manifest(), file('x.mjs', "import '../../a.mjs';")]).problems.join('\n'), /escapes/);
});

test('readCommittedPackage exports committed content only: uncommitted edits and untracked files never reach the mirror', () => {
  const repo = mkdtempSync(join(tmpdir(), 'plugin-mirror-export-'));
  const out = mkdtempSync(join(tmpdir(), 'plugin-mirror-out-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(repo, 'plugins', 'demo', 'lib'), { recursive: true });
    mkdirSync(join(repo, 'plugins', 'other'), { recursive: true });
    writeFileSync(join(repo, 'plugins', 'demo', 'papercusp.json'), manifest().content);
    writeFileSync(join(repo, 'plugins', 'demo', 'lib', 'x.mjs'), 'export const committed = true;\n');
    writeFileSync(join(repo, 'plugins', 'other', 'papercusp.json'), '{}');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'fixture');

    // Working-tree drift after the commit must not leak into the export.
    writeFileSync(join(repo, 'plugins', 'demo', 'lib', 'x.mjs'), 'export const committed = false;\n');
    writeFileSync(join(repo, 'plugins', 'demo', 'untracked.mjs'), 'secret\n');

    const files = readCommittedPackage({ pluginsRepo: repo, name: 'demo' });
    assert.deepEqual(files.map((f) => f.path).sort(), ['lib/x.mjs', 'papercusp.json']);
    assert.equal(files.find((f) => f.path === 'lib/x.mjs').content.toString(), 'export const committed = true;\n');

    const built = buildMirror(files, { year: 2026 });
    assert.equal(built.ok, true);
    mkdirSync(join(out, '.git'));
    writeFileSync(join(out, '.git', 'HEAD'), 'keep');
    writeFileSync(join(out, 'stale.txt'), 'removed by re-export');
    writeMirror(out, built.files);
    assert.deepEqual(readdirSync(out).sort(), ['.git', 'LICENSE', 'lib', 'papercusp.json']);
    assert.equal(readFileSync(join(out, '.git', 'HEAD'), 'utf8'), 'keep');

    assert.throws(() => readCommittedPackage({ pluginsRepo: repo, name: 'missing' }), /no committed files/);
    assert.throws(() => readCommittedPackage({ pluginsRepo: repo, name: '../escape' }), /invalid package name/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the first-party slack and bug-triage packages export as standalone mirrors', () => {
  for (const name of ['slack', 'bug-triage']) {
    const files = readCommittedPackage({ name });
    assert.ok(files.some((f) => f.path === 'papercusp.json'), `${name}: manifest at the package root`);
    const built = buildMirror(files);
    assert.deepEqual(built.problems ?? [], [], `${name}: exportable`);
    assert.ok(built.files.some((f) => f.path === 'LICENSE'), `${name}: carries a LICENSE`);
  }
});
