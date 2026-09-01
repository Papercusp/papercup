import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePlaywrightBrowsers,
  expectedBrowserRevision,
  hasBrowserInstall,
  missingPlaywrightBrowsers,
} from './ensure-playwright-browsers.mjs';

const chromiumRevision = expectedBrowserRevision('chromium');
const headlessShellRevision = expectedBrowserRevision('chromium-headless-shell');
const ffmpegRevision = expectedBrowserRevision('ffmpeg');

test('detects an installed browser by its completion sentinel', () => {
  const cache = mkdtempSync(join(tmpdir(), 'pw-cache-'));
  mkdirSync(join(cache, 'chromium-999'), { recursive: true });
  writeFileSync(join(cache, 'chromium-999', 'INSTALLATION_COMPLETE'), '');
  assert.equal(hasBrowserInstall(cache, 'chromium'), true);
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
