import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

it('keeps installed setup out of the sticky header and leaves Connect clickable after dismissal', async () => {
  // Bundle the actual launcher, Button, Modal and Radix portal. Identity is a
  // fixture here; this regression measures browser layout and pointer routing.
  const result = await build({
    absWorkingDir: resolve(import.meta.dirname, '../..'),
    stdin: { contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { InstalledComputerLauncher } from './cloud-workspaces/InstalledComputerLauncher';
      createRoot(document.getElementById('root')).render(<>
        <header className="topbar"><InstalledComputerLauncher /></header>
        <main><button onClick={() => document.body.dataset.connected = 'true'}>Connect</button></main>
      </>);`, resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { '@/app': resolve(import.meta.dirname, '..') },
    loader: { '.css': 'empty' },
    plugins: [{ name: 'fixture-identity', setup(plugin) {
      plugin.onResolve({ filter: /^\.\/installed-computer-connection$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const installedBrowserKey = async () => ({ publicKey: { toString: () => btoa('b'.repeat(32)) } });
        export const installedComputerPrincipal = async () => ({ userId:'user', organizationId:'org', workspaceId:'workspace' });
        export const readInstalledComputerApproval = () => null;
        export const saveInstalledComputerApproval = () => {};` }));
    } }],
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [600, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      await page.setContent(`<style>body{margin:0}.topbar{position:sticky;top:0;z-index:15;background:white;padding:9px 16px}main{padding:16px}</style><div id="root"></div>`);
      await page.addStyleTag({ content: readFileSync(resolve(import.meta.dirname, '../harness/Modal.css'), 'utf8') });
      await page.addScriptTag({ content: result.outputFiles![0].text });
      const header = page.locator('.topbar');
      const before = await header.boundingBox();
      await page.getByRole('button', { name: 'Connect your computer', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Connect your computer', exact: true });
      await dialog.waitFor();
      expect(await dialog.evaluate(node => node.closest('.topbar') === null)).toBe(true);
      expect((await header.boundingBox())!.height).toBe(before!.height);
      await dialog.getByRole('button', { name: 'Close connection setup', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      expect(await page.locator('body').getAttribute('data-connected')).toBe('true');
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);
