import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, NO_VITE_CLIENT_BODY, shouldServeNoopViteClient, shouldSuppressJsReload } from '../../../operator-vite/dev-mode';

describe('operator-vite desktop no-HMR mode', () => {
  it('disables HMR by default', () => {
    expect(isDesktopHmrEnabled({})).toBe(false);
    expect(isDesktopHmrEnabled({ PAPERCUSP_ENABLE_HMR: '0', NEXT_PUBLIC_ENABLE_HMR: '0' })).toBe(false);
  });

  it('enables HMR only through explicit env opt-in', () => {
    expect(isDesktopHmrEnabled({ PAPERCUSP_ENABLE_HMR: '1' })).toBe(true);
    expect(isDesktopHmrEnabled({ NEXT_PUBLIC_ENABLE_HMR: '1' })).toBe(true);
  });

  it('serves a no-op Vite client only when HMR is disabled', () => {
    expect(shouldServeNoopViteClient('/@vite/client', false)).toBe(true);
    expect(shouldServeNoopViteClient('/src/main.tsx', false)).toBe(false);
    expect(shouldServeNoopViteClient('/@vite/client', true)).toBe(false);
    expect(NO_VITE_CLIENT_BODY).toContain('Vite client disabled');
  });
  it('suppresses JS reloads on static desktop hosts only', () => {
    expect(shouldSuppressJsReload('http://localhost:3070')).toBe(true);
    expect(shouldSuppressJsReload('http://127.0.0.1:3070')).toBe(true);
    expect(shouldSuppressJsReload('http://localhost:4173')).toBe(true);
    expect(shouldSuppressJsReload('http://localhost:3055')).toBe(false);
  });

  it('keeps desktop dev defaulting to the no-HMR script', () => {
    const root = resolve(__dirname, '../../../..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const desktopPkg = JSON.parse(readFileSync(resolve(root, '../papercusp-desktop/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['dev:operator']).toBe('npm --workspace @papercusp/operator-vite run dev:nohmr');
    expect(pkg.scripts?.['dev:operator:hmr']).toBe('npm --workspace @papercusp/operator-vite run dev');
    expect(pkg.scripts?.['dev:operator:nohmr']).toBe('npm --workspace @papercusp/operator-vite run dev:nohmr');
    expect(desktopPkg.scripts?.dev).toBe('bin/desktop-dev-nohmr');
    expect(desktopPkg.scripts?.['dev:nohmr']).toBe('bin/desktop-dev-nohmr');
    expect(desktopPkg.scripts?.['dev:preview']).toBe('bin/desktop-preview-prod');
    expect(desktopPkg.scripts?.['dev:hmr']).toBe('tauri dev');
  });
});
