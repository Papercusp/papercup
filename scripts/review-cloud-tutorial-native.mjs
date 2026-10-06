#!/usr/bin/env node
// Manual R12 review uses the maintained Playwright pause seam, not a second
// browser fixture. Readiness failures must occur before the reviewer starts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
export const sources = [
  'apps/operator/app/cloud-workspaces/ConfigureStage.tsx',
  'apps/operator/app/cloud-workspaces/ConnectStage.tsx',
  'apps/operator/app/cloud-workspaces/HostedWorkspaceSession.tsx',
  'apps/operator/lib/onboarding/cloud-tutorial-adapter.tsx',
  'apps/operator/lib/onboarding/cloud-tutorial-assistance.tsx',
  'apps/operator/lib/onboarding/cloud-tutorial-guide.tsx',
  'apps/operator/lib/onboarding/cloud-tutorial-session.tsx',
];

export function checked(command, args, { run = spawnSync, env = process.env } = {}) {
  const r = run(command, args, { env, encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) {
    throw new Error(`${command} readiness failed: ${r.error?.message || r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  return r.stdout.trim();
}

export function speechReady(options) {
  // --spawn returning 1 can mean an already-running, healthy shared daemon.
  // Query SSIP instead; never restart/kill that daemon or accept an exit alone.
  const output = checked('/usr/bin/python3', ['-c',
    "import json,speechd; c=speechd.SSIPClient('cloud-tutorial-readiness'); modules=c.list_output_modules(); c.close(); print(json.dumps(list(modules)))",
  ], options);
  const modules = JSON.parse(output);
  if (!Array.isArray(modules) || !modules.length || modules.some(x => typeof x !== 'string')) {
    throw new Error('Speech Dispatcher has no usable output module');
  }
  return modules;
}

export function verifySources(root, sourceRoot, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length !== sources.length ||
      new Set(manifest.files.map(f => f.path)).size !== sources.length ||
      sources.some(p => !manifest.files.some(f => f.path === p))) {
    throw new Error('R12 manifest must name exactly the seven reviewed components');
  }
  const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  for (const f of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || digest(join(root, f.path)) !== f.sha256 ||
        digest(join(sourceRoot, f.path)) !== f.sha256) throw new Error(`R12 source drift: ${f.path}`);
  }
  const test = 'apps/operator/e2e/cloud-tutorial.spec.ts';
  if (digest(join(root, test)) !== digest(join(sourceRoot, test))) throw new Error('Native pause fixture source drift');
}

export function browserReady(root) {
  const require = createRequire(join(root, 'apps/operator/package.json'));
  const executable = require('playwright').chromium.executablePath();
  if (!existsSync(executable)) throw new Error(`Missing installed Chromium: ${executable}; run ensure:playwright-browsers first`);
  return executable;
}

async function desktop(root, out) {
  checked('xdpyinfo', []);
  checked('gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress']);
  checked('/usr/bin/python3', ['-c', "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; d=Atspi.get_desktop(0); assert d is not None; print(d.get_child_count())"]);
  const modules = speechReady();
  const children = [];
  const launch = (command, args, suffix) => {
    const fd = openSync(`${out}-${suffix}.log`, 'wx');
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', fd, fd] });
    closeSync(fd); children.push(child);
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    return child;
  };
  const stop = () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM'); };
  process.on('SIGTERM', () => { stop(); process.exitCode = 143; });
  process.on('SIGINT', () => { stop(); process.exitCode = 130; });
  try {
    const wm = launch('openbox', [], 'openbox');
    const reader = launch('orca', ['--enable', 'speech', '--debug', '--debug-file', `${out}-speech.log`], 'orca');
    await new Promise(r => setTimeout(r, 1000));
    if (!wm.pid || !reader.pid || wm.exitCode !== null || reader.exitCode !== null) throw new Error('Native window manager or Orca exited before review');
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    const port = server.address().port;
    await new Promise(r => server.close(r));
    const env = { ...process.env, OPERATOR_E2E_PORT: String(port), PAPERCUSP_TUTORIAL_ORCA_REVIEW: '1', PWDEBUG: '1',
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_TEST_RUN_GROUP: `cloud-tutorial-native-${port}` };
    writeFileSync(`${out}.json`, JSON.stringify({ root, port, modules, display: env.DISPLAY,
      dbus: env.DBUS_SESSION_BUS_ADDRESS, xauthority: env.XAUTHORITY, orcaPid: reader.pid, windowPid: wm.pid,
      head: checked('git', ['-C', root, 'rev-parse', 'HEAD']), observedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    console.log(`NATIVE_REVIEW_READY ${out}.json`);
    const review = spawn('npm', ['run', 'test:e2e', '--', 'e2e/cloud-tutorial.spec.ts', '--headed', '--workers=1', '--grep', 'beginner reviews'], {
      cwd: join(root, 'apps/operator'), env, stdio: 'inherit',
    });
    children.push(review);
    process.exitCode = await new Promise((ok, fail) => { review.once('error', fail); review.once('exit', (code, signal) => ok(code ?? (signal ? 143 : 1))); });
  } finally { stop(); }
}

async function main() {
  const args = process.argv.slice(2);
  const get = key => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error(`Required ${key}`); return resolve(args[i + 1]); };
  const root = get('--root'), sourceRoot = get('--source-root'), manifestPath = get('--manifest'), out = get('--out');
  verifySources(root, sourceRoot, JSON.parse(readFileSync(manifestPath, 'utf8')));
  browserReady(root);
  speechReady();
  console.log('NATIVE_PREFLIGHT_READY source=seven-components browser=installed ssip=ready');
  if (args.includes('--check')) return;
  if (args.includes('--desktop')) return desktop(root, out);
  if (existsSync(`${out}.json`)) throw new Error('Review output already exists; choose a fresh prefix');
  const child = spawn(join(root, 'scripts/pc-heavy.sh'), ['--', 'xvfb-run', '-a', '-s', '-screen 0 1920x1080x24',
    'dbus-run-session', process.execPath, script, ...args, '--desktop'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NO_AT_BRIDGE: '0', GTK_MODULES: 'gail:atk-bridge', QT_ACCESSIBILITY: '1' },
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.exitCode = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', (code, signal) => ok(code ?? (signal ? 143 : 1))); });
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch(error => { console.error(`NATIVE_PREFLIGHT_FAILED ${error.message}`); process.exitCode = 1; });
}
