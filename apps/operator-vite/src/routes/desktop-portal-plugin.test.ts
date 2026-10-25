import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPortalPlugin } from '../../desktop-portal-plugin';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hook = (plugin: object, name: string) => (plugin as Record<string, Function>)[name];
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true }); });

function source() {
  const portalRoot = mkdtempSync(resolve(tmpdir(), 'desktop-portal-plugin-'));
  temporary.push(portalRoot);
  const files: Record<string, string> = {
    'packages/ui/package.json': JSON.stringify({ name: '@portal/ui', exports: { '.': './src/index.tsx' } }),
    'packages/ui/src/index.tsx': 'export { PortalEntry } from "./shell";',
    'packages/ui/src/shell.tsx': 'export function PortalEntry() { return null; }',
    'packages/contracts/package.json': JSON.stringify({ name: '@portal/contracts', exports: { '.': './src/index.ts' } }),
    'packages/contracts/src/index.ts': 'export const PORTAL_APP_KINDS = [];',
    'app/tokens.css': ':root { --portal-gap: 1rem; }', 'app/globals.css': '.portal { display: grid; }',
    'apps/host/shims/native.ts': 'throw new Error("web-only native shim");',
    'apps/host/src/operator-surface-build.mjs': 'export function operatorSurfaceShims(desktop, portal) { return [{ pattern: /^@tauri-apps\\/api/, replacement: portal + "/apps/host/shims/native.ts" }]; }',
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(portalRoot, path)), { recursive: true });
    writeFileSync(resolve(portalRoot, path), body);
  }
  return portalRoot;
}

async function candidate(out?: string) {
  const output = out ?? resolve(root, '.papercusp/private-desktop-candidates/plugin-test');
  return desktopPortalPlugin({ papercuspRoot: root, env: {
    PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', PAPERCUSP_DESKTOP_PORTAL_ROOT: source(),
    PAPERCUSP_VITE_OUT_DIR: output,
  } });
}

describe('desktop interface build selection', () => {
  it('keeps ordinary builds legacy without reading or requiring any portal checkout', async () => {
    const plugin = await desktopPortalPlugin({ papercuspRoot: root, env: {} });
    expect(hook(plugin, 'config')().define.__PAPERCUSP_DESKTOP_PORTAL__).toBe('false');
    const id = hook(plugin, 'resolveId')('virtual:desktop-portal-entry');
    expect(hook(plugin, 'load')(id)).not.toContain('@portal/ui');
    expect(hook(plugin, 'resolveId')('@tauri-apps/api/core')).toBeUndefined();
    expect(hook(plugin, 'configResolved')({ root, build: { outDir: 'dist' } })).toBeUndefined();
    expect(hook(plugin, 'transformIndexHtml')('<meta name="papercusp-desktop-interface" content="legacy" />'))
      .toContain('content="legacy"');
  });

  it('refuses unknown selections and an absent explicit source before building', async () => {
    await expect(desktopPortalPlugin({ papercuspRoot: root,
      env: { PAPERCUSP_DESKTOP_INTERFACE: 'unexpected' } })).rejects.toThrow('Unknown desktop interface');
    await expect(desktopPortalPlugin({ papercuspRoot: root,
      env: { PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate' } })).rejects.toThrow('Explicit absolute');
  });

  it('loads the measured local UI and styles with real native bindings and desktop singleton modules', async () => {
    const plugin = await candidate();
    expect(hook(plugin, 'config')().define.__PAPERCUSP_DESKTOP_PORTAL__).toBe('true');
    const entry = hook(plugin, 'load')(hook(plugin, 'resolveId')('virtual:desktop-portal-entry'));
    expect(entry).toContain('app/tokens.css');
    expect(entry).toContain('app/globals.css');
    expect(entry).toContain('export { PortalEntry as default }');
    expect(hook(plugin, 'resolveId')('@portal/ui')).toContain('packages/ui/src/index.tsx');
    expect(hook(plugin, 'resolveId')('@tauri-apps/api/core')).toMatch(/@tauri-apps\/api\/core\.(c?js)$/);
    expect(hook(plugin, 'resolveId')('react')).toContain('/node_modules/react/');
    expect(hook(plugin, 'transformIndexHtml')('<meta name="papercusp-desktop-interface" content="legacy" />'))
      .toContain('content="portal-candidate"');
  });

  it('refuses ordinary or mismatched output paths and allows only the explicitly selected private directory', async () => {
    const plugin = await candidate();
    const configure = (outDir: string) => hook(plugin, 'configResolved')({ root, build: { outDir } });
    expect(() => configure('apps/operator-vite/dist')).toThrow('private-desktop-candidates');
    expect(() => configure('.papercusp/private-desktop-candidates/other')).toThrow('private-desktop-candidates');
    expect(() => configure('.papercusp/private-desktop-candidates/plugin-test')).not.toThrow();
    const ordinary = await candidate(resolve(root, 'apps/operator-vite/dist'));
    expect(() => hook(ordinary, 'configResolved')({ root, build: { outDir: 'apps/operator-vite/dist' } }))
      .toThrow('private-desktop-candidates');
  });

  it('refuses a symlinked private output rather than writing into its destination', async () => {
    const link = resolve(root, '.papercusp/private-desktop-candidates/plugin-symlink-test');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(source(), link);
    temporary.push(link);
    const plugin = await candidate(resolve(link, 'out'));
    expect(() => hook(plugin, 'configResolved')({ root, build: { outDir: resolve(link, 'out') } }))
      .toThrow('cannot traverse symlinks');
  });
});
