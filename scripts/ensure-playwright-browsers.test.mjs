import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePlaywrightBrowsers,
  expectedBrowserRevision,
  hasBrowserInstall,
  missingPlaywrightBrowsers,
  preparePlaywrightTempDirectory,
} from './ensure-playwright-browsers.mjs';
import { perGroupVitestEnv } from './test-files.mjs';

const chromiumRevision = expectedBrowserRevision('chromium');
const headlessShellRevision = expectedBrowserRevision('chromium-headless-shell');
const ffmpegRevision = expectedBrowserRevision('ffmpeg');

test('test-file workers use the maintained browser cache when XDG is session-private', () => {
  const home = join(tmpdir(), 'pw-home');
  const xdg = join(home, '.cache', 'papercusp-fleet-sandbox', 'run', 'xdg');
  const testEnv = perGroupVitestEnv({ HOME: home, XDG_CACHE_HOME: xdg }, 0, 1);
  assert.equal(testEnv.PLAYWRIGHT_BROWSERS_PATH, join(home, '.cache', 'ms-playwright'));
  assert.equal(testEnv.XDG_CACHE_HOME, xdg);
});

test('test-file workers preserve explicit Playwright browser cache overrides', () => {
  const home = '/home/papercusp';
  const xdg = '/tmp/papercusp-fleet-sandbox/run/xdg';
  for (const configured of ['/custom/browser-cache', '0']) {
    const testEnv = perGroupVitestEnv({ HOME: home, XDG_CACHE_HOME: xdg, PLAYWRIGHT_BROWSERS_PATH: configured }, 0, 1);
    assert.equal(testEnv.PLAYWRIGHT_BROWSERS_PATH, configured);
  }
});

test('detects an installed browser by its completion sentinel', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, 'chromium-999'), { recursive: true });
  writeFileSync(join(cache, 'chromium-999', 'INSTALLATION_COMPLETE'), '');
  assert.equal(hasBrowserInstall(cache, 'chromium'), true);
});

test('offloaded exact-revision cache symlinks are ready without reinstalling', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-offloaded-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = join(directory, 'cache');
  const offload = join(directory, 'offload');
  mkdirSync(cache); mkdirSync(offload);
  for (const name of [`chromium-${chromiumRevision}`, `chromium_headless_shell-${headlessShellRevision}`, `ffmpeg-${ffmpegRevision}`]) {
    const target = join(offload, name); mkdirSync(target);
    writeFileSync(join(target, 'INSTALLATION_COMPLETE'), '');
    symlinkSync(target, join(cache, name), 'dir');
  }
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  assert.deepEqual(missingPlaywrightBrowsers({ env }), []);
  assert.equal(ensurePlaywrightBrowsers({ env, run: () => { throw new Error('valid offloaded browsers must not reinstall'); } }).ranInstall, false);
});

test('offloaded cache still rejects stale revisions, incomplete targets and dangling links', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-incomplete-links-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'offload'); mkdirSync(target);
  writeFileSync(join(target, 'INSTALLATION_COMPLETE'), '');
  const cache = join(directory, 'cache'); mkdirSync(cache);
  symlinkSync(target, join(cache, 'chromium-stale'), 'dir');
  symlinkSync(join(directory, 'absent'), join(cache, `chromium-${chromiumRevision}`), 'dir');
  const incomplete = join(directory, 'incomplete'); mkdirSync(incomplete);
  symlinkSync(incomplete, join(cache, `ffmpeg-${ffmpegRevision}`), 'dir');
  assert.equal(hasBrowserInstall(cache, 'chromium', chromiumRevision), false);
  assert.equal(hasBrowserInstall(cache, 'ffmpeg', ffmpegRevision), false);
  assert.equal(hasBrowserInstall(cache, 'chromium'), true, 'generic discovery can still find the stale completed install');
});

test('isolated missing cache runs injected installer without network', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  const env = {
    ...process.env,
    HOME: cache,
    PLAYWRIGHT_BROWSERS_PATH: cache,
    PLAYWRIGHT_INSTALL_COMMAND: `node -e "const fs=require('fs'); for (const dir of ['chromium-${chromiumRevision}','chromium_headless_shell-${headlessShellRevision}','ffmpeg-${ffmpegRevision}']) { fs.mkdirSync('${cache}/'+dir,{recursive:true}); fs.writeFileSync('${cache}/'+dir+'/INSTALLATION_COMPLETE','') }"`,
  };
  const result = ensurePlaywrightBrowsers({ env });
  assert.equal(result.ranInstall, true);
  assert.equal(hasBrowserInstall(cache, 'chromium'), true);
});

test('ready cache is idempotent and does not invoke installer', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  for (const dir of [
    `chromium-${chromiumRevision}`,
    `chromium_headless_shell-${headlessShellRevision}`,
    `ffmpeg-${ffmpegRevision}`,
  ]) {
    mkdirSync(join(cache, dir), { recursive: true });
    writeFileSync(join(cache, dir, 'INSTALLATION_COMPLETE'), '');
  }
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  const result = ensurePlaywrightBrowsers({ env, run: () => { throw new Error('installer should not run'); } });
  assert.equal(result.ranInstall, false);
});

test('chromium without its headless shell is not a healthy Playwright install', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, `chromium-${chromiumRevision}`), { recursive: true });
  writeFileSync(join(cache, `chromium-${chromiumRevision}`, 'INSTALLATION_COMPLETE'), '');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  assert.deepEqual(missingPlaywrightBrowsers({ env }), [
    'chromium-headless-shell',
    'ffmpeg',
  ]);
});

test('stale browser revision fails the installed-registry health check', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, 'chromium-stale'), { recursive: true });
  writeFileSync(join(cache, 'chromium-stale', 'INSTALLATION_COMPLETE'), '');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
  assert.deepEqual(missingPlaywrightBrowsers({ env }), [
    'chromium',
    'chromium-headless-shell',
    'ffmpeg',
  ]);
});

const healthyStats = { bsize: 4096, bavail: 1024 * 1024, files: 10000, ffree: 9000 };

test('low temporary disk headroom selects the healthy cache volume for parent and browser', () => {
  const env = { TMPDIR: '/nearly-full', HOME: '/healthy-home' };
  const made = [];
  const result = preparePlaywrightTempDirectory({
    env,
    mkdir: (path, options) => made.push({ path, options }),
    access: () => {},
    statfs: path => path === '/nearly-full' ? { ...healthyStats, bavail: 12 } : healthyStats,
  });
  assert.equal(result.path, '/healthy-home/.cache/papercusp/playwright-tmp');
  assert.equal(result.usedFallback, true);
  assert.deepEqual([env.TMPDIR, env.TMP, env.TEMP], [result.path, result.path, result.path]);
  assert.deepEqual(made, [{ path: result.path, options: { recursive: true, mode: 0o700 } }]);
});

test('healthy explicit TMPDIR is preserved without creating a fallback directory', () => {
  const env = { TMPDIR: '/healthy-explicit', XDG_CACHE_HOME: '/unused-cache' };
  const result = preparePlaywrightTempDirectory({ env, statfs: () => healthyStats, access: () => {}, mkdir: () => { throw new Error('unexpected fallback'); } });
  assert.equal(result.path, '/healthy-explicit');
  assert.equal(result.usedFallback, false);
});

test('inode exhaustion and unwritable preferred paths also select measured fallback', () => {
  for (const reason of ['inodes', 'permission']) {
    const env = { TMPDIR: '/bad', XDG_CACHE_HOME: '/xdg' };
    const result = preparePlaywrightTempDirectory({
      env, mkdir: () => {},
      access: path => { if (reason === 'permission' && path === '/bad') throw new Error('EACCES'); },
      statfs: path => path === '/bad' ? { ...healthyStats, ffree: 0 } : healthyStats,
    });
    assert.equal(result.path, '/xdg/papercusp/playwright-tmp');
  }
});

test('no healthy volume fails before browser launch and preserves the caller environment', () => {
  const env = { TMPDIR: '/full', HOME: '/also-full' };
  assert.throws(() => preparePlaywrightTempDirectory({
    env, mkdir: () => {}, access: () => {}, statfs: () => ({ ...healthyStats, bavail: 0 }),
  }), /No writable Playwright temporary directory.*\/full.*\/also-full/);
  assert.deepEqual(env, { TMPDIR: '/full', HOME: '/also-full' });
});
