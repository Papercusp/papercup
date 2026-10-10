#!/usr/bin/env node
// Manual R12 review uses the maintained Playwright pause seam, not a second
// browser fixture. Readiness failures must occur before the reviewer starts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join, dirname, sep } from 'node:path';
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
export const productSources = [
  'packages/operator-core/lib/onboarding/product-tutorial-lesson.ts',
  'packages/operator-ui/src/onboarding/product-tutorial.tsx',
  'packages/operator-ui/src/browser-telemetry.tsx',
];
export const productPortalSources = [
  'packages/ui/src/shell.tsx',
  'packages/ui/src/auth.tsx',
  'packages/ui/src/shell-model.ts',
  'app/tokens.css',
  'app/globals.css',
  'playwright.config.ts',
  'e2e/portal-product-tutorial.spec.ts',
];

// The desktop child runs in the retained checkout. Resolve paths while they
// still belong to the caller's directory, including manifests outside it.
export function resolveReviewArgs(args, cwd = process.cwd()) {
  const resolved = [...args];
  for (const key of ['--root', '--source-root', '--manifest', '--out', '--portal-root', '--portal-source-root']) {
    const i = resolved.indexOf(key);
    if (i < 0) continue;
    if (!resolved[i + 1] || resolved[i + 1].startsWith('--')) throw new Error(`Required ${key}`);
    resolved[i + 1] = resolve(cwd, resolved[i + 1]);
  }
  return resolved;
}

export function reviewCommand({ profile = 'cloud', root, portalRoot }) {
  if (profile === 'cloud') return { cwd: join(root, 'apps/operator'),
    args: ['run', 'test:e2e', '--', 'e2e/cloud-tutorial.spec.ts', '--headed', '--workers=1', '--grep', 'beginner reviews'] };
  if (profile !== 'product-guide') throw new Error(`Unknown native review profile: ${profile}`);
  if (!portalRoot) throw new Error('Product guide review requires --portal-root');
  return { cwd: portalRoot,
    args: ['run', 'test:e2e:browser', '--', 'e2e/portal-product-tutorial.spec.ts', '--headed', '--workers=1',
      '--grep', 'guide precedes portal destination and persists reload with workspace=null$'] };
}

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

function verifyFileSet(root, sourceRoot, files, expected, label) {
  if (!root || !sourceRoot) throw new Error(`${label} review requires both immutable and current source roots`);
  if (!Array.isArray(files) || files.length !== expected.length ||
      new Set(files.map(f => f.path)).size !== expected.length ||
      expected.some(p => !files.some(f => f.path === p))) {
    throw new Error(`${label} manifest must name exactly the ${expected.length} reviewed components`);
  }
  const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  for (const f of files) {
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || digest(join(root, f.path)) !== f.sha256 ||
        digest(join(sourceRoot, f.path)) !== f.sha256) throw new Error(`${label} source drift: ${f.path}`);
  }
}

export function verifySources(root, sourceRoot, manifest, { profile = 'cloud', portalRoot, portalSourceRoot } = {}) {
  if (profile === 'product-guide') {
    verifyFileSet(root, sourceRoot, manifest.files, productSources, 'Product guide');
    verifyFileSet(portalRoot, portalSourceRoot, manifest.portalFiles, productPortalSources, 'Product Portal');
    return;
  }
  if (profile !== 'cloud') throw new Error(`Unknown native review profile: ${profile}`);
  verifyFileSet(root, sourceRoot, manifest.files, sources, 'R12');
  const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  const test = 'apps/operator/e2e/cloud-tutorial.spec.ts';
  if (digest(join(root, test)) !== digest(join(sourceRoot, test))) throw new Error('Native pause fixture source drift');
}

export function browserReady(root) {
  const require = createRequire(join(root, 'apps/operator/package.json'));
  const executable = require('playwright').chromium.executablePath();
  if (!existsSync(executable)) throw new Error(`Missing installed Chromium: ${executable}; run ensure:playwright-browsers first`);
  return executable;
}

/** Check consumed package exports and relative imports, even when live bytes match. */
export function verifyProductImports(root, portalRoot) {
  const portalRequire = createRequire(join(portalRoot, 'packages/ui/package.json'));
  const guide = portalRequire.resolve('@papercusp/operator-ui/onboarding');
  const guideRequire = createRequire(guide);
  const imports = [
    [guide, productSources[1]],
    [portalRequire.resolve('@papercusp/operator-core/lib/onboarding/product-tutorial-lesson'), productSources[0]],
    [guideRequire.resolve('@papercusp/operator-core/lib/onboarding/product-tutorial-lesson'), productSources[0]],
    [portalRequire.resolve('@papercusp/operator-ui/browser-telemetry'), productSources[2]],
    [join(dirname(guide), '../browser-telemetry.tsx'), productSources[2]],
  ];
  const immutableRoot = realpathSync(root);
  for (const [loaded, expected] of imports) {
    const pinned = realpathSync(join(root, expected));
    if (!pinned.startsWith(immutableRoot + sep) || realpathSync(loaded) !== pinned) {
      throw new Error(`Product guide imported source escapes immutable root: ${expected} -> ${realpathSync(loaded)}`);
    }
  }
  return imports.map(([loaded]) => realpathSync(loaded));
}

async function desktop(root, out, review, profile) {
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
      ...(profile === 'product-guide' ? { PORTAL_TUTORIAL_ORCA_REVIEW: '1', PORTAL_BROWSER_CHANNEL: 'chrome' } : {}),
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_TEST_RUN_GROUP: `cloud-tutorial-native-${port}` };
    // Pause/resume remounts the guide with Help collapsed. A reviewer must
    // reopen it before searching AT-SPI for optional output controls.
    const reviewInstructions = profile === 'product-guide' ? [
      'After pause/resume, reopen Help with this lesson before inspecting speech controls.',
      'Verify Help is expanded and Spoken lesson guidance is present before using Speak lesson, Stop speech, Mute, or Replay.',
      'Missing controls in collapsed Help are an unmet review precondition; record them as not exercised.',
      'This mounted fixture does not prove hosted provider audio, protected input, or production acceptance.',
    ] : [];
    writeFileSync(`${out}.json`, JSON.stringify({ root, profile, review, reviewInstructions, port, modules, display: env.DISPLAY,
      dbus: env.DBUS_SESSION_BUS_ADDRESS, xauthority: env.XAUTHORITY, orcaPid: reader.pid, windowPid: wm.pid,
      head: checked('git', ['-C', root, 'rev-parse', 'HEAD']), observedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    console.log(`NATIVE_REVIEW_READY ${out}.json`);
    for (const instruction of reviewInstructions) console.log(`NATIVE_REVIEW_INSTRUCTION ${instruction}`);
    const journey = spawn('npm', review.args, {
      cwd: review.cwd, env, stdio: 'inherit',
    });
    children.push(journey);
    process.exitCode = await new Promise((ok, fail) => { journey.once('error', fail); journey.once('exit', (code, signal) => ok(code ?? (signal ? 143 : 1))); });
  } finally { stop(); }
}

async function main() {
  const args = resolveReviewArgs(process.argv.slice(2));
  const get = key => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error(`Required ${key}`); return resolve(args[i + 1]); };
  const root = get('--root'), sourceRoot = get('--source-root'), manifestPath = get('--manifest'), out = get('--out');
  const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'cloud';
  const options = { profile, ...(profile === 'product-guide'
    ? { portalRoot: get('--portal-root'), portalSourceRoot: get('--portal-source-root') } : {}) };
  const review = reviewCommand({ root, ...options });
  verifySources(root, sourceRoot, JSON.parse(readFileSync(manifestPath, 'utf8')), options);
  if (profile === 'product-guide') {
    verifyProductImports(root, options.portalRoot);
    if (!['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].some(existsSync))
      throw new Error('Missing system Chrome required by the Portal browser review');
  } else browserReady(root);
  speechReady();
  console.log(`NATIVE_PREFLIGHT_READY profile=${profile} source=verified browser=installed ssip=ready`);
  if (args.includes('--check')) return;
  if (args.includes('--desktop')) return desktop(root, out, review, profile);
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
