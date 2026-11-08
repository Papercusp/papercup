import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

test('native surface screenshots always declare a target or use the owned-window adapter', () => {
  for (const file of readdirSync(new URL('.', import.meta.url)).filter(name => /^tauri-surface-verify-.*\.sh$/.test(name))) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\\\n\s*/g, ' ');
    for (const line of source.split('\n').filter(line => /^\s*(?:"\$\w+"|native) screenshot\s/.test(line))) {
      assert.match(line, /--(?:selector|title|window-id)\s/, `${file}: screenshot needs an explicit capture target`);
    }
    if (/^\s*capture_screenshot /m.test(source)) {
      assert.match(source, /source "\$\{OPERATOR_SOURCE_ROOT:\?[^}]+\}\/scripts\/lib\/verify-tauri-screenshot\.sh"/,
        `${file}: capture adapter must come from the verifier's owned source`);
    }
  }
});

// Run the maintained assertion script against a CLI fixture. It evaluates the
// actual return predicate with nuqs' default query omitted, and rejects capture
// of the larger foreign window. This is harness coverage, not native acceptance.
for (const query of ['', '?evalView=launch']) {
  test(`cloud/Evaluation assertion accepts the disabled default Launch controls (${query || 'no query'})`, () => {
    runCloudEval(query, false, 0);
  });
}
test('cloud/Evaluation assertion still rejects an enabled unregistered launch', () => {
  runCloudEval('', true, 1);
});

function runCloudEval(query, launchEnabled, expectedStatus) {
  const dir = mkdtempSync(join(tmpdir(), 'native-surface-output-'));
  try {
    const cli = join(dir, 'native-cli');
    writeFileSync(cli, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
if (args[0] === 'list-windows') {
  console.log(JSON.stringify([
    { windowId: '901', pid: 456, tauri: true, width: 3000, height: 2000 },
    { windowId: '902', pid: 123, tauri: true, width: 1280, height: 800 },
  ]));
} else if (args[0] === 'screenshot') {
  if (value('--window-id') !== '902') process.exit(9);
  writeFileSync(value('--output'), Buffer.from('89504e470d0a1a0a', 'hex'));
} else if (args[0] === 'check') {
  if (args.includes('.pc-does-not-exist-sentinel')) process.exit(1);
  const expression = args.includes('--eval') ? value('--eval') : '';
  let passed = true;
  if (expression.includes("get('evalView')") && expression.includes("'launch'")) {
    passed = runInNewContext(expression, { URLSearchParams,
      location: { search: process.env.NATIVE_RETURN_QUERY },
      document: { querySelector: selector => selector.includes('Benchmark arm') ? {}
        : selector.includes('Launch benchmark run') ? { disabled: process.env.NATIVE_LAUNCH_ENABLED !== '1' } : null },
    });
  }
  console.log(JSON.stringify({ passed }));
  if (!passed) process.exit(1);
} else if (!['navigate', 'wait', 'eval'].includes(args[0])) process.exit(99);
`, { mode: 0o700 });
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const result = spawnSync('bash', [join(root, 'scripts/tauri-surface-verify-p005-cloud-eval.sh')], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OPERATOR_SOURCE_ROOT: root,
        VERIFY_TAURI_PID: '123', VERIFY_TAURI_AGENT_TOOLS_BIN: cli, PAPERCUSP_VERIFY_TAURI_ISOLATED: '1',
        TAURI_SURFACE_VERIFY_P005_OUT: dir, NATIVE_RETURN_QUERY: query, NATIVE_LAUNCH_ENABLED: launchEnabled ? '1' : '0' },
    });
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'eval-launch-return-check.json'))).passed, !launchEnabled);
    for (const image of ['cloud-workspaces.png', 'eval-viz.png']) {
      assert.equal(readFileSync(join(dir, image)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    if (expectedStatus === 0) assert.match(result.stdout, /P005_TAURI_SURFACE_VERIFY_OK/);
    else assert.match(result.stderr, /P005_FAIL eval-viz: returning to Launch failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
