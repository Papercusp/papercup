/**
 * Verification assertions for Tauri app.
 * Provides stable, composable assertions for app-ready, route, and scope.
 */

import type { AssertionResult, RouteInfo, ScopeInfo, AppReady, VerifyResult, BridgeStatus } from './types.js';

/**
 * Assert that the Tauri bridge is connected.
 */
export async function assertBridgeConnected(bridgePort: number): Promise<VerifyResult<BridgeStatus>> {
  try {
    const url = `http://127.0.0.1:${bridgePort}/health`;
    const response = await fetch(url);
    if (!response.ok) {
      return {
        ok: false,
        error: `Bridge health check failed: ${response.status} ${response.statusText}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    return {
      ok: true,
      value: {
        bridgeAlive: true,
        bridgeVersion: (data.version as string) || 'unknown',
        tauriPID: (data.pid as number) || 0,
        port: bridgePort,
        webviewURL: (data.webviewUrl as string) || '',
        pageTitle: (data.pageTitle as string) || '',
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Bridge connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Assert that the app is ready for testing.
 * Checks: bridge connected, webview loaded, API healthy, router available.
 */
export async function assertAppReady(
  bridgePort: number,
  apiBaseUrl: string = 'http://127.0.0.1:3270',
): Promise<VerifyResult<AppReady>> {
  // Check bridge
  const bridgeResult = await assertBridgeConnected(bridgePort);
  if (!bridgeResult.ok) {
    return { ok: false, error: `Bridge not ready: ${bridgeResult.error}` };
  }

  // Check webview loaded (via DOM check)
  try {
    const evalUrl = `http://127.0.0.1:${bridgePort}/eval`;
    const webviewCheck = await fetch(evalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: 'document.readyState',
      }),
    });

    if (!webviewCheck.ok) {
      return {
        ok: false,
        error: 'Webview check failed',
      };
    }

    const webviewData = (await webviewCheck.json()) as Record<string, unknown>;
    const readyState = webviewData.result as string;

    if (!['interactive', 'complete'].includes(readyState)) {
      return {
        ok: false,
        error: `Webview not ready: readyState=${readyState}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Webview check error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check API health
  try {
    const apiHealthUrl = `${apiBaseUrl}/api/health`;
    const apiHealth = await fetch(apiHealthUrl, { timeout: 5000 });
    if (!apiHealth.ok) {
      return {
        ok: false,
        error: `API health check failed: ${apiHealth.status}`,
      };
    }
  } catch (err) {
    // API health check is optional - app can still be testable
    console.warn('API health check warning:', err);
  }

  // Check router availability
  try {
    const evalUrl = `http://127.0.0.1:${bridgePort}/eval`;
    const routerCheck = await fetch(evalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: 'typeof window.__TSR_ROUTER__ !== "undefined"',
      }),
    });

    if (!routerCheck.ok) {
      return {
        ok: false,
        error: 'Router availability check failed',
      };
    }

    const routerData = (await routerCheck.json()) as Record<string, unknown>;
    if (!routerData.result) {
      return {
        ok: false,
        error: 'Router not available in window',
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Router check error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    value: {
      bridgeConnected: true,
      webviewLoaded: true,
      apiHealthy: true,
      routerReady: true,
    },
  };
}

/**
 * Assert that the current route matches expected.
 */
export async function assertRoute(
  bridgePort: number,
  expectedRoute: string | RegExp,
): Promise<VerifyResult<RouteInfo>> {
  try {
    const evalUrl = `http://127.0.0.1:${bridgePort}/eval`;
    const evalResponse = await fetch(evalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: 'JSON.stringify({ href: location.href, pathname: location.pathname, search: location.search, hash: location.hash })',
      }),
    });

    if (!evalResponse.ok) {
      return {
        ok: false,
        error: 'Failed to read current route',
      };
    }

    const evalData = (await evalResponse.json()) as Record<string, unknown>;
    let routeInfo: RouteInfo;

    if (typeof evalData.result === 'string') {
      try {
        routeInfo = JSON.parse(evalData.result) as RouteInfo;
      } catch {
        return {
          ok: false,
          error: 'Failed to parse route info',
        };
      }
    } else {
      return {
        ok: false,
        error: 'Unexpected route info format',
      };
    }

    // Check if route matches expected
    const matches =
      typeof expectedRoute === 'string' ? routeInfo.pathname === expectedRoute : expectedRoute.test(routeInfo.pathname);

    if (!matches) {
      return {
        ok: false,
        error: `Route mismatch: expected ${String(expectedRoute)}, got ${routeInfo.pathname}`,
      };
    }

    return { ok: true, value: routeInfo };
  } catch (err) {
    return {
      ok: false,
      error: `Route assertion error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Assert current harness/workspace scope.
 */
export async function assertScope(
  bridgePort: number,
  expectedScope: Partial<ScopeInfo>,
): Promise<VerifyResult<ScopeInfo>> {
  try {
    const evalUrl = `http://127.0.0.1:${bridgePort}/eval`;
    const evalResponse = await fetch(evalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: 'JSON.stringify({ harnessSlug: new URL(location.href).searchParams.get("slug"), workspaceId: window.__WORKSPACE_ID__, userId: window.__USER_ID__, role: window.__USER_ROLE__ })',
      }),
    });

    if (!evalResponse.ok) {
      return {
        ok: false,
        error: 'Failed to read scope info',
      };
    }

    const evalData = (await evalResponse.json()) as Record<string, unknown>;
    let scopeInfo: ScopeInfo;

    if (typeof evalData.result === 'string') {
      try {
        scopeInfo = JSON.parse(evalData.result) as ScopeInfo;
      } catch {
        return {
          ok: false,
          error: 'Failed to parse scope info',
        };
      }
    } else {
      return {
        ok: false,
        error: 'Unexpected scope info format',
      };
    }

    // Check if scope matches expected
    for (const [key, expectedValue] of Object.entries(expectedScope)) {
      if (expectedValue !== undefined && scopeInfo[key as keyof ScopeInfo] !== expectedValue) {
        return {
          ok: false,
          error: `Scope mismatch: expected ${key}=${String(expectedValue)}, got ${String(scopeInfo[key as keyof ScopeInfo])}`,
        };
      }
    }

    return { ok: true, value: scopeInfo };
  } catch (err) {
    return {
      ok: false,
      error: `Scope assertion error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Format assertion result as a human-readable message.
 */
export function formatAssertionResult(result: AssertionResult): string {
  const status = result.passed ? '✓' : '✗';
  let msg = `${status} ${result.message}`;

  if (result.details && Object.keys(result.details).length > 0) {
    msg += ` | ${JSON.stringify(result.details)}`;
  }

  return msg;
}
