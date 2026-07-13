import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVerifier } from './index.js';
import { findScreen, findScreenByRoute, SCREENS } from './screens.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Tauri verification surface', () => {
  it('never silently chooses among live desktops', async () => {
    const verifier = createVerifier();
    expect(verifier.config()).toEqual({ timeout: 10_000 });
    await expect(verifier.route('/adv')).resolves.toMatchObject({
      ok: false,
      code: 'target_required',
    });
  });

  it('uses an explicit authenticated bridge target and the webview origin for health', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          title: 'Papercusp',
          readyState: 'complete',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete',
          rootMounted: true,
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          pathname: '/adv',
          search: '?tab=learning',
          hash: '',
          origin: 'http://127.0.0.1:3170',
        }),
      }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady();
    expect(result).toMatchObject({
      ok: true,
      value: {
        bridgeConnected: true,
        webviewLoaded: true,
        apiHealthy: true,
        routerReady: true,
        route: { pathname: '/adv', search: '?tab=learning' },
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      new URL('http://127.0.0.1:3170/api/health'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const bridgeBody = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(bridgeBody).toMatchObject({ token: 'secret' });
    expect(bridgeBody.js).toContain('document.readyState');
  });

  it('fails app-ready when the target API is unhealthy instead of reporting a false green', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({ href: 'http://127.0.0.1:3170/adv', title: 'Papercusp', readyState: 'complete' }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete', rootMounted: true, href: 'http://127.0.0.1:3170/adv',
          pathname: '/adv', search: '', hash: '', origin: 'http://127.0.0.1:3170',
        }),
      }))
      .mockResolvedValueOnce(json({ error: 'down' }, 503));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady()).resolves.toMatchObject({
      ok: false,
      code: 'api_unhealthy',
    });
  });

  it('rejects a mounted route error boundary instead of reporting a false app-ready green', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv', title: 'Papercusp', readyState: 'complete',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          readyState: 'complete', rootMounted: true, href: 'http://127.0.0.1:3170/adv',
          pathname: '/adv', search: '', hash: '', origin: 'http://127.0.0.1:3170',
          routeError: 'This view hit an error',
        }),
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).appReady()).resolves.toMatchObject({
      ok: false,
      code: 'route_error_boundary',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asserts a semantic screen using its route, query, and live selectors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        result: JSON.stringify({
          href: 'http://127.0.0.1:3170/adv?tab=learning',
          pathname: '/adv', search: '?tab=learning', hash: '',
        }),
      }))
      .mockResolvedValueOnce(json({
        result: JSON.stringify([
          { selector: '.pc-advshell', present: true },
          { selector: '.pc-advshell__tab--learning[data-state="active"]', present: true },
        ]),
      }));
    vi.stubGlobal('fetch', fetch);

    await expect(createVerifier({ bridgePort: 4444, bridgeToken: 'secret' }).screen('learning')).resolves.toMatchObject({
      ok: true,
      value: { id: 'learning', href: '/adv?tab=learning' },
    });
  });

  describe('semantic screen registry', () => {
    it('uses real shell selectors and concrete navigation destinations', () => {
      expect(SCREENS.ONBOARDING.requiredElements).toContain('.pc-onboarding-shell');
      expect(SCREENS.ADVANCED.requiredElements).toContain('.pc-advshell');
      expect(SCREENS.SETTINGS.requiredElements).toContain('.pc-settings-shell');
      expect(SCREENS.ADMIN.requiredElements).toContain('.pc-adminshell');
      expect(Object.values(SCREENS).every((screen) => screen.href.startsWith('/'))).toBe(true);
    });

    it('chooses a query-specific screen before the generic /adv surface', () => {
      expect(findScreenByRoute('/adv?tab=learning')?.id).toBe('learning');
      expect(findScreenByRoute('/adv?tab=harnesses')?.id).toBe('working');
      expect(findScreenByRoute('/adv')?.id).toBe('advanced');
    });

    it('finds screens by stable ID', () => {
      expect(findScreen('onboarding')?.name).toBe('Onboarding Console');
      expect(findScreen('unknown-screen')).toBeUndefined();
    });
  });
});
